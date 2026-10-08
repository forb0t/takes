//! Where a project's history is synced to: any storage that can list, read,
//! write and delete files. Sync never relies on more than that (no locking,
//! no transactions), which is what lets a plain folder in Google Drive or a
//! WebDAV share serve as a remote.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use ureq::http::{self, Method};

use crate::error::{Error, Result};

/// Where the remote lives, as stored in the project settings. Passwords are
/// never stored here; the caller supplies them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RemoteConfig {
    /// A folder: local, on a NAS, a USB drive or inside a Google Drive,
    /// Dropbox or Yandex Disk folder synced by its desktop app.
    Folder { path: String },
    /// A WebDAV share, e.g. Yandex Disk (`https://webdav.yandex.ru`) or
    /// Nextcloud. `folder` is the path of this project's folder on the server.
    #[serde(rename_all = "camelCase")]
    WebDav {
        url: String,
        folder: String,
        username: String,
    },
}

impl RemoteConfig {
    pub fn describe(&self) -> String {
        match self {
            RemoteConfig::Folder { path } => path.clone(),
            RemoteConfig::WebDav { url, folder, .. } => {
                format!("{}/{}", url.trim_end_matches('/'), folder.trim_matches('/'))
            }
        }
    }

    pub fn needs_password(&self) -> bool {
        matches!(self, RemoteConfig::WebDav { .. })
    }

    pub fn open(&self, password: Option<&str>) -> Result<Box<dyn Storage>> {
        Ok(match self {
            RemoteConfig::Folder { path } => Box::new(FolderStorage::new(path)),
            RemoteConfig::WebDav {
                url,
                folder,
                username,
            } => Box::new(WebDavStorage::new(
                url,
                folder,
                username,
                password.unwrap_or_default(),
            )?),
        })
    }
}

/// Minimal file storage. Paths are relative, `/`-separated and ASCII.
/// Sync calls it from several threads at once.
pub trait Storage: Send + Sync {
    /// Names of the entries directly inside `dir` ("" = the root); empty if
    /// `dir` does not exist.
    fn list(&self, dir: &str) -> Result<Vec<String>>;
    fn read(&self, path: &str) -> Result<Option<Vec<u8>>>;
    fn read_range(&self, path: &str, offset: u64, len: u64) -> Result<Vec<u8>>;
    /// Creates or replaces a file; readers never see a partial file.
    fn write(&self, path: &str, data: &[u8]) -> Result<()>;
    fn write_file(&self, path: &str, local: &Path) -> Result<()>;
    /// Removes a file; fine if it does not exist.
    fn delete(&self, path: &str) -> Result<()>;
}

/// Requests in flight at once: remote calls mostly wait on the network (one
/// small file per version or comment), and servers dislike big bursts.
const PARALLEL: usize = 6;

/// Runs `work` on every item using a few threads and returns the results in
/// order. `each` sees every result on the calling thread as it arrives (for
/// progress and database writes, which must stay on one thread). Stops at
/// the first error.
pub(crate) fn parallel<T: Send, R: Send>(
    items: Vec<T>,
    work: impl Fn(T) -> Result<R> + Sync,
    mut each: impl FnMut(&R) -> Result<()>,
) -> Result<Vec<R>> {
    let total = items.len();
    if total <= 1 {
        return items
            .into_iter()
            .map(|item| {
                let result = work(item)?;
                each(&result)?;
                Ok(result)
            })
            .collect();
    }
    let queue = Mutex::new(items.into_iter().enumerate());
    let stop = std::sync::atomic::AtomicBool::new(false);
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        for _ in 0..PARALLEL.min(total) {
            let (tx, queue, stop, work) = (tx.clone(), &queue, &stop, &work);
            scope.spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    let next = queue.lock().unwrap_or_else(|e| e.into_inner()).next();
                    let Some((i, item)) = next else { break };
                    let result = work(item);
                    if result.is_err() {
                        stop.store(true, Ordering::Relaxed);
                    }
                    if tx.send((i, result)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(tx);
        let mut results: Vec<Option<R>> = (0..total).map(|_| None).collect();
        let mut failure = None;
        for (i, result) in rx {
            match result.and_then(|r| each(&r).map(|()| r)) {
                Ok(r) => results[i] = Some(r),
                Err(e) => {
                    stop.store(true, Ordering::Relaxed);
                    failure.get_or_insert(e);
                }
            }
        }
        match failure {
            Some(e) => Err(e),
            None => Ok(results
                .into_iter()
                .map(|r| r.expect("every item ran"))
                .collect()),
        }
    })
}

// ---- folder -------------------------------------------------------------------

pub struct FolderStorage {
    root: PathBuf,
}

impl FolderStorage {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn path(&self, rel: &str) -> PathBuf {
        rel.split('/')
            .filter(|p| !p.is_empty())
            .fold(self.root.clone(), |p, s| p.join(s))
    }

    /// Write via a hidden temp file and rename, so cloud clients and readers
    /// never pick up half a file.
    fn replace(&self, rel: &str, fill: impl FnOnce(&mut File) -> io::Result<()>) -> Result<()> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let target = self.path(rel);
        let parent = target.parent().expect("remote paths have a parent");
        fs::create_dir_all(parent).map_err(|e| unavailable(&self.root, e))?;
        let name = target
            .file_name()
            .expect("remote paths name a file")
            .to_string_lossy();
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let tmp = parent.join(format!(".{name}.{}.{n}.tmp", std::process::id()));
        let result = (|| {
            let mut file = File::create(&tmp)?;
            fill(&mut file)?;
            file.sync_all()?;
            fs::rename(&tmp, &target)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result.map_err(|e| unavailable(&self.root, e))
    }
}

fn unavailable(root: &Path, e: io::Error) -> Error {
    Error::Remote(format!("{}: {e}", root.display()))
}

impl Storage for FolderStorage {
    fn list(&self, dir: &str) -> Result<Vec<String>> {
        let entries = match fs::read_dir(self.path(dir)) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(unavailable(&self.root, e)),
        };
        let mut names = Vec::new();
        for entry in entries {
            let name = entry.map_err(|e| unavailable(&self.root, e))?.file_name();
            let name = name.to_string_lossy();
            // Temp files of ours or of cloud clients.
            if !name.starts_with('.') {
                names.push(name.into_owned());
            }
        }
        Ok(names)
    }

    fn read(&self, path: &str) -> Result<Option<Vec<u8>>> {
        match fs::read(self.path(path)) {
            Ok(data) => Ok(Some(data)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(unavailable(&self.root, e)),
        }
    }

    fn read_range(&self, path: &str, offset: u64, len: u64) -> Result<Vec<u8>> {
        let read = || -> io::Result<Vec<u8>> {
            let mut file = File::open(self.path(path))?;
            file.seek(SeekFrom::Start(offset))?;
            let mut buf = vec![0; len as usize];
            file.read_exact(&mut buf)?;
            Ok(buf)
        };
        read().map_err(|e| unavailable(&self.root, e))
    }

    fn write(&self, path: &str, data: &[u8]) -> Result<()> {
        self.replace(path, |f| f.write_all(data))
    }

    fn write_file(&self, path: &str, local: &Path) -> Result<()> {
        self.replace(path, |f| io::copy(&mut File::open(local)?, f).map(|_| ()))
    }

    fn delete(&self, path: &str) -> Result<()> {
        match fs::remove_file(self.path(path)) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(unavailable(&self.root, e)),
            _ => Ok(()),
        }
    }
}

// ---- WebDAV -------------------------------------------------------------------

const PROPFIND: &str = r#"<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>"#;

pub struct WebDavStorage {
    /// `https://host[:port]` plus any base path the user gave, no trailing `/`.
    server: String,
    /// Path segments of the project folder under `server`.
    prefix: Vec<String>,
    auth: String,
    agent: ureq::Agent,
    /// Collections known to exist, to skip repeated MKCOLs.
    made: Mutex<HashSet<String>>,
}

impl WebDavStorage {
    pub fn new(url: &str, folder: &str, username: &str, password: &str) -> Result<Self> {
        let server = url.trim().trim_end_matches('/').to_owned();
        if !(server.starts_with("https://") || server.starts_with("http://")) {
            return Err(Error::Remote(format!("not a WebDAV address: {url}")));
        }
        let prefix = folder
            .split('/')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .allow_non_standard_methods(true)
            .timeout_connect(Some(Duration::from_secs(20)))
            .build();
        Ok(Self {
            server,
            prefix,
            auth: format!(
                "Basic {}",
                base64(format!("{username}:{password}").as_bytes())
            ),
            agent: config.into(),
            made: Mutex::new(HashSet::new()),
        })
    }

    fn segments(&self, rel: &str) -> Vec<String> {
        let mut all = self.prefix.clone();
        all.extend(rel.split('/').filter(|s| !s.is_empty()).map(str::to_owned));
        all
    }

    fn url(&self, segments: &[String], collection: bool) -> String {
        let mut url = self.server.clone();
        for s in segments {
            url.push('/');
            url.push_str(&percent_encode(s));
        }
        if collection {
            url.push('/');
        }
        url
    }

    fn send(
        &self,
        method: &str,
        url: &str,
        headers: &[(&str, &str)],
        body: impl ureq::AsSendBody,
    ) -> Result<http::Response<ureq::Body>> {
        let mut request = http::Request::builder()
            .method(Method::from_bytes(method.as_bytes()).expect("valid method"))
            .uri(url)
            .header("Authorization", &self.auth);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let request = request
            .body(body)
            .map_err(|e| Error::Remote(e.to_string()))?;
        let response = self
            .agent
            .run(request)
            .map_err(|e| Error::Remote(format!("{}: {e}", self.server)))?;
        match response.status().as_u16() {
            401 | 403 => Err(Error::RemoteAuth),
            507 => Err(Error::Remote("the server is out of space".into())),
            _ => Ok(response),
        }
    }

    fn fail(&self, what: &str, path: &str, response: &http::Response<ureq::Body>) -> Error {
        Error::Remote(format!("{what} {path}: HTTP {}", response.status()))
    }

    /// Creates the collections leading to `segments` (MKCOL per level).
    fn ensure_collections(&self, segments: &[String]) -> Result<()> {
        // One at a time: parallel uploads into a new folder would all race
        // to create it, and some servers answer the losers with an error.
        let mut made = self.made.lock().unwrap_or_else(|e| e.into_inner());
        for depth in 1..=segments.len() {
            let url = self.url(&segments[..depth], true);
            if made.contains(&url) {
                continue;
            }
            let response = self.send("MKCOL", &url, &[], ())?;
            // 201 created; 405 already exists (some servers say 301 too).
            match response.status().as_u16() {
                200..=299 | 301 | 405 => {}
                // Another device may have just created it.
                _ if self.collection_exists(&url)? => {}
                _ => return Err(self.fail("cannot create folder", &url, &response)),
            }
            made.insert(url);
        }
        Ok(())
    }

    fn collection_exists(&self, url: &str) -> Result<bool> {
        let response = self.send(
            "PROPFIND",
            url,
            &[("Depth", "0"), ("Content-Type", "application/xml")],
            PROPFIND,
        )?;
        Ok(matches!(response.status().as_u16(), 200 | 207))
    }

    fn put(&self, path: &str, body: impl ureq::AsSendBody) -> Result<()> {
        let segments = self.segments(path);
        self.ensure_collections(&segments[..segments.len() - 1])?;
        let response = self.send("PUT", &self.url(&segments, false), &[], body)?;
        if !response.status().is_success() {
            return Err(self.fail("cannot upload", path, &response));
        }
        Ok(())
    }
}

impl Storage for WebDavStorage {
    fn list(&self, dir: &str) -> Result<Vec<String>> {
        let segments = self.segments(dir);
        let url = self.url(&segments, true);
        let response = self.send(
            "PROPFIND",
            &url,
            &[("Depth", "1"), ("Content-Type", "application/xml")],
            PROPFIND,
        )?;
        match response.status().as_u16() {
            404 => return Ok(Vec::new()),
            207 | 200 => {}
            _ => return Err(self.fail("cannot list", dir, &response)),
        }
        let xml = read_body(response)?;
        let xml = String::from_utf8_lossy(&xml);
        let mut names = Vec::new();
        for href in hrefs(&xml) {
            let path = percent_decode(href_path(&href));
            let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
            // Children are exactly one level below the listed folder; the
            // folder itself is in the response too and is skipped.
            if let Some(name) = parts.last()
                && parts.len() > segments.len()
                && parts[parts.len() - 1 - segments.len()..parts.len() - 1]
                    .iter()
                    .zip(&segments)
                    .all(|(a, b)| a == b)
                && !name.starts_with('.')
            {
                names.push((*name).to_owned());
            }
        }
        Ok(names)
    }

    fn read(&self, path: &str) -> Result<Option<Vec<u8>>> {
        let response = self.send("GET", &self.url(&self.segments(path), false), &[], ())?;
        match response.status().as_u16() {
            404 => Ok(None),
            200 => Ok(Some(read_body(response)?)),
            _ => Err(self.fail("cannot download", path, &response)),
        }
    }

    fn read_range(&self, path: &str, offset: u64, len: u64) -> Result<Vec<u8>> {
        let range = format!("bytes={}-{}", offset, offset + len - 1);
        let response = self.send(
            "GET",
            &self.url(&self.segments(path), false),
            &[("Range", &range)],
            (),
        )?;
        let status = response.status().as_u16();
        let data = match status {
            206 => read_body(response)?,
            // Server ignored the range: cut it out ourselves.
            200 => {
                let all = read_body(response)?;
                all.get(offset as usize..(offset + len) as usize)
                    .ok_or_else(|| Error::Remote(format!("{path} is shorter than expected")))?
                    .to_vec()
            }
            _ => return Err(self.fail("cannot download", path, &response)),
        };
        if data.len() as u64 != len {
            return Err(Error::Remote(format!("{path}: incomplete download")));
        }
        Ok(data)
    }

    fn write(&self, path: &str, data: &[u8]) -> Result<()> {
        self.put(path, data)
    }

    fn write_file(&self, path: &str, local: &Path) -> Result<()> {
        self.put(path, File::open(local)?)
    }

    fn delete(&self, path: &str) -> Result<()> {
        let response = self.send("DELETE", &self.url(&self.segments(path), false), &[], ())?;
        if response.status().is_success() || response.status().as_u16() == 404 {
            Ok(())
        } else {
            Err(self.fail("cannot delete", path, &response))
        }
    }
}

fn read_body(response: http::Response<ureq::Body>) -> Result<Vec<u8>> {
    response
        .into_body()
        .into_with_config()
        .limit(u64::MAX)
        .read_to_vec()
        .map_err(|e| Error::Remote(e.to_string()))
}

/// Contents of every `<…href>` element, whatever the namespace prefix.
fn hrefs(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(lt) = rest.find('<') {
        rest = &rest[lt + 1..];
        let Some(gt) = rest.find('>') else { break };
        let tag = &rest[..gt];
        let name = tag.split_whitespace().next().unwrap_or("");
        let local = name.rsplit(':').next().unwrap_or(name);
        if !name.starts_with('/') && local.eq_ignore_ascii_case("href") && !tag.ends_with('/') {
            let body = &rest[gt + 1..];
            let end = body.find('<').unwrap_or(body.len());
            out.push(xml_unescape(body[..end].trim()));
        }
        rest = &rest[gt + 1..];
    }
    out
}

/// `https://host/a/b` → `/a/b`; a plain path stays as is.
fn href_path(href: &str) -> &str {
    match href.find("://") {
        Some(i) => href[i + 3..].find('/').map_or("/", |j| &href[i + 3 + j..]),
        None => href,
    }
}

fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn percent_encode(segment: &str) -> String {
    let mut out = String::new();
    for b in segment.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(byte) = s
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | u32::from(*b) << (16 - 8 * i));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_propfind_responses_from_different_servers() {
        // Yandex Disk style: d: prefix, absolute paths, percent-encoded Cyrillic.
        let yandex = r#"<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:"><d:response><d:href>/Takes/%D0%90%D0%BB%D1%8C%D0%B1%D0%BE%D0%BC/packs/</d:href>
<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
<d:response><d:href>/Takes/%D0%90%D0%BB%D1%8C%D0%B1%D0%BE%D0%BC/packs/ab.idx</d:href></d:response>
<d:response><d:href>/Takes/%D0%90%D0%BB%D1%8C%D0%B1%D0%BE%D0%BC/packs/ab.pack</d:href></d:response></d:multistatus>"#;
        let paths: Vec<String> = hrefs(yandex)
            .iter()
            .map(|h| percent_decode(href_path(h)))
            .collect();
        assert_eq!(
            paths,
            [
                "/Takes/Альбом/packs/",
                "/Takes/Альбом/packs/ab.idx",
                "/Takes/Альбом/packs/ab.pack"
            ]
        );

        // Apache style: D: prefix, full URLs, entities.
        let apache = r#"<D:multistatus xmlns:D="DAV:"><D:response><D:href>http://nas.local/dav/a%20b/x&amp;y.snap</D:href></D:response></D:multistatus>"#;
        assert_eq!(
            percent_decode(href_path(&hrefs(apache)[0])),
            "/dav/a b/x&y.snap"
        );

        // No prefix, self-closing elements ignored.
        assert_eq!(
            hrefs("<multistatus><href/><href>/a</href></multistatus>"),
            ["/a"]
        );
    }

    #[test]
    fn encodings() {
        assert_eq!(
            percent_encode("Альбом 1"),
            "%D0%90%D0%BB%D1%8C%D0%B1%D0%BE%D0%BC%201"
        );
        assert_eq!(percent_decode("%D0%90%20b"), "А b");
        assert_eq!(base64(b"user:pass"), "dXNlcjpwYXNz");
        assert_eq!(base64(b"ab"), "YWI=");
        assert_eq!(base64(b"a"), "YQ==");
    }

    #[test]
    fn folder_storage_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let s = FolderStorage::new(dir.path().join("remote"));
        assert!(s.list("").unwrap().is_empty());
        assert_eq!(s.read("x/y").unwrap(), None);
        s.write("a/b.txt", b"hello world").unwrap();
        assert_eq!(s.list("a").unwrap(), ["b.txt"]);
        assert_eq!(s.read_range("a/b.txt", 6, 5).unwrap(), b"world");
        s.delete("a/b.txt").unwrap();
        s.delete("a/b.txt").unwrap();
        assert!(s.list("a").unwrap().is_empty());
    }
}
