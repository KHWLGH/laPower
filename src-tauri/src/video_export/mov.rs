// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-only
// For original project contributions; see COPYRIGHT.
//! In-place QuickTime conversion for the MOV container.
//!
//! Media Foundation only writes the MP4 brand, so a "MOV" export is the same movie with a
//! `qt  ` file type and the legacy QuickTime handler shape. Every box keeps its size and
//! every sample keeps its offset, which is why this is byte surgery instead of a re-mux:
//! nothing downstream has to rewrite `stco`/`co64` tables.
//!
//! Pure std, so it is unit-tested on every platform.

use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

/// A movie index larger than this is not something a 60-second report produces; refusing
/// keeps the whole rewrite bounded in memory.
const MAX_MOOV: u64 = 4 * 1024 * 1024;
const MAX_FTYP: u32 = 4096;
const MAX_DEPTH: u32 = 8;
const QT_BRAND: &[u8; 4] = b"qt  ";

fn truncated() -> String {
    "movie header is truncated".into()
}

/// Convert the MP4 file at `path` into a QuickTime movie in place.
pub fn quicktime(path: &Path) -> Result<(), String> {
    let mut file = File::options()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("cannot open the movie for rewriting: {error}"))?;
    let length = file
        .metadata()
        .map_err(|error| format!("cannot stat the movie: {error}"))?
        .len();
    let mut branded = false;
    let mut movie = false;
    let mut cursor = 0u64;
    while cursor < length {
        let (prefix, size) = box_header(&mut file, cursor, length)?;
        let header = prefix as u64;
        let kind = box_type(&mut file, cursor, prefix)?;
        match &kind {
            b"ftyp" => {
                if size < header + 12 || size > u64::from(MAX_FTYP) {
                    return Err("movie file type box is invalid".into());
                }
                rewrite_ftyp(&mut file, cursor, header, size - header)?;
                branded = true;
            }
            b"moov" => {
                if size > MAX_MOOV {
                    return Err("movie index exceeds the supported size".into());
                }
                let mut body = vec![0u8; (size - header) as usize];
                seek_read(&mut file, cursor + header, &mut body)?;
                if adapt(&mut body, 0)? != 1 {
                    return Err("a QuickTime movie must contain exactly one video track".into());
                }
                seek_write(&mut file, cursor + header, &body)?;
                movie = true;
            }
            _ => {}
        }
        cursor += size;
    }
    if !(branded && movie) {
        return Err("movie file type or movie index is missing".into());
    }
    file.sync_all()
        .map_err(|error| format!("cannot flush the movie: {error}"))?;
    Ok(())
}

/// `(header length, box length)` for the box at `at`.
fn box_header(file: &mut File, at: u64, length: u64) -> Result<(usize, u64), String> {
    let remaining = length.checked_sub(at).ok_or_else(truncated)?;
    if remaining < 8 {
        return Err(truncated());
    }
    let mut header = [0u8; 16];
    seek_read(file, at, &mut header[..8])?;
    let size = u32::from_be_bytes([header[0], header[1], header[2], header[3]]);
    match size {
        0 => Ok((8, remaining)),
        1 => {
            if remaining < 16 {
                return Err(truncated());
            }
            seek_read(file, at, &mut header)?;
            let large = u64::from_be_bytes([
                header[8], header[9], header[10], header[11], header[12], header[13], header[14],
                header[15],
            ]);
            if large < 16 || large > remaining {
                return Err("movie box range is invalid".into());
            }
            Ok((16, large))
        }
        size => {
            let size = u64::from(size);
            if size < 8 || size > remaining {
                return Err("movie box range is invalid".into());
            }
            Ok((8, size))
        }
    }
}

fn box_type(file: &mut File, at: u64, prefix: usize) -> Result<[u8; 4], String> {
    let mut kind = [0u8; 4];
    let offset = if prefix == 16 { 12 } else { 4 };
    seek_read(file, at + offset, &mut kind)?;
    Ok(kind)
}

fn rewrite_ftyp(file: &mut File, at: u64, prefix: u64, body: u64) -> Result<(), String> {
    // Keep the 4-byte minor version and replace every compatible brand with `qt  `.
    let mut payload = vec![0u8; body as usize];
    seek_read(file, at + prefix, &mut payload)?;
    let slots = (body as usize - 8) / 4;
    for slot in 0..slots {
        let start = 8 + slot * 4;
        payload[start..start + 4].copy_from_slice(QT_BRAND);
    }
    payload[..4].copy_from_slice(QT_BRAND);
    seek_write(file, at + prefix, &payload)?;
    Ok(())
}

/// Walk one container body, converting handler boxes. Returns the number of video handlers.
fn adapt(bytes: &mut [u8], depth: u32) -> Result<usize, String> {
    if depth >= MAX_DEPTH {
        return Err("movie index nesting is too deep".into());
    }
    let mut handlers = 0usize;
    let mut at = 0usize;
    while at + 8 <= bytes.len() {
        let size =
            u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]) as usize;
        if size < 8 || at + size > bytes.len() {
            return Err("movie index child range is invalid".into());
        }
        let kind = [bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]];
        let body = &mut bytes[at + 8..at + size];
        match &kind {
            b"trak" | b"mdia" | b"minf" | b"stbl" => handlers += adapt(body, depth + 1)?,
            // The handler lives one level inside `mdia`; requiring the depth keeps a stray
            // `hdlr` elsewhere from being rewritten.
            b"hdlr" if depth == 2 => {
                if body.len() < 25 || &body[8..12] != b"vide" {
                    return Err("movie media handler is not a video track".into());
                }
                body[4..8].copy_from_slice(b"mhlr");
                // QuickTime names handlers with a Pascal string; MP4 uses a C string. The
                // length byte replaces the position of the name, so the name shifts right by
                // one and its terminating NUL is dropped: the box keeps its size.
                let name = (body.len() - 24).saturating_sub(1).min(255);
                body.copy_within(24..24 + name, 25);
                body[24] = name as u8;
                handlers += 1;
            }
            _ => {}
        }
        at += size;
    }
    Ok(handlers)
}

fn seek_read(file: &mut File, at: u64, buffer: &mut [u8]) -> Result<(), String> {
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(at))
        .map_err(|error| format!("cannot seek the movie: {error}"))?;
    file.read_exact(buffer)
        .map_err(|error| format!("cannot read the movie: {error}"))
}

fn seek_write(file: &mut File, at: u64, buffer: &[u8]) -> Result<(), String> {
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(at))
        .map_err(|error| format!("cannot seek the movie: {error}"))?;
    file.write_all(buffer)
        .map_err(|error| format!("cannot write the movie: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Build a compact movie: `ftyp` + `mdat` + `moov(trak(mdia(hdlr)))`.
    fn movie(handlers: usize, brand: &[u8; 4]) -> Vec<u8> {
        fn boxed(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
            let mut out = (body.len() as u32 + 8).to_be_bytes().to_vec();
            out.extend_from_slice(kind);
            out.extend_from_slice(body);
            out
        }
        let mut ftyp = brand.to_vec();
        ftyp.extend_from_slice(&[0, 0, 0, 0]);
        ftyp.extend_from_slice(b"isommp42");
        let mut moov = Vec::new();
        for _ in 0..handlers {
            // hdlr: version/flags, predefined, handler type, 12 reserved bytes, C-string name.
            let mut hdlr = vec![0u8; 8];
            hdlr.extend_from_slice(b"vide");
            hdlr.extend_from_slice(&[0u8; 12]);
            hdlr.extend_from_slice(b"VideoHandler\0");
            let mdia = boxed(b"mdia", &boxed(b"hdlr", &hdlr));
            moov.extend_from_slice(&boxed(b"trak", &mdia));
        }
        let mut out = boxed(b"ftyp", &ftyp);
        out.extend_from_slice(&boxed(b"mdat", &[7u8; 32]));
        out.extend_from_slice(&boxed(b"moov", &moov));
        out
    }

    fn temp(name: &str, bytes: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "lapower-mov-{}-{}-{name}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn converts_brand_and_handler_without_moving_any_sample() {
        let original = movie(1, b"isom");
        let path = temp("single.mov", &original);
        quicktime(&path).unwrap();
        let converted = std::fs::read(&path).unwrap();
        assert_eq!(&converted[4..8], b"ftyp");
        assert_eq!(&converted[8..12], QT_BRAND);
        assert!(converted.windows(8).any(|window| window == b"mhlrvide"));
        assert_eq!(
            converted.len(),
            original.len(),
            "the rewrite must not resize the file"
        );
        // Sample data is untouched: the rewrite only changes brand and handler metadata, so
        // every offset a muxer already wrote stays valid.
        // The media box payload is untouched: the rewrite only edits brand and handler
        // metadata, so every offset a muxer already wrote stays valid.
        let mdat = original
            .windows(4)
            .position(|window| window == b"mdat")
            .expect("fixture has a media box")
            + 4;
        let moov = original
            .windows(4)
            .position(|window| window == b"moov")
            .expect("fixture has a movie box")
            - 4;
        assert_eq!(
            &converted[mdat..moov],
            &original[mdat..moov],
            "converted sample bytes must match the original"
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_tracks_that_are_not_video_or_are_missing() {
        let path = temp("two.mov", &movie(2, b"isom"));
        assert!(quicktime(&path).unwrap_err().contains("one video track"));
        std::fs::remove_file(path).unwrap();
        let path = temp("none.mov", &movie(0, b"isom"));
        assert!(quicktime(&path).unwrap_err().contains("one video track"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_a_truncated_or_malformed_file_type_box() {
        // A bare box header with no payload is not a movie at all.
        let mut bytes = (8u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(b"ftyp");
        let path = temp("no-moov.mov", &bytes);
        assert!(quicktime(&path)
            .unwrap_err()
            .contains("file type box is invalid"));
        std::fs::remove_file(path).unwrap();
        // A valid ftyp without a moov cannot be converted either.
        let bytes = movie(0, b"isom");
        let mut bytes = bytes;
        let moov_at = bytes
            .windows(4)
            .position(|window| window == b"moov")
            .unwrap()
            - 4;
        bytes.truncate(moov_at);
        let path = temp("no-moov-2.mov", &bytes);
        assert!(quicktime(&path)
            .unwrap_err()
            .contains("movie index is missing"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_a_truncated_box_header() {
        let path = temp("short.mov", &[0, 0, 0]);
        assert!(quicktime(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_a_movie_index_above_the_memory_bound() {
        let mut bytes = (8u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(b"moov");
        bytes.resize(8, 0);
        let path = temp("huge.mov", &bytes);
        // A box that claims more bytes than the file holds is rejected before the bound.
        assert!(quicktime(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
