// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-only
// For original project contributions; see COPYRIGHT.
//! ISO base media file writer for the portable encoders.
//!
//! Media Foundation writes its own container, so this module only serves the macOS and Linux
//! paths. It is ordinary Rust and therefore runs on every platform in tests: the encoder hands
//! over already framed access units (4 byte length prefix), the writer keeps the sample table in
//! memory and appends the movie index once the last frame is known.
//!
//! A MOV export is written as QuickTime from the start (qt brands plus the legacy mhlr/vide
//! handler), so unlike the Media Foundation path it needs no byte surgery afterwards.

use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::Path;

use super::model::{Codec, Format, VideoOptions};

/// Identity transform used by both the movie and the track header.
const MATRIX: [i32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];
const LANGUAGE: u16 = 0x55c4;
const COMPRESSOR: &[u8] = b"laPower";

struct Sample {
    offset: u32,
    size: u32,
    duration: u32,
    keyframe: bool,
}

/// Streaming MP4 / MOV writer for one video track.
pub(super) struct Muxer {
    out: BufWriter<File>,
    position: u64,
    /// Absolute offset of the movie data box, patched when the writer finishes.
    mdat: u64,
    timescale: u32,
    width: u32,
    height: u32,
    codec: Codec,
    quicktime: bool,
    config: Vec<u8>,
    samples: Vec<Sample>,
}

impl Muxer {
    /// Create the file and its file type box, then open the movie data box. The config
    /// argument is a complete avcC or hvcC payload.
    pub(super) fn create(
        path: &Path,
        options: &VideoOptions,
        config: &[u8],
    ) -> Result<Self, String> {
        if config.is_empty() {
            return Err("the encoder did not produce a decoder configuration".into());
        }
        let file =
            File::create(path).map_err(|error| format!("cannot create the movie file: {error}"))?;
        let mut muxer = Self {
            out: BufWriter::new(file),
            position: 0,
            mdat: 0,
            timescale: options.fps.max(1),
            width: options.width,
            height: options.height,
            codec: options.codec,
            quicktime: options.format == Format::Mov,
            config: config.to_vec(),
            samples: Vec::new(),
        };
        let ftyp = muxer.file_type();
        muxer.write(&boxed(b"ftyp", &ftyp))?;
        muxer.mdat = muxer.position;
        // The size needs the whole movie; the placeholder is patched in finish.
        muxer.write(&[0, 0, 0, 0])?;
        muxer.write(b"mdat")?;
        Ok(muxer)
    }

    /// Append one access unit. A keyframe fills the sync sample table.
    pub(super) fn write_sample(
        &mut self,
        data: &[u8],
        duration: u32,
        keyframe: bool,
    ) -> Result<(), String> {
        if self.samples.len() >= u32::MAX as usize {
            return Err("the movie has too many frames".into());
        }
        let offset = u32::try_from(self.position)
            .map_err(|_| "the movie exceeds the 4 GiB sample table limit".to_owned())?;
        self.write(data)?;
        self.samples.push(Sample {
            offset,
            size: u32::try_from(data.len())
                .map_err(|_| "a video frame is too large for the sample table".to_owned())?,
            duration: duration.max(1),
            keyframe,
        });
        Ok(())
    }

    /// Close the sample table, write the movie index and flush the file.
    pub(super) fn finish(mut self) -> Result<(), String> {
        if self.samples.is_empty() {
            return Err("the encoder produced no frames".into());
        }
        let end = self.position;
        let size = u32::try_from(end - self.mdat)
            .map_err(|_| "the movie exceeds the 4 GiB sample table limit".to_owned())?;
        self.out
            .seek(SeekFrom::Start(self.mdat))
            .map_err(|error| format!("cannot patch the movie data box: {error}"))?;
        self.out
            .write_all(&size.to_be_bytes())
            .map_err(|error| format!("cannot patch the movie data box: {error}"))?;
        self.out
            .seek(SeekFrom::Start(end))
            .map_err(|error| format!("cannot seek to the movie index: {error}"))?;
        let moov = self.movie();
        self.out
            .write_all(&moov)
            .map_err(|error| format!("cannot write the movie index: {error}"))?;
        self.out
            .flush()
            .map_err(|error| format!("cannot flush the movie: {error}"))?;
        self.out
            .get_ref()
            .sync_all()
            .map_err(|error| format!("cannot flush the movie: {error}"))?;
        Ok(())
    }

    fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.out
            .write_all(bytes)
            .map_err(|error| format!("cannot write the movie: {error}"))?;
        self.position += bytes.len() as u64;
        Ok(())
    }

    fn file_type(&self) -> Vec<u8> {
        let mut body = Vec::new();
        if self.quicktime {
            body.extend(b"qt  ");
            body.extend(0x0000_0200u32.to_be_bytes());
            body.extend(b"qt  ");
        } else {
            body.extend(b"isom");
            body.extend(0x0000_0200u32.to_be_bytes());
            body.extend(b"isom");
            body.extend(b"iso2");
            body.extend(b"avc1");
            body.extend(b"mp41");
        }
        body
    }

    /// Build a complete movie index from the collected samples.
    fn movie(&self) -> Vec<u8> {
        let count = u32::try_from(self.samples.len()).unwrap_or(u32::MAX);
        let duration: u32 = self.samples.iter().map(|sample| sample.duration).sum();
        let mvhd = full(
            b"mvhd",
            0,
            0,
            &[
                &0u32.to_be_bytes()[..], // creation time
                &0u32.to_be_bytes()[..], // modification time
                &self.timescale.to_be_bytes()[..],
                &duration.to_be_bytes()[..],
                &0x0001_0000u32.to_be_bytes()[..], // rate 1.0
                &0x0100u16.to_be_bytes()[..],      // volume 1.0
                &0u16.to_be_bytes()[..],           // reserved
                &[0u8; 8][..],                     // reserved
                &matrix()[..],
                &[0u8; 24][..],          // pre_defined
                &2u32.to_be_bytes()[..], // next track id
            ]
            .concat(),
        );
        let tkhd = self.track_header(duration);
        let mdhd = full(
            b"mdhd",
            0,
            0,
            &[
                &0u32.to_be_bytes()[..],
                &0u32.to_be_bytes()[..],
                &self.timescale.to_be_bytes()[..],
                &duration.to_be_bytes()[..],
                &LANGUAGE.to_be_bytes()[..],
                &0u16.to_be_bytes()[..],
            ]
            .concat(),
        );
        let hdlr = self.handler();
        let vmhd = full(
            b"vmhd",
            0,
            1,
            &[&0u16.to_be_bytes()[..], &[0u8; 6][..]].concat(),
        );
        let url = boxed(b"url ", &full_box(0, 1, &[]));
        let dref = boxed(
            b"dref",
            &full_box(0, 0, &[&1u32.to_be_bytes()[..], &url[..]].concat()),
        );
        let dinf = boxed(b"dinf", &dref);
        let stbl = boxed(
            b"stbl",
            &[
                &self.sample_description()[..],
                &self.time_to_sample()[..],
                &self.sync_samples()[..],
                &self.sample_to_chunk()[..],
                &self.sample_sizes()[..],
                &self.chunk_offsets()[..],
            ]
            .concat(),
        );
        let minf = boxed(b"minf", &[&vmhd[..], &dinf[..], &stbl[..]].concat());
        let mdia = boxed(b"mdia", &[&mdhd[..], &hdlr[..], &minf[..]].concat());
        let trak = boxed(b"trak", &[&tkhd[..], &mdia[..]].concat());
        let _ = count;
        boxed(b"moov", &[&mvhd[..], &trak[..]].concat())
    }

    fn track_header(&self, duration: u32) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend(0u32.to_be_bytes()); // creation time
        body.extend(0u32.to_be_bytes()); // modification time
        body.extend(1u32.to_be_bytes()); // track id
        body.extend(0u32.to_be_bytes()); // reserved
        body.extend(duration.to_be_bytes());
        body.extend([0u8; 8]); // reserved
        body.extend(0u16.to_be_bytes()); // layer
        body.extend(0u16.to_be_bytes()); // alternate group
        body.extend(0u16.to_be_bytes()); // volume (video)
        body.extend(0u16.to_be_bytes()); // reserved
        body.extend(matrix());
        body.extend((self.width << 16).to_be_bytes());
        body.extend((self.height << 16).to_be_bytes());
        full(b"tkhd", 0, 0x0007, &body)
    }

    fn handler(&self) -> Vec<u8> {
        let mut body = Vec::new();
        if self.quicktime {
            body.extend(b"mhlr");
            body.extend(b"vide");
            body.extend([0u8; 12]); // manufacturer, flags, mask
            body.push(COMPRESSOR.len() as u8);
            body.extend(COMPRESSOR);
        } else {
            body.extend(0u32.to_be_bytes()); // pre_defined
            body.extend(b"vide");
            body.extend([0u8; 12]); // reserved
            body.extend(b"VideoHandler\0");
        }
        full(b"hdlr", 0, 0, &body)
    }

    fn sample_description(&self) -> Vec<u8> {
        let (config_kind, entry_type): (&[u8; 4], &[u8; 4]) = match self.codec {
            Codec::H264 => (b"avcC", b"avc1"),
            Codec::H265 => (b"hvcC", b"hvc1"),
        };
        let mut entry = Vec::new();
        entry.extend([0u8; 6]); // reserved
        entry.extend(1u16.to_be_bytes()); // data reference index
        entry.extend([0u8; 16]); // pre_defined / reserved / pre_defined
        entry.extend((self.width as u16).to_be_bytes());
        entry.extend((self.height as u16).to_be_bytes());
        entry.extend(0x0048_0000u32.to_be_bytes()); // 72 dpi
        entry.extend(0x0048_0000u32.to_be_bytes()); // 72 dpi
        entry.extend(0u32.to_be_bytes()); // reserved
        entry.extend(1u16.to_be_bytes()); // frame count
        entry.extend(compressor_name());
        entry.extend(0x0018u16.to_be_bytes()); // depth
        entry.extend(0xffffu16.to_be_bytes()); // pre_defined
        entry.extend(boxed(config_kind, &self.config));
        entry.extend(boxed(b"colr", &colour()));
        let entry = boxed(entry_type, &entry);
        full(
            b"stsd",
            0,
            0,
            &[&1u32.to_be_bytes()[..], &entry[..]].concat(),
        )
    }

    fn time_to_sample(&self) -> Vec<u8> {
        let mut runs: Vec<(u32, u32)> = Vec::new();
        for sample in &self.samples {
            match runs.last_mut() {
                Some((count, delta)) if *delta == sample.duration => *count += 1,
                _ => runs.push((1, sample.duration)),
            }
        }
        let mut body = Vec::new();
        body.extend((runs.len() as u32).to_be_bytes());
        for (count, delta) in runs {
            body.extend(count.to_be_bytes());
            body.extend(delta.to_be_bytes());
        }
        full(b"stts", 0, 0, &body)
    }

    fn sync_samples(&self) -> Vec<u8> {
        if self.samples.iter().all(|sample| sample.keyframe) {
            return Vec::new();
        }
        let mut body = Vec::new();
        let mut count = 0u32;
        for (index, sample) in self.samples.iter().enumerate() {
            if sample.keyframe {
                body.extend(((index + 1) as u32).to_be_bytes());
                count += 1;
            }
        }
        full(
            b"stss",
            0,
            0,
            &[&count.to_be_bytes()[..], &body[..]].concat(),
        )
    }

    fn sample_to_chunk(&self) -> Vec<u8> {
        let count = self.samples.len() as u32;
        full(
            b"stsc",
            0,
            0,
            &[
                &1u32.to_be_bytes()[..],
                &1u32.to_be_bytes()[..],
                &count.to_be_bytes()[..],
                &1u32.to_be_bytes()[..],
            ]
            .concat(),
        )
    }

    fn sample_sizes(&self) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend(0u32.to_be_bytes()); // sample size 0: sizes follow
        body.extend((self.samples.len() as u32).to_be_bytes());
        for sample in &self.samples {
            body.extend(sample.size.to_be_bytes());
        }
        full(b"stsz", 0, 0, &body)
    }

    fn chunk_offsets(&self) -> Vec<u8> {
        let first = self.samples[0].offset;
        full(
            b"stco",
            0,
            0,
            &[&1u32.to_be_bytes()[..], &first.to_be_bytes()[..]].concat(),
        )
    }
}

/// Append a complete box: 32 bit size, four character type, body.
fn boxed(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 8);
    out.extend(((body.len() as u32) + 8).to_be_bytes());
    out.extend(kind);
    out.extend(body);
    out
}

/// Body of a full box: version, 24 bit flags, then the payload. The caller names the box.
fn full_box(version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 4);
    out.push(version);
    out.extend((flags & 0x00ff_ffff).to_be_bytes()[1..].iter().copied());
    out.extend(body);
    out
}

/// A complete full box.
fn full(kind: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
    boxed(kind, &full_box(version, flags, body))
}

fn matrix() -> Vec<u8> {
    let mut out = Vec::with_capacity(36);
    for value in MATRIX {
        out.extend(value.to_be_bytes());
    }
    out
}

/// The 32 byte Pascal style compressor name every video sample entry carries.
fn compressor_name() -> [u8; 32] {
    let mut name = [0u8; 32];
    name[0] = COMPRESSOR.len() as u8;
    name[1..=COMPRESSOR.len()].copy_from_slice(COMPRESSOR);
    name
}

/// BT.709, limited range, as a nclx colour information box.
fn colour() -> Vec<u8> {
    let mut body = Vec::new();
    body.extend(b"nclx");
    body.extend(1u16.to_be_bytes()); // BT.709 primaries
    body.extend(1u16.to_be_bytes()); // BT.709 transfer
    body.extend(1u16.to_be_bytes()); // BT.709 matrix
    body.push(0); // limited range
    body
}

/// Split an Annex-B byte stream into its NAL units, without the start codes.
pub(super) fn annexb_nals(annexb: &[u8]) -> Vec<&[u8]> {
    let mut units = Vec::new();
    let mut at = 0usize;
    let mut start = None;
    while at + 3 <= annexb.len() {
        let code = if annexb[at..].starts_with(&[0, 0, 1]) {
            Some(3)
        } else if annexb[at..].starts_with(&[0, 0, 0, 1]) {
            Some(4)
        } else {
            None
        };
        if let Some(code) = code {
            if let Some(begin) = start {
                units.push(&annexb[begin..at]);
            }
            at += code;
            start = Some(at);
        } else {
            at += 1;
        }
    }
    if let Some(begin) = start {
        let end = annexb.len();
        if begin < end {
            units.push(&annexb[begin..end]);
        }
    }
    units
}

/// Convert Annex-B NAL units into the 4 byte length prefixed form a sample table stores.
pub(super) fn annexb_to_length_prefixed(annexb: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(annexb.len());
    for unit in annexb_nals(annexb) {
        out.extend((unit.len() as u32).to_be_bytes());
        out.extend(unit);
    }
    out
}

/// Build the avcC payload from the H.264 sequence and picture parameter sets.
pub(super) fn avcc_from_parameter_sets(sps: &[u8], pps: &[u8]) -> Result<Vec<u8>, String> {
    if sps.len() < 4 || pps.is_empty() {
        return Err("the encoder produced incomplete H.264 parameter sets".into());
    }
    let mut out = Vec::with_capacity(16 + sps.len() + pps.len());
    // Configuration version, profile, compatibility, level, four byte lengths, one SPS.
    out.extend([
        1u8,
        sps[1],
        sps[2],
        sps[3],
        0b1111_1100 | 3,
        0b1110_0000 | 1,
    ]);
    out.extend((sps.len() as u16).to_be_bytes());
    out.extend(sps);
    out.push(1); // one picture parameter set
    out.extend((pps.len() as u16).to_be_bytes());
    out.extend(pps);
    Ok(out)
}

/// Build the hvcC payload from the HEVC video, sequence and picture parameter sets.
///
/// No shipped encoder produces HEVC yet (Windows uses Media Foundation, which writes its own
/// container), but the portable muxer already accepts the configuration a future adapter needs.
#[allow(dead_code)]
pub(super) fn hvcc_from_parameter_sets(
    vps: &[u8],
    sps: &[u8],
    pps: &[u8],
) -> Result<Vec<u8>, String> {
    if vps.len() < 16 || sps.len() < 16 || pps.is_empty() {
        return Err("the encoder produced incomplete HEVC parameter sets".into());
    }
    let mut out = Vec::new();
    out.push(1); // configuration version
    out.push(sps[1]); // profile space, tier, profile idc
    out.extend(&sps[2..6]); // profile compatibility flags
    out.extend(&sps[6..12]); // constraint indicator flags
    out.push(sps[12]); // level
    out.extend(0xf000u16.to_be_bytes()); // minimum spatial segmentation
    out.push(0xfcu8); // parallelism type
    out.push(0xfdu8); // chroma format 4:2:0
    out.push(0xf8u8); // bit depth luma
    out.push(0xf8u8); // bit depth chroma
    out.extend(0u16.to_be_bytes()); // average frame rate
    out.push(0x0fu8); // temporal layers and four byte lengths
    out.push(3); // three parameter set arrays
    for (kind, unit) in [(32u8, vps), (33, sps), (34, pps)] {
        out.push(0x80 | kind);
        out.extend(1u16.to_be_bytes());
        out.extend((unit.len() as u16).to_be_bytes());
        out.extend(unit);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video_export::model::{Theme, VideoOptions};

    fn options(format: Format) -> VideoOptions {
        VideoOptions {
            report_type: crate::video_export::model::ReportType::Video,
            image_layout: crate::video_export::model::ImageLayout::Widescreen,
            show_markers: true,
            show_marker_details: true,
            width: 320,
            height: 180,
            fps: 10,
            codec: Codec::H264,
            acceleration: crate::video_export::model::Acceleration::Auto,
            quality: crate::video_export::model::Quality::High,
            format,
            duration_s: 1,
            theme: Theme::Light,
            visible_series: [true; 4],
        }
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "lapower-mux-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        directory.join(name)
    }

    /// Every box in the slice as (type, body start, box end).
    fn boxes(bytes: &[u8]) -> Vec<([u8; 4], usize, usize)> {
        let mut out = Vec::new();
        let mut at = 0usize;
        while at + 8 <= bytes.len() {
            let size = u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
                as usize;
            let kind = [bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]];
            assert!(size >= 8 && at + size <= bytes.len(), "bad box at {at}");
            out.push((kind, at + 8, at + size));
            at += size;
        }
        out
    }

    fn find(bytes: &[u8], path: &[&[u8; 4]]) -> Vec<u8> {
        let Some((kind, rest)) = path.split_first() else {
            return bytes.to_vec();
        };
        let (_, start, end) = *boxes(bytes)
            .iter()
            .find(|(name, _, _)| name == *kind)
            .unwrap_or_else(|| panic!("missing box {:?}", String::from_utf8_lossy(*kind)));
        find(&bytes[start..end], rest)
    }

    fn config() -> Vec<u8> {
        avcc_from_parameter_sets(&[0x67, 0x64, 0x00, 0x1f], &[0x68, 0xee]).unwrap()
    }

    fn write(path: &std::path::Path, format: Format) -> Vec<u8> {
        let mut muxer = Muxer::create(path, &options(format), &config()).unwrap();
        for index in 0..4u32 {
            let data = [index as u8; 16];
            muxer.write_sample(&data, 1, index == 0).unwrap();
        }
        muxer.finish().unwrap();
        std::fs::read(path).unwrap()
    }

    #[test]
    fn samples_are_addressable_from_the_chunk_offset_table() {
        let path = scratch("plain.mp4");
        let bytes = write(&path, Format::Mp4);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());

        assert_eq!(&bytes[4..8], b"ftyp");
        assert_eq!(&find(&bytes, &[b"ftyp"])[..4], b"isom");
        let offset = u32::from_be_bytes(
            find(
                &bytes,
                &[b"moov", b"trak", b"mdia", b"minf", b"stbl", b"stco"],
            )[8..12]
                .try_into()
                .unwrap(),
        ) as usize;
        assert_eq!(&bytes[offset - 4..offset], b"mdat");
        assert_eq!(&bytes[offset..offset + 16], &[0u8; 16]);
        let sizes = find(
            &bytes,
            &[b"moov", b"trak", b"mdia", b"minf", b"stbl", b"stsz"],
        );
        assert_eq!(u32::from_be_bytes(sizes[8..12].try_into().unwrap()), 4);
        let sync = find(
            &bytes,
            &[b"moov", b"trak", b"mdia", b"minf", b"stbl", b"stss"],
        );
        assert_eq!(&sync[4..12], &[0, 0, 0, 1, 0, 0, 0, 1]);
        let description = find(
            &bytes,
            &[b"moov", b"trak", b"mdia", b"minf", b"stbl", b"stsd"],
        );
        assert_eq!(&description[12..16], b"avc1");
    }

    #[test]
    fn quicktime_export_uses_the_legacy_handler_and_brands() {
        let path = scratch("movie.mov");
        let bytes = write(&path, Format::Mov);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
        assert_eq!(&find(&bytes, &[b"ftyp"])[..4], b"qt  ");
        let handler = find(&bytes, &[b"moov", b"trak", b"mdia", b"hdlr"]);
        assert_eq!(&handler[4..8], b"mhlr");
        assert_eq!(&handler[8..12], b"vide");
        assert_eq!(handler[24] as usize, COMPRESSOR.len());
    }

    #[test]
    fn annexb_access_units_become_length_prefixed() {
        let annexb = [0, 0, 0, 1, 0x65, 0xaa, 0xbb, 0, 0, 1, 0x06, 0xcc];
        assert_eq!(
            annexb_to_length_prefixed(&annexb),
            vec![0, 0, 0, 3, 0x65, 0xaa, 0xbb, 0, 0, 0, 2, 0x06, 0xcc]
        );
        assert_eq!(annexb_nals(&annexb).len(), 2);
    }

    #[test]
    fn inconsistent_frame_durations_use_separate_runs() {
        let path = scratch("variable.mp4");
        let mut muxer = Muxer::create(&path, &options(Format::Mp4), &config()).unwrap();
        muxer.write_sample(&[1; 8], 1, true).unwrap();
        muxer.write_sample(&[2; 8], 1, false).unwrap();
        muxer.write_sample(&[3; 8], 2, false).unwrap();
        muxer.finish().unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
        let stts = find(
            &bytes,
            &[b"moov", b"trak", b"mdia", b"minf", b"stbl", b"stts"],
        );
        assert_eq!(u32::from_be_bytes(stts[4..8].try_into().unwrap()), 2);
        assert_eq!(&stts[8..16], &[0, 0, 0, 2, 0, 0, 0, 1]);
        assert_eq!(&stts[16..24], &[0, 0, 0, 1, 0, 0, 0, 2]);
    }
}
