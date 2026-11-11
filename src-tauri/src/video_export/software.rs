// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-only
// For original project contributions; see COPYRIGHT.
//! Bundled H.264 encoder for hosts without a platform video encoder.
//!
//! Linux uses this path at run time; the Windows test build compiles it so the same code is type
//! checked by the normal test suite, and loads the library dynamically there (Windows ships no
//! OpenH264 and must not grow a C++ build dependency for a path it never runs).

use std::sync::atomic::AtomicBool;

use openh264::encoder::{
    BitRate, Encoder, EncoderConfig, FrameRate, FrameType, IntraFramePeriod, RateControlMode,
};
use openh264::formats::YUVBuffer;
use openh264::{OpenH264API, Timestamp};

use super::model::{Acceleration, Codec, VideoOptions};
use super::mp4;
use super::portable::{Encoder as Backend, Sample};

fn api() -> Result<OpenH264API, String> {
    // Windows ships no OpenH264: the module is compiled there only so the encoder API is type
    // checked by the normal test suite, and every call reports the missing encoder instead.
    #[cfg(not(windows))]
    {
        Ok(OpenH264API::from_source())
    }
    #[cfg(windows)]
    {
        Err("the built-in H.264 encoder is not part of the Windows build".to_owned())
    }
}

/// BT.709 limited range I420, the same matrix the NV12 converter uses on Windows.
fn i420(rgba: &[u8], width: usize, height: usize, out: &mut [u8]) {
    let plane = width * height;
    let chroma = plane / 4;
    for y in 0..height {
        for x in 0..width {
            let at = (y * width + x) * 4;
            let r = i32::from(rgba[at]);
            let g = i32::from(rgba[at + 1]);
            let b = i32::from(rgba[at + 2]);
            out[y * width + x] =
                (((47 * r + 157 * g + 16 * b + 128) >> 8) + 16).clamp(16, 235) as u8;
        }
    }
    for y in (0..height).step_by(2) {
        for x in (0..width).step_by(2) {
            let mut sr = 0i32;
            let mut sg = 0i32;
            let mut sb = 0i32;
            for dy in 0..2 {
                for dx in 0..2 {
                    let at = ((y + dy) * width + x + dx) * 4;
                    sr += i32::from(rgba[at]);
                    sg += i32::from(rgba[at + 1]);
                    sb += i32::from(rgba[at + 2]);
                }
            }
            let at = (y / 2) * (width / 2) + x / 2;
            out[plane + at] = (((-6596 * sr - 22189 * sg + 28785 * sb + 131072) >> 18) + 128)
                .clamp(16, 240) as u8;
            out[plane + chroma + at] =
                (((28785 * sr - 26145 * sg - 2640 * sb + 131072) >> 18) + 128).clamp(16, 240) as u8;
        }
    }
}

/// OpenH264 based H.264 encoder.
pub(super) struct H264 {
    encoder: Encoder,
    width: usize,
    height: usize,
    fps: u32,
    frame: Vec<u8>,
    config: Option<Vec<u8>>,
}

impl H264 {
    pub(super) fn new(options: &VideoOptions) -> Result<Self, String> {
        if options.acceleration == Acceleration::Hardware {
            return Err("the built-in H.264 encoder only provides software encoding".into());
        }
        if options.codec != Codec::H264 {
            return Err("the built-in encoder only provides H.264".into());
        }
        if !options.width.is_multiple_of(2) || !options.height.is_multiple_of(2) {
            return Err("the built-in H.264 encoder needs even dimensions".into());
        }
        let config = EncoderConfig::new()
            .skip_frames(false)
            .rate_control_mode(RateControlMode::Bitrate)
            .bitrate(BitRate::from_bps(options.bitrate() as _))
            .max_frame_rate(FrameRate::from_hz(options.fps as f32))
            .intra_frame_period(IntraFramePeriod::from_num_frames(options.frames() as u32));
        let encoder = Encoder::with_api_config(api()?, config)
            .map_err(|error| format!("cannot start the built-in H.264 encoder: {error}"))?;
        let width = options.width as usize;
        let height = options.height as usize;
        Ok(Self {
            encoder,
            width,
            height,
            fps: options.fps.max(1),
            frame: vec![0u8; width * height * 3 / 2],
            config: None,
        })
    }

    fn timestamp(&self, index: usize) -> Timestamp {
        Timestamp::from_millis(index as u64 * 1000 / u64::from(self.fps))
    }
}

impl Backend for H264 {
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
        if cancel.load(std::sync::atomic::Ordering::Acquire) {
            return Err("video encoding was cancelled".into());
        }
        i420(rgba, self.width, self.height, &mut self.frame);
        let yuv = YUVBuffer::from_vec(self.frame.clone(), self.width, self.height);
        let packet = self
            .encoder
            .encode_at(&yuv, self.timestamp(index))
            .map_err(|error| format!("the built-in H.264 encoder failed: {error}"))?;
        let keyframe = packet.frame_type() == FrameType::I;
        let annexb = packet.to_vec();
        let nals = mp4::annexb_nals(&annexb);
        if self.config.is_none() {
            let mut sps: Option<Vec<u8>> = None;
            let mut pps: Option<Vec<u8>> = None;
            for unit in &nals {
                match unit.first().map(|byte| byte & 0x1f) {
                    Some(7) => sps = Some((*unit).to_vec()),
                    Some(8) => pps = Some((*unit).to_vec()),
                    _ => {}
                }
            }
            if let (Some(sps), Some(pps)) = (sps, pps) {
                self.config = Some(mp4::avcc_from_parameter_sets(&sps, &pps)?);
            }
        }
        // Parameter sets live in avcC; repeating them in every keyframe sample bloats the file.
        let mut sample = Vec::with_capacity(annexb.len());
        for unit in nals {
            let kind = unit.first().map(|byte| byte & 0x1f);
            if kind == Some(7) || kind == Some(8) || unit.is_empty() {
                continue;
            }
            sample.extend((unit.len() as u32).to_be_bytes());
            sample.extend(unit);
        }
        if !sample.is_empty() {
            out.push(Sample {
                data: sample,
                keyframe,
            });
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::video_export::model::{Format, Theme};

    fn options() -> VideoOptions {
        VideoOptions {
            report_type: crate::video_export::model::ReportType::Video,
            image_layout: crate::video_export::model::ImageLayout::Widescreen,
            show_markers: true,
            show_marker_details: true,
            width: 320,
            height: 180,
            fps: 24,
            codec: Codec::H264,
            acceleration: crate::video_export::model::Acceleration::Auto,
            quality: crate::video_export::model::Quality::High,
            format: Format::Mp4,
            duration_s: 1,
            theme: Theme::Light,
            visible_series: [true; 4],
        }
    }

    #[test]
    fn only_even_h264_dimensions_are_accepted() {
        let mut value = options();
        value.codec = Codec::H265;
        assert!(H264::new(&value).is_err(), "HEVC must be rejected");
        let mut value = options();
        value.width = 321;
        assert!(H264::new(&value).is_err(), "odd widths must be rejected");
    }

    #[test]
    fn the_bundled_encoder_is_only_present_where_it_is_built() {
        // Windows compiles this module for type checking only: the encoder is part of the macOS
        // and Linux builds.
        let bundled = H264::new(&options());
        #[cfg(windows)]
        assert!(bundled.is_err());
        #[cfg(not(windows))]
        assert!(bundled.is_ok(), "the bundled encoder must start");
    }

    #[test]
    fn bt709_conversion_uses_the_limited_range() {
        let mut i420_out = vec![0u8; 16 * 16 * 3 / 2];
        let black = vec![0u8; 16 * 16 * 4];
        i420(&black, 16, 16, &mut i420_out);
        assert_eq!(
            i420_out[0], 16,
            "black luma must clamp to the limited range"
        );
        assert_eq!(i420_out[16 * 16], 128, "neutral chroma stays neutral");
        let white = vec![255u8; 16 * 16 * 4];
        i420(&white, 16, 16, &mut i420_out);
        assert_eq!(
            i420_out[0], 235,
            "white luma must clamp to the limited range"
        );
        assert_eq!(i420_out[16 * 16], 128, "neutral chroma stays neutral");
    }
}
