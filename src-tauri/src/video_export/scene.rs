// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-only
// For original project contributions; see COPYRIGHT.
//! Backend-agnostic report layout.
//!
//! The contract between layout and rasteriser is a small display list expressed through
//! [`Painter`]: geometry, labels and numbers are decided here so the Direct2D backend on Windows
//! and the skia backend on macOS and Linux cannot drift apart. Layout is authored on a 1920 x 1080
//! logical canvas and scaled by `width / 1920`; every supported resolution is 16:9, so the
//! vertical scale always matches. Coordinates, font ladder and labels follow the report design
//! that shipped in moduled-test.

use super::model::{ImageLayout, ReportType, VideoPalette, VideoPayload};

pub(super) const CANVAS_W: f32 = 1920.0;
/// The same bundled application icon is decoded once by each report canvas.
pub(super) const APP_ICON: &[u8] = include_bytes!("../../icons/icon.png");
const CANVAS_H: f32 = 1080.0;
const MARGIN: f32 = 48.0;
const GAP: f32 = 16.0;
const CONTENT_W: f32 = CANVAS_W - MARGIN * 2.0;
/// Font ladder. The layout only ever refers to a slot, so both backends share the same metrics.
pub(super) const FONT_SIZES: [f32; 6] = [18.0, 20.0, 24.0, 30.0, 38.0, 48.0];
/// How steep the plot's right-hand axes climb. Only the first active series owns the left axis.
const AXIS_STRIDE: f32 = 80.0;

/// Axis-aligned rectangle in logical canvas units.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub(super) const fn new(x: f32, y: f32, w: f32, h: f32) -> Self {
        Self { x, y, w, h }
    }

    pub(super) fn right(&self) -> f32 {
        self.x + self.w
    }

    pub(super) fn bottom(&self) -> f32 {
        self.y + self.h
    }
}

/// Straight 8-bit RGB. The palette arrives as `#rrggbb` strings and stays opaque everywhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Color {
    pub(super) fn parse(value: &str) -> Result<Self, String> {
        let text = value.trim().trim_start_matches('#');
        if text.len() != 6 {
            return Err("palette colour is not #rrggbb".into());
        }
        let value = u32::from_str_radix(text, 16)
            .map_err(|_| String::from("palette colour is not hexadecimal"))?;
        Ok(Self {
            r: ((value >> 16) & 255) as u8,
            g: ((value >> 8) & 255) as u8,
            b: (value & 255) as u8,
        })
    }
}

/// Where a text run starts inside its bounds. The layout never wraps: a run that does not fit is
/// trimmed with an ellipsis by the backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Align {
    Left,
    Right,
    /// Centred on the middle of the bounds, which is what a tick label under a grid line needs.
    Center,
}

/// Everything the layout needs from a rasteriser.
pub(super) trait Painter {
    fn clear(&self, ink: Color);
    fn app_icon(&self, bounds: Rect);
    fn text(&self, value: &str, bounds: Rect, font: usize, ink: Color, align: Align);
    fn text_width(&self, value: &str, font: usize) -> f32;
    fn line(&self, x1: f32, y1: f32, x2: f32, y2: f32, ink: Color, width: f32);
    fn rounded(&self, bounds: Rect, ink: Color, radius: f32);
    fn fill(&self, bounds: Rect, ink: Color);
    fn dot(&self, x: f32, y: f32, radius: f32, ink: Color);
    /// Restrict drawing to `bounds` until [`Painter::unclip`].
    fn clip(&self, bounds: Rect);
    fn unclip(&self);
    /// Multiplier applied to every later draw until it is set back to 1.
    fn opacity(&self, value: f32);
}

/// Resolved colours for the theme this report was asked to use.
#[derive(Debug, Clone, Copy)]
pub(super) struct Palette {
    pub background: Color,
    pub card: Color,
    pub ink: Color,
    pub muted: Color,
    pub border: Color,
    pub accent: Color,
    pub soft: Color,
    pub energy: Color,
    pub series: [Color; 4],
}

impl Palette {
    pub(super) fn new(colors: &VideoPalette) -> Result<Self, String> {
        Ok(Self {
            background: Color::parse(&colors.background)?,
            card: Color::parse(&colors.card)?,
            ink: Color::parse(&colors.ink)?,
            muted: Color::parse(&colors.muted)?,
            border: Color::parse(&colors.border)?,
            accent: Color::parse(&colors.accent)?,
            soft: Color::parse(&colors.soft)?,
            energy: Color::parse(&colors.energy)?,
            series: [
                Color::parse(&colors.series[0])?,
                Color::parse(&colors.series[1])?,
                Color::parse(&colors.series[2])?,
                Color::parse(&colors.series[3])?,
            ],
        })
    }
}

/// Channels the plot can draw, in legend order.
const CHANNELS: [usize; 4] = [0, 1, 2, 3];

/// `HH:MM:SS.mmm`. The plot drops the milliseconds so five ticks do not collide.
fn clock(ms: u64, with_millis: bool) -> String {
    let seconds = ms / 1000;
    let (hours, minutes, rest) = (seconds / 3600, seconds / 60 % 60, seconds % 60);
    if with_millis {
        format!("{hours:02}:{minutes:02}:{rest:02}.{:03}", ms % 1000)
    } else {
        format!("{hours:02}:{minutes:02}:{rest:02}")
    }
}

/// Tick spacing for the time axis: the smallest step that keeps at most five intervals.
///
/// The ladder is the one the app's chart hands to uPlot (`TIME_INCRS` in src/chart.js), so the
/// video and the live chart label the same recording with the same ticks instead of the truncated
/// quarters a plain `total / 4` produced.
fn tick_step_ms(total_ms: u64) -> u64 {
    const STEPS: [u64; 22] = [
        100, 200, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000,
        600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000, 14_400_000, 21_600_000,
        43_200_000, 86_400_000,
    ];
    for step in STEPS {
        if total_ms / step <= 5 {
            return step;
        }
    }
    STEPS[STEPS.len() - 1]
}

/// `HH:MM:SS.d`, the time-axis format of the app's chart (`formatRelativeHMS` in src/utils.js).
fn clock_tenths(ms: u64) -> String {
    let tenths = ms / 100;
    format!(
        "{:02}:{:02}:{:02}.{}",
        tenths / 36_000,
        (tenths % 36_000) / 600,
        (tenths % 600) / 10,
        tenths % 10
    )
}

fn number(value: Option<f64>, unit: &str, digits: usize, missing: &str) -> String {
    value
        .map(|value| format!("{value:.digits$} {unit}"))
        .unwrap_or_else(|| missing.to_owned())
}

fn trim(value: f64) -> String {
    if value.abs() >= 100.0 {
        format!("{value:.0}")
    } else if value.abs() >= 1.0 {
        format!("{value:.2}")
    } else {
        format!("{value:.4}")
    }
}

/// Per-channel value range with the same padding rule the web chart uses: 12% of the span, at
/// least 2.5% of the magnitude so a flat line is not magnified into noise, and a 0.05 floor.
fn range_of(values: impl Iterator<Item = f64>) -> (f64, f64) {
    let mut low = f64::INFINITY;
    let mut high = f64::NEG_INFINITY;
    for value in values {
        if !value.is_finite() {
            continue;
        }
        low = low.min(value);
        high = high.max(value);
    }
    if !low.is_finite() || !high.is_finite() {
        return (0.0, 1.0);
    }
    let pad = ((high - low) * 0.12).max(high.abs() * 0.025).max(0.05);
    let low = if low >= 0.0 {
        (low - pad).max(0.0)
    } else {
        low - pad
    };
    (low, high + pad)
}

fn overview_value(point: &[Option<f64>; 5], channel: usize) -> f64 {
    point[1 + channel].unwrap_or(f64::NAN)
}

fn range(min: Option<f64>, max: Option<f64>, unit: &str, missing: &str) -> String {
    match (min, max) {
        (Some(min), Some(max)) => format!("{}–{} {unit}", trim(min), trim(max)),
        _ => missing.to_owned(),
    }
}

/// Plot geometry for one frame. Kept out of the draw call so the badge de-overlap and the axis
/// maths read the same numbers.
struct PlotLayout {
    left: f32,
    right: f32,
    top: f32,
    bottom: f32,
    total_ms: u64,
}

impl PlotLayout {
    fn x(&self, ms: u64) -> f32 {
        self.left + (ms as f32 / self.total_ms.max(1) as f32) * (self.right - self.left)
    }
}

/// Which of the four channels the report draws. Temperature is dropped when the recording never
/// had one, so the legend cannot promise a curve that does not exist.
fn active_series(payload: &VideoPayload) -> [bool; 4] {
    let mut active = payload.options.visible_series;
    if !payload.summary.has_temperature {
        active[3] = false;
    }
    active
}

/// Draw one frame of the report.
pub(super) fn render(
    painter: &dyn Painter,
    palette: &Palette,
    payload: &VideoPayload,
    frame: usize,
) {
    let labels = &payload.labels;
    let active = active_series(payload);
    let index = frame.min(payload.frames.t.len().saturating_sub(1));
    let elapsed_ms = (payload.frames.t[index].max(0.0) * 1000.0).round() as u64;
    let total_ms = payload.duration_ms().max(1);
    let summary = &payload.summary;
    let image = payload.options.report_type == ReportType::Image;
    let missing = labels.missing.as_str();
    painter.clear(palette.background);

    // Header: one identity block, with the application icon spanning both text rows.
    // The name and title share a left edge; the report does not repeat the recording status.
    painter.app_icon(Rect::new(MARGIN, 36.0, 80.0, 80.0));
    let title_left = MARGIN + 104.0;
    painter.text(
        &labels.eyebrow,
        Rect::new(title_left, 32.0, 1200.0, 30.0),
        1,
        palette.muted,
        Align::Left,
    );
    painter.text(
        &payload.header.title,
        Rect::new(title_left, 69.0, 1200.0, 55.0),
        4,
        palette.ink,
        Align::Left,
    );
    painter.text(
        &clock(if image { total_ms } else { elapsed_ms }, !image),
        Rect::new(1380.0, 28.0, 492.0, 56.0),
        4,
        palette.ink,
        Align::Right,
    );
    if !image {
        painter.text(
            &format!("/ {}", clock(total_ms, false)),
            Rect::new(1510.0, 82.0, 362.0, 28.0),
            1,
            palette.muted,
            Align::Right,
        );
    }
    // Point count makes the report self-describing: two curves with different sampling densities
    // are not comparable otherwise. It sits above the progress bar so the bar never crosses it.
    painter.text(
        &format!("{} {}", summary.points, labels.points),
        Rect::new(1510.0, 110.0, 362.0, 24.0),
        0,
        palette.muted,
        Align::Right,
    );
    if !image {
        painter.rounded(Rect::new(1400.0, 138.0, 472.0, 4.0), palette.border, 2.0);
        let progress = (elapsed_ms as f32 / total_ms as f32).clamp(0.0, 1.0);
        painter.rounded(
            Rect::new(1400.0, 138.0, 472.0 * progress, 4.0),
            palette.accent,
            2.0,
        );
    }

    // Five cards. Values come from the frame timeline, details from the whole-recording roll-up,
    // so one missing sample never blanks the card's context.
    let current_now = payload.frames.current[index].map(f64::abs);
    let readings: [(&str, String, &str, String, Color); 5] = [
        (
            &labels.voltage,
            number(payload.frames.voltage[index], &labels.unit_v, 3, missing),
            &labels.range,
            range(
                summary.min_voltage_v,
                summary.max_voltage_v,
                &labels.unit_v,
                missing,
            ),
            palette.series[0],
        ),
        (
            &labels.current,
            number(current_now, &labels.unit_a, 3, missing),
            &labels.maximum,
            number(summary.peak_current_a, &labels.unit_a, 3, missing),
            palette.series[1],
        ),
        (
            &labels.power,
            number(payload.frames.power[index], &labels.unit_w, 3, missing),
            &labels.average,
            number(summary.average_power_w, &labels.unit_w, 3, missing),
            palette.series[2],
        ),
        (
            &labels.temperature,
            number(
                payload.frames.temperature[index],
                &labels.unit_c,
                1,
                missing,
            ),
            &labels.maximum,
            number(summary.max_temp_c, &labels.unit_c, 1, missing),
            palette.series[3],
        ),
        (
            &labels.capacity,
            format!("{} mAh", trim(summary.capacity_mah)),
            &labels.energy,
            format!("{} {}", trim(summary.energy_wh), labels.unit_wh),
            palette.energy,
        ),
    ];
    let card_width = (CONTENT_W - GAP * (readings.len() - 1) as f32) / readings.len() as f32;
    for (slot, (label, value, caption, detail, ink)) in readings.iter().enumerate() {
        let x = MARGIN + slot as f32 * (card_width + GAP);
        painter.fill(Rect::new(x, 152.0, card_width, 144.0), palette.card);
        if image {
            let (stat, value) = match slot {
                0 => (
                    &labels.average,
                    number(summary.average_voltage_v, &labels.unit_v, 3, missing),
                ),
                1 => (
                    &labels.maximum,
                    number(summary.peak_current_a, &labels.unit_a, 3, missing),
                ),
                2 => (
                    &labels.average,
                    number(summary.average_power_w, &labels.unit_w, 3, missing),
                ),
                3 => (
                    &labels.maximum,
                    number(summary.max_temp_c, &labels.unit_c, 1, missing),
                ),
                _ => (&labels.capacity, value.clone()),
            };
            let heading = if slot == 4 {
                label.to_string()
            } else {
                format!("{label} · {stat}")
            };
            painter.text(
                &heading,
                Rect::new(x + 24.0, 166.0, card_width - 48.0, 30.0),
                1,
                palette.muted,
                Align::Left,
            );
            let font = (0..=4)
                .rev()
                .find(|&font| painter.text_width(&value, font) <= card_width - 48.0)
                .unwrap_or(0);
            painter.text(
                &value,
                Rect::new(x + 24.0, 204.0, card_width - 48.0, 50.0),
                font,
                *ink,
                Align::Left,
            );
            let detail = if slot == 0 || slot == 4 {
                format!("{caption}  {detail}")
            } else {
                String::new()
            };
            painter.text(
                &detail,
                Rect::new(x + 24.0, 261.0, card_width - 48.0, 26.0),
                0,
                palette.muted,
                Align::Left,
            );
            continue;
        }
        painter.dot(x + 24.0, 181.0, 4.0, *ink);
        // Names and summaries own disjoint columns, even in the longer translations.
        painter.text(
            label,
            Rect::new(x + 36.0, 168.0, 132.0, 30.0),
            1,
            palette.muted,
            Align::Left,
        );
        painter.text(
            caption,
            Rect::new(x + 180.0, 166.0, card_width - 204.0, 26.0),
            0,
            palette.muted,
            Align::Right,
        );
        painter.text(
            detail,
            Rect::new(x + 24.0, 194.0, card_width - 48.0, 26.0),
            0,
            palette.muted,
            Align::Right,
        );
        let font = (0..FONT_SIZES.len())
            .rev()
            .find(|&font| painter.text_width(value, font) <= card_width - 48.0)
            .unwrap_or(0);
        // Keep a shared lower edge when a wide number needs a smaller font.
        let inset = FONT_SIZES[5] - FONT_SIZES[font];
        painter.text(
            value,
            Rect::new(x + 24.0, 228.0 + inset, card_width - 48.0, 58.0 - inset),
            font,
            *ink,
            Align::Left,
        );
    }

    // Reserve only the rows in use: eight breakpoints still leave a tall plot.
    let rows = if payload.options.show_marker_details {
        payload.markers.len().div_ceil(4)
    } else {
        0
    };
    let main_bottom = if image && payload.options.image_layout == ImageLayout::Long && rows > 0 {
        816.0
    } else {
        CANVAS_H
            - 40.0
            - if rows == 0 {
                0.0
            } else {
                20.0 + rows as f32 * 144.0 + (rows - 1) as f32 * GAP
            }
    };
    plot(
        painter,
        palette,
        payload,
        &active,
        index,
        Rect::new(MARGIN, 316.0, CONTENT_W, main_bottom - 316.0),
    );
    if payload.options.show_marker_details {
        breakpoints(painter, palette, payload, main_bottom + 20.0);
    }
}

fn plot(
    painter: &dyn Painter,
    palette: &Palette,
    payload: &VideoPayload,
    active: &[bool; 4],
    index: usize,
    bounds: Rect,
) {
    let labels = &payload.labels;
    let total_ms = payload.duration_ms().max(1);
    let image = payload.options.report_type == ReportType::Image;
    let cursor_ms = if image {
        total_ms
    } else {
        (payload.frames.t[index].max(0.0) * 1000.0).round() as u64
    };
    painter.fill(bounds, palette.card);
    painter.text(
        &labels.chart,
        Rect::new(bounds.x + 24.0, bounds.y + 20.0, 180.0, 36.0),
        2,
        palette.ink,
        Align::Left,
    );
    let names = [
        &labels.voltage,
        &labels.current,
        &labels.power,
        &labels.temperature,
    ];
    for (slot, channel) in CHANNELS
        .into_iter()
        .filter(|channel| active[*channel])
        .enumerate()
    {
        let x = bounds.x + 244.0 + slot as f32 * 218.0;
        painter.line(
            x,
            bounds.y + 39.0,
            x + 22.0,
            bounds.y + 39.0,
            palette.series[channel],
            3.0,
        );
        painter.text(
            names[channel],
            Rect::new(x + 32.0, bounds.y + 24.0, 184.0, 32.0),
            1,
            palette.series[channel],
            Align::Left,
        );
    }
    let axis_count = active[1..].iter().filter(|value| **value).count() as f32;
    let layout = PlotLayout {
        left: bounds.x + 82.0,
        right: bounds.right() - 32.0 - axis_count * AXIS_STRIDE,
        top: bounds.y + 92.0,
        bottom: bounds.bottom() - 60.0,
        total_ms,
    };
    // Four even rows for the value axes; the time axis below gets its own round ticks so that
    // every vertical grid line sits exactly under its label.
    for row in 0..=4 {
        let y = layout.top + row as f32 / 4.0 * (layout.bottom - layout.top);
        painter.line(layout.left, y, layout.right, y, palette.border, 1.0);
    }
    let step = tick_step_ms(total_ms);
    let mut ticks = Vec::new();
    let mut at = 0u64;
    while at < total_ms {
        ticks.push(at);
        at += step;
    }
    ticks.push(total_ms);
    // Drop a tick that would crowd the closing label when the duration is not a whole multiple.
    if ticks.len() >= 2 && total_ms - ticks[ticks.len() - 2] < step / 2 {
        ticks.remove(ticks.len() - 2);
    }
    for at in ticks {
        let x = layout.x(at);
        painter.line(x, layout.top, x, layout.bottom, palette.border, 1.0);
        painter.text(
            &clock_tenths(at),
            Rect::new(x - 80.0, layout.bottom + 17.0, 160.0, 28.0),
            0,
            palette.muted,
            Align::Center,
        );
    }
    for channel in CHANNELS.into_iter().filter(|channel| active[*channel]) {
        let (low, high) = range_of(
            payload
                .overview
                .points
                .iter()
                .map(|point| overview_value(point, channel)),
        );
        let y = |value: f64| {
            layout.bottom - ((value - low) / (high - low)) as f32 * (layout.bottom - layout.top)
        };
        for tick in 0..=4 {
            let value = high - (high - low) * tick as f64 / 4.0;
            // Centre the 18 px label on its grid line: draw from half a line box above it.
            let at = layout.top + tick as f32 / 4.0 * (layout.bottom - layout.top) - 10.5;
            if channel == CHANNELS[0] {
                painter.text(
                    &format!("{value:.2}"),
                    Rect::new(bounds.x + 4.0, at, 64.0, 30.0),
                    0,
                    palette.series[channel],
                    Align::Right,
                );
            } else {
                let slot = active[1..channel].iter().filter(|value| **value).count() as f32;
                painter.text(
                    &format!("{value:.2}"),
                    Rect::new(layout.right + 12.0 + slot * AXIS_STRIDE, at, 74.0, 30.0),
                    0,
                    palette.series[channel],
                    Align::Left,
                );
            }
        }
        // Two passes: the whole recording at low opacity, then the elapsed part at full opacity.
        // Clipping only changes drawing, never which sample belongs to a frame.
        let trace = || {
            let limit = (payload.overview_bucket_ms() * 3).max(15_000) as f64;
            for pair in payload.overview.points.windows(2) {
                let gap = pair[1][0].unwrap_or(0.0) - pair[0][0].unwrap_or(0.0);
                if gap > limit {
                    continue;
                }
                let from = overview_value(&pair[0], channel);
                let to = overview_value(&pair[1], channel);
                if !from.is_finite() || !to.is_finite() {
                    continue;
                }
                painter.line(
                    layout.x(pair[0][0].unwrap_or(0.0).max(0.0) as u64),
                    y(from),
                    layout.x(pair[1][0].unwrap_or(0.0).max(0.0) as u64),
                    y(to),
                    palette.series[channel],
                    2.8,
                );
            }
        };
        painter.clip(Rect::new(
            layout.left,
            layout.top,
            layout.right - layout.left,
            layout.bottom - layout.top,
        ));
        painter.opacity(0.22);
        trace();
        painter.opacity(1.0);
        painter.unclip();
        let head = (layout.x(cursor_ms) - layout.left).max(0.0);
        painter.clip(Rect::new(
            layout.left,
            layout.top,
            head,
            layout.bottom - layout.top,
        ));
        trace();
        painter.unclip();
        if let Some(value) = payload.frames.channel(channel)[index].filter(|_| !image) {
            painter.dot(layout.x(cursor_ms), y(value), 5.5, palette.card);
            painter.dot(layout.x(cursor_ms), y(value), 3.5, palette.series[channel]);
        }
    }
    if !active.iter().any(|value| *value) {
        painter.text(
            &labels.no_series,
            Rect::new(
                (layout.left + layout.right) / 2.0 - 80.0,
                (layout.top + layout.bottom) / 2.0,
                180.0,
                36.0,
            ),
            2,
            palette.muted,
            Align::Left,
        );
    }

    // Breakpoint badges de-overlap by nudging the number, never the time line.
    let mut badges: Vec<(usize, f32)> = payload
        .markers
        .iter()
        .enumerate()
        .filter(|_| payload.options.show_markers)
        .map(|(slot, marker)| {
            (
                slot,
                layout
                    .x((marker.t_s.max(0.0) * 1000.0).round() as u64)
                    .clamp(layout.left + 14.0, layout.right - 14.0),
            )
        })
        .collect();
    badges.sort_by(|a, b| a.1.total_cmp(&b.1));
    // Dense long-image reports retain every marker line; only number labels need thinning.
    let mut last_label = f32::NEG_INFINITY;
    for (slot, _) in &badges {
        let at = layout.x((payload.markers[*slot].t_s.max(0.0) * 1000.0).round() as u64);
        let mut y = layout.top;
        while y < layout.bottom {
            painter.line(at, y, at, (y + 4.0).min(layout.bottom), palette.border, 1.5);
            y += 10.0;
        }
    }
    if badges.len() > 8 {
        badges.retain(|(_, x)| {
            if *x < last_label + 42.0 {
                return false;
            }
            last_label = *x;
            true
        });
    }
    for slot in 1..badges.len() {
        badges[slot].1 = badges[slot].1.max(badges[slot - 1].1 + 30.0);
    }
    let mut limit = layout.right - 14.0;
    for (_, x) in badges.iter_mut().rev() {
        *x = x.min(limit);
        limit = *x - 30.0;
    }
    for (slot, x) in badges {
        let at = layout.x((payload.markers[slot].t_s.max(0.0) * 1000.0).round() as u64);
        painter.line(at, layout.top, x, layout.top - 9.0, palette.border, 1.0);
        painter.rounded(
            Rect::new(x - 12.0, layout.top - 28.0, 24.0, 24.0),
            palette.soft,
            8.0,
        );
        painter.text(
            &(slot + 1).to_string(),
            Rect::new(x - 12.0, layout.top - 28.0, 24.0, 26.0),
            0,
            palette.accent,
            Align::Center,
        );
    }
    if !image {
        painter.line(
            layout.x(cursor_ms),
            layout.top,
            layout.x(cursor_ms),
            layout.bottom,
            palette.ink,
            1.7,
        );
    }
}

fn breakpoints(painter: &dyn Painter, palette: &Palette, payload: &VideoPayload, top: f32) {
    let labels = &payload.labels;
    let missing = labels.missing.as_str();
    let columns = payload.markers.len().clamp(1, 4);
    let width = (CONTENT_W - (columns - 1) as f32 * GAP) / columns as f32;
    let units = [
        (&labels.voltage, &labels.unit_v, 2usize),
        (&labels.current, &labels.unit_a, 3),
        (&labels.power, &labels.unit_w, 3),
        (&labels.temperature, &labels.unit_c, 1),
    ];
    for (slot, marker) in payload.markers.iter().enumerate() {
        let x = MARGIN + (slot % columns) as f32 * (width + GAP);
        let y = top + (slot / columns) as f32 * 160.0;
        painter.fill(Rect::new(x, y, width, 144.0), palette.card);
        painter.text(
            &marker.label,
            Rect::new(x + 20.0, y + 10.0, width - 192.0, 30.0),
            1,
            palette.accent,
            Align::Left,
        );
        painter.text(
            &clock((marker.t_s.max(0.0) * 1000.0).round() as u64, true),
            Rect::new(x + width - 178.0, y + 11.0, 158.0, 29.0),
            0,
            palette.muted,
            Align::Right,
        );
        let values = [
            marker.voltage,
            marker.current.map(f64::abs),
            marker.power,
            marker.temperature,
        ];
        for (cell, (label, unit, digits)) in units.iter().enumerate() {
            let text = number(values[cell], unit, *digits, missing);
            let columns = if width >= 700.0 { 4 } else { 2 };
            let step = (width - 40.0) / columns as f32;
            let cell_x = x + 20.0 + (cell % columns) as f32 * step;
            let cell_y = y + 44.0 + (cell / columns) as f32 * 46.0;
            painter.text(
                label,
                Rect::new(cell_x, cell_y, step - 12.0, 24.0),
                0,
                palette.muted,
                Align::Left,
            );
            painter.text(
                &text,
                Rect::new(cell_x, cell_y + 23.0, step - 12.0, 28.0),
                1,
                palette.series[cell],
                Align::Left,
            );
        }
    }
}
