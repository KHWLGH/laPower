// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-only
// For original project contributions; see COPYRIGHT.
//! Frame loop shared by the macOS and Linux encoders.
//!
//! Rendering, cancellation and the container are identical on both hosts; only the encoder in the
//! middle differs (VideoToolbox on macOS, OpenH264 everywhere else), so it plugs in through the
//! small Encoder trait below. The loop keeps one canonical RGBA frame and hands it to the backend.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use super::model::{VideoOptions, VideoPayload};
use super::mp4;
use super::skia;

/// One encoded access unit, already in 4 byte length prefixed form.
pub(super) struct Sample {
    pub data: Vec<u8>,
    pub keyframe: bool,
}

/// A video encoder the portable loop can drive.
pub(super) trait Encoder {
    /// Reported to the interface: hardware or software.
    fn name(&self) -> &'static str;
    /// Decoder configuration (avcC / hvcC), valid once the first sample has been produced.
    fn config(&self) -> Option<Vec<u8>>;
    /// Encode one frame. Any completed access units are appended to out.
    fn push(
        &mut self,
        rgba: &[u8],
        index: usize,
        cancel: &AtomicBool,
        out: &mut Vec<Sample>,
    ) -> Result<(), String>;
    /// Flush buffered frames after the last push; encoders that hold frames emit them here.
    fn finish(&mut self, _out: &mut Vec<Sample>) -> Result<(), String> {
        Ok(())
    }
}

/// Render and encode the whole report. Returns the encoder that was used.
pub(super) fn encode(
    payload: &VideoPayload,
    path: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f64),
    encoder: &mut dyn Encoder,
) -> Result<String, String> {
    let options = &payload.options;
    let canvas = skia::Canvas::new(options, &payload.palette)?;
    let mut rgba = vec![0u8; options.width as usize * options.height as usize * 4];
    let mut muxer: Option<mp4::Muxer> = None;
    let mut samples: Vec<Sample> = Vec::new();
    let count = payload.frames.t.len();
    for index in 0..count {
        if cancel.load(Ordering::Acquire) {
            return Err("video encoding was cancelled".into());
        }
        canvas.draw_frame(payload, index);
        canvas.copy_pixels(&mut rgba);
        encoder
            .push(&rgba, index, cancel, &mut samples)
            .map_err(|error| format!("cannot encode video frame {index}: {error}"))?;
        drain(&mut muxer, options, path, &*encoder, &mut samples)?;
        progress((index + 1) as f64 / count.max(1) as f64);
    }
    if cancel.load(Ordering::Acquire) {
        return Err("video encoding was cancelled".into());
    }
    encoder.finish(&mut samples)?;
    drain(&mut muxer, options, path, &*encoder, &mut samples)?;
    let Some(muxer) = muxer else {
        return Err("the encoder produced no frames".into());
    };
    muxer.finish()?;
    Ok(encoder.name().to_owned())
}

/// Append pending access units, creating the container once the decoder configuration exists.
fn drain(
    muxer: &mut Option<mp4::Muxer>,
    options: &VideoOptions,
    path: &Path,
    encoder: &dyn Encoder,
    samples: &mut Vec<Sample>,
) -> Result<(), String> {
    for sample in samples.drain(..) {
        if muxer.is_none() {
            let config = encoder
                .config()
                .ok_or_else(|| "the encoder did not produce a decoder configuration".to_owned())?;
            *muxer = Some(mp4::Muxer::create(path, options, &config)?);
        }
        if let Some(writer) = muxer.as_mut() {
            writer.write_sample(&sample.data, 1, sample.keyframe)?;
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::video_export::model::{Codec, Format, Theme, VideoLabels, VideoPalette};

    /// A deterministic stand-in for a real encoder: it never touches a platform codec, so the
    /// loop, the muxer and the renderer are exercised on every host.
    struct Fake {
        width: usize,
        height: usize,
        config: Option<Vec<u8>>,
        finish_calls: usize,
        fail_at: Option<usize>,
    }

    impl Fake {
        fn new(width: usize, height: usize) -> Self {
            Self {
                width,
                height,
                config: Some(vec![1, 2, 3, 4]),
                finish_calls: 0,
                fail_at: None,
            }
        }
    }

    impl Encoder for Fake {
        fn name(&self) -> &'static str {
            "software"
        }

        fn config(&self) -> Option<Vec<u8>> {
            self.config.clone()
        }

        fn push(
            &mut self,
            rgba: &[u8],
            index: usize,
            cancel: &AtomicBool,
            out: &mut Vec<Sample>,
        ) -> Result<(), String> {
            assert_eq!(rgba.len(), self.width * self.height * 4);
            if let Some(fail_at) = self.fail_at {
                if index == fail_at {
                    return Err("the fake encoder gave up".into());
                }
            }
            assert!(!cancel.load(Ordering::Acquire) || index > 0);
            out.push(Sample {
                data: vec![index as u8; 8],
                keyframe: index == 0,
            });
            Ok(())
        }

        fn finish(&mut self, _out: &mut Vec<Sample>) -> Result<(), String> {
            self.finish_calls += 1;
            Ok(())
        }
    }

    fn payload(format: Format) -> VideoPayload {
        let options = VideoOptions {
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
        };
        let frames = options.frames();
        VideoPayload {
            options,
            header: crate::video_export::model::VideoHeader {
                title: "laPower".into(),
                status: "Recorded".into(),
                status_kind: "complete".into(),
            },
            labels: VideoLabels {
                eyebrow: "laPower".into(),
                chart: "Curves".into(),
                breakpoints: "Markers".into(),
                power: "Power".into(),
                voltage: "Voltage".into(),
                current: "Current".into(),
                temperature: "Temperature".into(),
                capacity: "Capacity".into(),
                points: "points".into(),
                no_series: "No curves".into(),
                missing: "No reading".into(),
                unit_w: "W".into(),
                unit_v: "V".into(),
                unit_a: "A".into(),
                unit_c: "C".into(),
                unit_wh: "Wh".into(),
                average: "Average".into(),
                maximum: "Maximum".into(),
                range: "Range".into(),
                energy: "Energy".into(),
            },
            palette: VideoPalette {
                background: "#ffffff".into(),
                card: "#fafafa".into(),
                ink: "#242424".into(),
                muted: "#424242".into(),
                border: "#e0e0e0".into(),
                accent: "#0f6cbd".into(),
                soft: "#f0f0f0".into(),
                energy: "#c239b3".into(),
                series: [
                    "#3a96dd".into(),
                    "#00cc6a".into(),
                    "#f7630c".into(),
                    "#d13438".into(),
                ],
            },
            summary: crate::video_export::model::VideoSummary {
                average_voltage_v: Some(5.0),
                elapsed_s: 1.0,
                points: frames as u64,
                average_power_w: Some(5.0),
                min_voltage_v: Some(4.9),
                max_voltage_v: Some(5.1),
                peak_current_a: Some(1.0),
                max_temp_c: Some(31.0),
                energy_wh: 0.0014,
                capacity_mah: 0.28,
                has_temperature: true,
            },
            overview: crate::video_export::model::VideoOverview {
                bucket_ms: 4,
                points: vec![
                    [Some(0.0), Some(5.0), Some(1.0), Some(5.0), Some(30.0)],
                    [Some(500.0), Some(5.1), Some(1.1), Some(5.6), Some(30.5)],
                    [Some(1000.0), Some(4.9), Some(0.9), Some(4.4), Some(31.0)],
                ],
            },
            frames: crate::video_export::model::VideoFrames {
                t: (0..frames).map(|index| index as f64 / 10.0).collect(),
                voltage: vec![Some(5.0); frames],
                current: vec![Some(1.0); frames],
                power: vec![Some(5.0); frames],
                temperature: vec![Some(30.0); frames],
            },
            markers: Vec::new(),
        }
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "lapower-portable-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        directory.join(name)
    }

    #[test]
    fn the_loop_muxes_every_frame_and_reports_progress() {
        let value = payload(Format::Mp4);
        let path = scratch("portable.mp4");
        let mut encoder = Fake::new(320, 180);
        let mut progress = Vec::new();
        let cancel = AtomicBool::new(false);
        let name = encode(
            &value,
            &path,
            &cancel,
            |value| progress.push(value),
            &mut encoder,
        )
        .unwrap();
        assert_eq!(name, "software");
        assert_eq!(progress.len(), 10);
        assert!((progress[9] - 1.0).abs() < f64::EPSILON);
        assert_eq!(encoder.finish_calls, 1);
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[4..8], b"ftyp");
        assert_eq!(&bytes[8..12], b"isom");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn cancellation_and_encoder_failures_are_reported() {
        let value = payload(Format::Mp4);
        let path = scratch("cancelled.mp4");
        let cancel = AtomicBool::new(true);
        let mut encoder = Fake::new(320, 180);
        let error = encode(&value, &path, &cancel, |_| {}, &mut encoder).unwrap_err();
        assert!(error.contains("cancelled"), "unexpected error: {error}");

        let cancel = AtomicBool::new(false);
        let path = scratch("broken.mp4");
        let mut encoder = Fake::new(320, 180);
        encoder.fail_at = Some(3);
        let error = encode(&value, &path, &cancel, |_| {}, &mut encoder).unwrap_err();
        assert!(error.contains("video frame 3"), "unexpected error: {error}");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
