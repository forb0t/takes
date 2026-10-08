use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use fastcdc::v2020::StreamCDC;

use crate::error::{Error, Result};
use crate::hash::Hash;

// Content-defined chunk sizes. Large on purpose: media files are big, and
// fewer chunks keep the per-blob chunk list and the object count small.
pub const MIN_CHUNK: usize = 256 * 1024;
pub const AVG_CHUNK: usize = 1024 * 1024;
pub const MAX_CHUNK: usize = 4 * 1024 * 1024;

const RAW: u8 = 0;
const ZSTD: u8 = 1;
const ZSTD_LEVEL: i32 = 3;

/// A file's content: its hash plus the ordered chunks it is made of.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Blob {
    pub hash: Hash,
    pub size: u64,
    pub chunks: Vec<Hash>,
}

pub fn chunks_to_bytes(chunks: &[Hash]) -> Vec<u8> {
    chunks.iter().flat_map(|h| h.0).collect()
}

pub fn chunks_from_bytes(bytes: &[u8]) -> Result<Vec<Hash>> {
    let (hashes, rest) = bytes.as_chunks::<32>();
    if !rest.is_empty() {
        return Err(Error::Corrupt("malformed chunk list".into()));
    }
    Ok(hashes.iter().map(|h| Hash(*h)).collect())
}

/// Chunks on disk at `objects/<2 hex>/<62 hex>`, each a one-byte encoding tag
/// followed by the (possibly zstd-compressed) data.
pub struct ObjectStore {
    dir: PathBuf,
}

impl ObjectStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn chunk_path(&self, hash: &Hash) -> PathBuf {
        let hex = hash.to_hex();
        self.dir.join(&hex[..2]).join(&hex[2..])
    }

    pub fn put_chunk(&self, data: &[u8]) -> Result<Hash> {
        let hash = Hash::of(data);
        let path = self.chunk_path(&hash);
        if path.exists() {
            return Ok(hash);
        }
        // Already-compressed media (mp3, flac, jpeg) does not shrink; keep it raw.
        let compressed = zstd::bulk::compress(data, ZSTD_LEVEL)?;
        let (tag, payload) = if compressed.len() < data.len() {
            (ZSTD, compressed.as_slice())
        } else {
            (RAW, data)
        };
        let parent = path.parent().expect("chunk path has a parent");
        fs::create_dir_all(parent)?;
        let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
        tmp.write_all(&[tag])?;
        tmp.write_all(payload)?;
        // The database will reference this chunk right after; make sure it
        // survives a power loss before that happens.
        tmp.as_file().sync_all()?;
        tmp.persist(&path).map_err(|e| e.error)?;
        Ok(hash)
    }

    pub fn get_chunk(&self, hash: &Hash) -> Result<Vec<u8>> {
        decode(hash, &self.read_raw(hash)?)
    }

    pub fn has_chunk(&self, hash: &Hash) -> bool {
        self.chunk_path(hash).exists()
    }

    /// A chunk as stored (encoding tag + payload): what packs carry.
    pub fn read_raw(&self, hash: &Hash) -> Result<Vec<u8>> {
        fs::read(self.chunk_path(hash)).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => Error::Corrupt(format!("missing chunk {hash}")),
            _ => e.into(),
        })
    }

    pub fn raw_len(&self, hash: &Hash) -> Result<u64> {
        Ok(fs::metadata(self.chunk_path(hash))?.len())
    }

    /// Stores a chunk received in stored form, after checking that it really
    /// decodes to `hash` (remote data is never trusted blindly).
    pub fn put_raw(&self, hash: &Hash, raw: &[u8]) -> Result<()> {
        decode(hash, raw)?;
        let path = self.chunk_path(hash);
        if path.exists() {
            return Ok(());
        }
        let parent = path.parent().expect("chunk path has a parent");
        fs::create_dir_all(parent)?;
        let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
        tmp.write_all(raw)?;
        tmp.as_file().sync_all()?;
        tmp.persist(&path).map_err(|e| e.error)?;
        Ok(())
    }

    /// Splits a file into chunks, stores the ones not already present.
    pub fn put_file(&self, path: &Path) -> Result<Blob> {
        let file = File::open(path)?;
        let mut hasher = blake3::Hasher::new();
        let mut chunks = Vec::new();
        let mut size = 0;
        for chunk in StreamCDC::new(file, MIN_CHUNK, AVG_CHUNK, MAX_CHUNK) {
            let chunk = chunk.map_err(io::Error::from)?;
            hasher.update(&chunk.data);
            size += chunk.length as u64;
            chunks.push(self.put_chunk(&chunk.data)?);
        }
        Ok(Blob {
            hash: hasher.finalize().into(),
            size,
            chunks,
        })
    }

    pub fn write_blob(&self, blob: &Blob, out: &mut impl Write) -> Result<()> {
        let mut hasher = blake3::Hasher::new();
        for chunk in &blob.chunks {
            let data = self.get_chunk(chunk)?;
            hasher.update(&data);
            out.write_all(&data)?;
        }
        if Hash::from(hasher.finalize()) != blob.hash {
            return Err(Error::Corrupt(format!(
                "content {} does not match its hash",
                blob.hash
            )));
        }
        Ok(())
    }

    /// Number of stored chunks and the bytes they take on disk.
    pub fn usage(&self) -> Result<(u64, u64)> {
        let (mut count, mut bytes) = (0, 0);
        for bucket in fs::read_dir(&self.dir)? {
            let bucket = bucket?;
            if !bucket.file_type()?.is_dir() {
                continue;
            }
            for chunk in fs::read_dir(bucket.path())? {
                let meta = chunk?.metadata()?;
                if meta.is_file() {
                    count += 1;
                    bytes += meta.len();
                }
            }
        }
        Ok((count, bytes))
    }
}

fn decode(hash: &Hash, raw: &[u8]) -> Result<Vec<u8>> {
    let data = match raw.split_first() {
        Some((&RAW, rest)) => rest.to_vec(),
        Some((&ZSTD, rest)) => zstd::decode_all(rest)?,
        _ => return Err(Error::Corrupt(format!("unknown encoding of chunk {hash}"))),
    };
    if Hash::of(&data) != *hash {
        return Err(Error::Corrupt(format!("chunk {hash} is damaged")));
    }
    Ok(data)
}

/// Content hash of a file without storing it.
pub fn hash_file(path: &Path) -> Result<(Hash, u64)> {
    let mut file = File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0; 1024 * 1024];
    let mut size = 0;
    loop {
        let n = match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.into()),
        };
        hasher.update(&buf[..n]);
        size += n as u64;
    }
    Ok((hasher.finalize().into(), size))
}
