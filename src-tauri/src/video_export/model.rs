//! Frozen video-report payload and its validation.
//!
//! The frontend owns the sample columns, so it projects the recording into this
//! self-contained payload before the job starts. The backend therefore never reads a
//! recording store, never sees data grow while encoding, and stays a pure renderer.
//!
//! Nothing here embeds a UI language: user-visible text arrives with the payload, and
//! failures travel as codes that the frontend translates.

use serde::{Deserialize, Serialize};

pub const MAX_DURATION_S: u32 = 60;
pub const MAX_MARKERS: usize = 8;
pub const MAX_OVERVIEW_POINTS: usize = 256 * 4;
pub const RESOLUTIONS: [(u32, u32); 4] = [(1280, 720), (1920, 1080), (2560, 1440), (3840, 2160)];
pub const FRAME_RATES: [u32; 3] = [24, 30, 60];

fn invalid(reason: impl Into<String>) -> String {
    reason.into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Codec {
    H264,
    H265,
}

impl Codec {
    /// Diagnostic-only name. Never rendered into a frame.
    pub fn label(self) -> &'static str {
        match self {
            Self::H264 => "H.264",
            Self::H265 => "H.265 (HEVC)",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Mp4,
    Mov,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoOptions {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub codec: Codec,
    pub format: Format,
    pub duration_s: u32,
    pub theme: Theme,
    /// Voltage, current, power, temperature. Order matches the reading cards.
    pub visible_series: [bool; 4],
}

impl VideoOptions {
    pub fn validate(&self) -> Result<(), String> {
        if !RESOLUTIONS.contains(&(self.width, self.height)) {
            return Err(invalid("unsupported resolution"));
        }
        if !FRAME_RATES.contains(&self.fps) {
            return Err(invalid("unsupported frame rate"));
        }
        if !(1..=MAX_DURATION_S).contains(&self.duration_s) {
            return Err(invalid("duration must be 1 to 60 seconds"));
        }
        Ok(())
    }

    /// Exact frame count for this request; the encoder indexes frames directly.
    pub fn frames(&self) -> usize {
        self.duration_s as usize * self.fps as usize
    }

    /// The logical canvas is always 1920 wide; every supported resolution is 16:9.
    pub fn canvas_scale(&self) -> f32 {
        self.width as f32 / 1920.0
    }
}

/// User-visible strings, translated by the frontend for the same reason error codes are:
/// one renderer must not embed a UI language.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoLabels {
    pub eyebrow: String,
    pub chart: String,
    pub breakpoints: String,
    pub power: String,
    pub voltage: String,
    pub current: String,
    pub temperature: String,
    pub capacity: String,
    pub points: String,
    pub no_series: String,
    pub missing: String,
    pub unit_w: String,
    pub unit_v: String,
    pub unit_a: String,
    pub unit_c: String,
    pub unit_wh: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoHeader {
    /// Record name, drawn as the report title.
    pub title: String,
    pub status: String,
    /// `recording` keeps the accent colour; every other value uses the warning colour.
    pub status_kind: String,
}

/// Resolved colours for one theme, parsed from `src/video-palette.js`.
///
/// The palette travels with the payload instead of being duplicated in Rust: reading a CSS
/// custom property at render time only works for the theme that is currently applied, and the
/// renderer must be able to draw either one.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoPalette {
    pub background: String,
    pub card: String,
    pub ink: String,
    pub muted: String,
    pub border: String,
    pub accent: String,
    pub soft: String,
    /// Accumulated energy, kept apart from the four measured channels.
    pub energy: String,
    /// Voltage, current, power, temperature.
    pub series: [String; 4],
}

/// Rolled-up statistics for the reading cards. Every field is optional except the three
/// that always exist for a non-empty recording, so a gap or a missing sensor never has to
/// be faked with zero.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoSummary {
    pub elapsed_s: f64,
    pub points: u64,
    pub average_power_w: Option<f64>,
    pub min_voltage_v: Option<f64>,
    pub max_voltage_v: Option<f64>,
    pub peak_current_a: Option<f64>,
    pub max_temp_c: Option<f64>,
    pub energy_wh: f64,
    pub capacity_mah: f64,
    pub has_temperature: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoOverview {
    pub bucket_ms: u64,
    /// `[tMs, voltage, current, power, temperature]` in ascending time order.
    pub points: Vec<[Option<f64>; 5]>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoFrames {
    /// Relative seconds, monotonic non-decreasing, exactly `options.frames()` long.
    pub t: Vec<f64>,
    pub voltage: Vec<Option<f64>>,
    pub current: Vec<Option<f64>>,
    pub power: Vec<Option<f64>>,
    pub temperature: Vec<Option<f64>>,
}

impl VideoFrames {
    /// Frame values of one channel, in legend order (voltage, current, power, temperature).
    pub fn channel(&self, channel: usize) -> &[Option<f64>] {
        match channel {
            0 => &self.voltage,
            1 => &self.current,
            2 => &self.power,
            _ => &self.temperature,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoMarker {
    pub t_s: f64,
    pub label: String,
    pub voltage: Option<f64>,
    pub current: Option<f64>,
    pub power: Option<f64>,
    pub temperature: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoPayload {
    pub options: VideoOptions,
    pub header: VideoHeader,
    pub labels: VideoLabels,
    pub palette: VideoPalette,
    pub summary: VideoSummary,
    pub overview: VideoOverview,
    pub frames: VideoFrames,
    #[serde(default)]
    pub markers: Vec<VideoMarker>,
}

fn series_ok(values: &[Option<f64>], len: usize) -> bool {
    values.len() == len && values.iter().flatten().all(|value| value.is_finite())
}

fn optional_finite(values: impl IntoIterator<Item = Option<f64>>) -> bool {
    values.into_iter().flatten().all(|value| value.is_finite())
}

impl VideoPayload {
    /// Rejects anything the renderer would have to reinterpret. Frame count is exact so
    /// the encoder indexes frames directly instead of resampling a different timeline.
    pub fn validate(&self) -> Result<(), String> {
        self.options.validate()?;
        let frames = self.options.frames();
        let times = &self.frames.t;
        if times.len() != frames {
            return Err(invalid("frame count does not match the requested duration"));
        }
        if !times.iter().all(|value| value.is_finite())
            || times.windows(2).any(|pair| pair[1] < pair[0])
        {
            return Err(invalid("frame times must be finite and sorted"));
        }
        for series in [
            &self.frames.voltage,
            &self.frames.current,
            &self.frames.power,
            &self.frames.temperature,
        ] {
            if !series_ok(series, frames) {
                return Err(invalid("frame series length or value is invalid"));
            }
        }
        if self.overview.points.is_empty() || self.overview.points.len() > MAX_OVERVIEW_POINTS {
            return Err(invalid("overview point count is out of range"));
        }
        if self.overview.points.iter().any(|point| {
            !point[0].is_some_and(|time| time.is_finite() && time >= 0.0)
                || !optional_finite(point[1..].iter().copied())
        }) {
            return Err(invalid("overview point value is invalid"));
        }
        if self
            .overview
            .points
            .windows(2)
            .any(|pair| pair[1][0].unwrap_or_default() < pair[0][0].unwrap_or_default())
        {
            return Err(invalid("overview points must be sorted"));
        }
        if self.markers.len() > MAX_MARKERS {
            return Err(invalid("too many breakpoints for one report"));
        }
        if self.markers.iter().any(|marker| {
            !marker.t_s.is_finite() || marker.t_s < 0.0 || marker.label.trim().is_empty()
        }) {
            return Err(invalid("breakpoint is invalid"));
        }
        if !optional_finite([
            Some(self.summary.elapsed_s),
            Some(self.summary.energy_wh),
            Some(self.summary.capacity_mah),
            self.summary.average_power_w,
            self.summary.min_voltage_v,
            self.summary.max_voltage_v,
            self.summary.peak_current_a,
            self.summary.max_temp_c,
        ]) {
            return Err(invalid("summary value is invalid"));
        }
        if [
            &self.header.title,
            &self.header.status,
            &self.labels.eyebrow,
            &self.labels.chart,
            &self.labels.breakpoints,
            &self.labels.capacity,
        ]
        .into_iter()
        .any(|value| value.len() > 64)
        {
            return Err(invalid("header or labels are too long"));
        }
        for colour in [
            &self.palette.background,
            &self.palette.card,
            &self.palette.ink,
            &self.palette.muted,
            &self.palette.border,
            &self.palette.accent,
            &self.palette.soft,
            &self.palette.energy,
            &self.palette.series[0],
            &self.palette.series[1],
            &self.palette.series[2],
            &self.palette.series[3],
        ] {
            let hex = colour.strip_prefix('#').unwrap_or(colour);
            if hex.len() != 6 || !hex.chars().all(|digit| digit.is_ascii_hexdigit()) {
                return Err(invalid("palette colour is not #rrggbb"));
            }
        }
        Ok(())
    }

    pub fn duration_ms(&self) -> u64 {
        (self.summary.elapsed_s.max(0.0) * 1000.0).round() as u64
    }

    /// Millisecond span each overview bucket covers; the plot uses it to decide which gaps are
    /// real interruptions rather than rendered lines.
    pub fn overview_bucket_ms(&self) -> u64 {
        self.overview.bucket_ms.max(1)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoState {
    Queued,
    Encoding,
    Completed,
    Cancelled,
    Failed,
}

impl VideoState {
    pub fn is_active(self) -> bool {
        matches!(self, Self::Queued | Self::Encoding)
    }
}

/// Failure as the frontend receives it. `code` is a translation key; `detail` keeps the
/// raw diagnostic so a bug report does not have to reproduce the run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoError {
    pub code: &'static str,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStatus {
    pub id: String,
    pub state: VideoState,
    pub progress: f64,
    pub options: Option<VideoOptions>,
    /// The file the user picked, present only after a successful commit.
    pub path: Option<String>,
    pub name: Option<String>,
    /// The encoder that is running right now, not just the one that finished. Set as soon as an
    /// attempt starts so the dialog never has to guess (and never calls hardware "software").
    pub encoder: Option<String>,
    /// Why the zero-copy GPU path was abandoned, kept verbatim for the dialog. Only present when
    /// the export still succeeded on a lesser path, so a real failure is not double-reported.
    pub fallback: Option<String>,
    pub error: Option<VideoError>,
}

impl VideoStatus {
    pub fn queued(id: String, options: VideoOptions) -> Self {
        Self {
            id,
            state: VideoState::Queued,
            progress: 0.0,
            options: Some(options),
            path: None,
            name: None,
            encoder: None,
            fallback: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoCapability {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub codec: Codec,
    pub available: bool,
    /// Diagnostic reason; the frontend pairs it with a translated prefix.
    pub reason: Option<String>,
    pub encoder: Option<String>,
}

/// Only what `start` accepts. The ticket names the destination, so the IPC payload cannot
/// point the writer at an arbitrary path.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoStartRequest {
    pub ticket: String,
    pub payload: VideoPayload,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> VideoOptions {
        VideoOptions {
            width: 1280,
            height: 720,
            fps: 24,
            codec: Codec::H264,
            format: Format::Mp4,
            duration_s: 1,
            theme: Theme::Light,
            visible_series: [true; 4],
        }
    }

    fn payload() -> VideoPayload {
        let options = options();
        let frames = options.frames();
        VideoPayload {
            options,
            header: VideoHeader {
                title: "Charging test".into(),
                status: "Recording".into(),
                status_kind: "recording".into(),
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
            labels: VideoLabels {
                eyebrow: "laPower".into(),
                chart: "Chart".into(),
                breakpoints: "Breakpoints".into(),
                power: "Power".into(),
                voltage: "Voltage".into(),
                current: "Current".into(),
                temperature: "Temperature".into(),
                capacity: "Capacity".into(),
                points: "points".into(),
                no_series: "No series".into(),
                missing: "No data".into(),
                unit_w: "W".into(),
                unit_v: "V".into(),
                unit_a: "A".into(),
                unit_c: "C".into(),
                unit_wh: "Wh".into(),
            },
            summary: VideoSummary {
                elapsed_s: 1.0,
                points: frames as u64,
                energy_wh: 0.5,
                capacity_mah: 12.0,
                ..Default::default()
            },
            overview: VideoOverview {
                bucket_ms: 4,
                points: vec![[Some(0.0), Some(5.0), Some(1.0), Some(5.0), None]],
            },
            frames: VideoFrames {
                t: (0..frames).map(|index| index as f64 / 24.0).collect(),
                voltage: vec![Some(5.0); frames],
                current: vec![Some(1.0); frames],
                power: vec![Some(5.0); frames],
                temperature: vec![None; frames],
            },
            markers: Vec::new(),
        }
    }

    fn marker(t_s: f64, label: &str) -> VideoMarker {
        VideoMarker {
            t_s,
            label: label.into(),
            voltage: None,
            current: None,
            power: None,
            temperature: None,
        }
    }

    #[test]
    fn valid_payload_passes_and_keeps_frame_count_exact() {
        let value = payload();
        value.validate().unwrap();
        assert_eq!(value.frames.t.len(), 24);
        assert_eq!(value.duration_ms(), 1000);
    }

    #[test]
    fn frame_count_must_match_the_requested_duration() {
        let mut value = payload();
        value.frames.t.pop();
        assert!(value.validate().is_err());
        let mut value = payload();
        value.frames.power.pop();
        assert!(value.validate().is_err());
    }

    #[test]
    fn frame_times_must_not_go_backwards() {
        let mut value = payload();
        value.frames.t.swap(3, 9);
        assert!(value.validate().is_err());
    }

    #[test]
    fn unsupported_options_are_rejected() {
        let mut value = payload();
        value.options.width = 1366;
        assert!(value.validate().is_err());
        let mut value = payload();
        value.options.fps = 25;
        assert!(value.validate().is_err());
        let mut value = payload();
        value.options.duration_s = 61;
        assert!(value.validate().is_err());
    }

    #[test]
    fn breakpoints_are_bounded_and_need_a_label() {
        let mut value = payload();
        value.markers = (0..9).map(|index| marker(index as f64, "point")).collect();
        assert!(value.validate().is_err());
        let mut value = payload();
        value.markers.push(marker(0.5, "  "));
        assert!(value.validate().is_err());
    }

    #[test]
    fn overview_points_must_be_sorted() {
        let mut value = payload();
        value.overview.points = vec![
            [Some(0.0), Some(1.0), None, None, None],
            [Some(2.0), Some(1.0), None, None, None],
        ];
        value.validate().unwrap();
        value.overview.points.swap(0, 1);
        assert!(value.validate().is_err());
    }

    /// The exact wire shape `src/video-projection.js` produces. `deny_unknown_fields` on every
    /// struct means this fixture is the contract: renaming a field on either side fails here.
    #[test]
    fn deserialises_the_frontend_payload_shape() {
        let json = serde_json::json!({
            "options": {
                "width": 1920, "height": 1080, "fps": 24, "codec": "h264",
                "format": "mp4", "durationS": 1, "theme": "light",
                "visibleSeries": [true, true, true, true]
            },
            "header": { "title": "laPower", "status": "Recorded", "statusKind": "complete" },
            "labels": {
                "eyebrow": "laPower", "chart": "Output curves", "breakpoints": "Markers",
                "power": "Power", "voltage": "Voltage", "current": "Current",
                "temperature": "Temperature", "capacity": "Capacity", "points": "points",
                "noSeries": "No curves", "missing": "No reading",
                "unitW": "W", "unitV": "V", "unitA": "A", "unitC": "C", "unitWh": "Wh"
            },
            "palette": {
                "background": "#ffffff", "card": "#fafafa", "ink": "#242424",
                "muted": "#424242", "border": "#e0e0e0", "accent": "#0f6cbd",
                "soft": "#f0f0f0", "energy": "#c239b3",
                "series": ["#3a96dd", "#00cc6a", "#f7630c", "#d13438"]
            },
            "summary": {
                "elapsedS": 1.0, "points": 24, "averagePowerW": 5.0,
                "minVoltageV": 4.9, "maxVoltageV": 5.1, "peakCurrentA": 1.0,
                "maxTempC": 31.0, "energyWh": 0.0014, "capacityMah": 0.28,
                "hasTemperature": true
            },
            "overview": {
                "bucketMs": 42,
                "points": [
                    [0.0, 5.0, 1.0, 5.0, 30.0],
                    [1000.0, 4.9, 0.9, 4.4, null]
                ]
            },
            "frames": {
                "t": [0.0, 0.5],
                "voltage": [5.0, 4.9], "current": [1.0, -0.9],
                "power": [5.0, 4.4], "temperature": [30.0, null]
            },
            "markers": [
                { "tS": 0.5, "label": "half", "voltage": 5.0, "current": 1.0,
                  "power": 5.0, "temperature": null }
            ]
        });
        // Frame count must match duration × fps, so the fixture is corrected before validating.
        let mut value: VideoPayload = serde_json::from_value(json).unwrap();
        value.frames.t = vec![0.0; 24];
        let frames = value.options.frames();
        value.frames.voltage = vec![Some(5.0); frames];
        value.frames.current = vec![Some(1.0); frames];
        value.frames.power = vec![Some(5.0); frames];
        value.frames.temperature = vec![None; frames];
        value.validate().unwrap();
    }

    #[test]
    fn unknown_option_fields_are_rejected() {
        let json = serde_json::json!({ "width": 1280, "height": 720, "fps": 24,
            "codec": "h264", "format": "mp4", "durationS": 1, "theme": "light",
            "visibleSeries": [true, true, true, true], "extra": 1 });
        assert!(serde_json::from_value::<VideoOptions>(json).is_err());
    }

    #[test]
    fn palette_colours_must_be_hex_triplets() {
        let mut value = payload();
        value.palette.accent = "blue".into();
        assert!(value.validate().is_err());
        let mut value = payload();
        value.palette.series[2] = "#12345".into();
        assert!(value.validate().is_err());
    }

    #[test]
    fn canvas_scale_follows_the_requested_width() {
        assert_eq!(options().canvas_scale(), 1280.0 / 1920.0);
        assert_eq!(Codec::H265.label(), "H.265 (HEVC)");
    }
}
