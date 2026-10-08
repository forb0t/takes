//! A version as a ZIP archive, e.g. a release to send to a label.

use std::fs::{self, File};
use std::io::{self, BufWriter};
use std::path::Path;

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipWriter};

use super::Repo;
use crate::error::{Error, Result};

impl Repo {
    /// Writes the files of version `rev` into a ZIP at `dest`, inside a
    /// folder named like the archive. Files are stored as they are: audio
    /// and other media do not compress further, so this is as fast as a
    /// copy. Returns the number of files.
    pub fn export_zip(&self, rev: &str, dest: &Path) -> Result<u64> {
        let id = self.resolve(rev)?;
        let snapshot = self.snapshot(id)?;
        let tree = self.tree(id)?;
        let pruned = self.pruned()?;
        if let Some((path, _)) = tree.iter().find(|(_, e)| pruned.contains(&e.blob)) {
            return Err(Error::ContentPruned(path.clone()));
        }
        let folder = dest
            .file_stem()
            .map_or_else(|| "export".into(), |s| s.to_string_lossy().into_owned());
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .last_modified_time(zip_time(snapshot.created_at));
        let _lock = self.lock_shared()?;
        let tmp = dest.with_extension("zip.partial");
        let written = (|| -> Result<()> {
            let mut zip = ZipWriter::new(BufWriter::new(File::create(&tmp)?));
            for (path, entry) in &tree {
                let options = options.large_file(entry.size >= u64::from(u32::MAX));
                zip.start_file(format!("{folder}/{path}"), options)
                    .map_err(zip_error)?;
                self.store.write_blob(&self.blob(entry.blob)?, &mut zip)?;
            }
            let out = zip.finish().map_err(zip_error)?;
            out.into_inner().map_err(|e| e.into_error())?.sync_all()?;
            Ok(())
        })();
        if written.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        written?;
        fs::rename(&tmp, dest)?;
        Ok(tree.len() as u64)
    }
}

fn zip_error(e: zip::result::ZipError) -> Error {
    match e {
        zip::result::ZipError::Io(e) => e.into(),
        e => io::Error::other(e).into(),
    }
}

/// ZIP timestamps are calendar fields; versions keep unix seconds (UTC).
fn zip_time(unix: i64) -> DateTime {
    let days = unix.div_euclid(86_400);
    let secs = unix.rem_euclid(86_400);
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    DateTime::from_date_and_time(
        u16::try_from(year).unwrap_or(0),
        month as u8,
        day as u8,
        (secs / 3600) as u8,
        (secs % 3600 / 60) as u8,
        (secs % 60) as u8,
    )
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zip_times() {
        let t = zip_time(951_782_400); // 2000-02-29 00:00:00 UTC
        assert_eq!((t.year(), t.month(), t.day()), (2000, 2, 29));
        let t = zip_time(1_791_460_980); // 2026-10-08 12:03:00 UTC
        assert_eq!(
            (t.year(), t.month(), t.day(), t.hour(), t.minute()),
            (2026, 10, 8, 12, 3)
        );
        // Before 1980 ZIP has no way to say it.
        assert_eq!(zip_time(0), DateTime::default());
    }
}
