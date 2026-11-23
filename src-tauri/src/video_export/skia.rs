// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-only
// For original project contributions; see COPYRIGHT.
//! Portable rasteriser for the video report.
//!
//! The shared layout in [super::scene] is drawn with tiny-skia (geometry) and system fonts
//! (glyphs), so macOS and Linux produce the same picture as Direct2D on Windows without any
//! platform drawing API. It is ordinary Rust, which is why the Windows test suite renders through
//! it as well and compares the result against the Direct2D backend.
//!
//! Coordinates stay on the 1920 x 1080 logical canvas and are multiplied by the scale factor on
//! the way into the pixmap, mirroring the transform the Direct2D target is given.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::OnceLock;

use ab_glyph::{Font, FontVec, GlyphId, OutlineCurve};
use tiny_skia::{
    FillRule, FilterQuality, LineCap, LineJoin, Paint, Path, PathBuilder, Pixmap, PixmapPaint,
    Stroke, Transform,
};

use super::model::{VideoOptions, VideoPalette, VideoPayload};
use super::scene::{self, Align, Color, Painter, Rect, FONT_SIZES};

/// Font families in order of preference; the first one the host actually has wins, the rest act
/// as per-glyph fallbacks (a CJK label must not turn into boxes because the Latin face lacks it).
const FAMILIES: &[&str] = &[
    "Microsoft YaHei UI",
    "PingFang SC",
    "Hiragino Sans GB",
    "Noto Sans CJK SC",
    "Source Han Sans SC",
    "WenQuanYi Micro Hei",
    "Segoe UI",
    "Helvetica Neue",
    "DejaVu Sans",
];

/// One loaded face plus the identifier the glyph cache keys on.
struct Face {
    id: fontdb::ID,
    font: Rc<FontVec>,
}

impl Clone for Face {
    fn clone(&self) -> Self {
        Self {
            id: self.id,
            font: Rc::clone(&self.font),
        }
    }
}

struct Fonts {
    normal: Vec<Face>,
    strong: Vec<Face>,
}

fn database() -> &'static fontdb::Database {
    static DB: OnceLock<fontdb::Database> = OnceLock::new();
    DB.get_or_init(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        db
    })
}

fn load_face(db: &fontdb::Database, id: fontdb::ID) -> Option<Face> {
    db.with_face_data(id, |data, index| {
        FontVec::try_from_vec_and_index(data.to_vec(), index)
            .ok()
            .map(|font| Face {
                id,
                font: Rc::new(font),
            })
    })
    .flatten()
}

/// Every family that resolves for one weight, primary first.
fn faces(db: &fontdb::Database, weight: fontdb::Weight) -> Vec<Face> {
    let mut out: Vec<Face> = Vec::new();
    for family in FAMILIES {
        let query = fontdb::Query {
            families: &[fontdb::Family::Name(family)],
            weight,
            stretch: fontdb::Stretch::Normal,
            style: fontdb::Style::Normal,
        };
        let Some(id) = db.query(&query) else { continue };
        if out.iter().any(|face| face.id == id) {
            continue;
        }
        if let Some(face) = load_face(db, id) {
            out.push(face);
        }
    }
    out
}

impl Fonts {
    fn load() -> Result<Self, String> {
        let db = database();
        let normal = faces(db, fontdb::Weight::NORMAL);
        let strong = faces(db, fontdb::Weight::BOLD);
        if normal.is_empty() && strong.is_empty() {
            return Err("this host has no usable system font for the report".into());
        }
        Ok(Self {
            normal: if normal.is_empty() {
                strong.clone()
            } else {
                normal
            },
            strong: if strong.is_empty() {
                faces(db, fontdb::Weight::NORMAL)
            } else {
                strong
            },
        })
    }
}

fn sk_color(ink: Color) -> tiny_skia::Color {
    tiny_skia::Color::from_rgba8(ink.r, ink.g, ink.b, 255)
}

/// Glyph outlines keyed by face, glyph and pixel size; the transform is applied per draw.
type GlyphCache = HashMap<(fontdb::ID, u16, u32), Option<Rc<Path>>>;

/// Rasteriser state shared by every frame of one export.
pub(super) struct Canvas {
    pixmap: RefCell<Pixmap>,
    app_icon: Pixmap,
    scale: f32,
    palette: scene::Palette,
    fonts: Fonts,
    clips: RefCell<Vec<Rect>>,
    opacity: Cell<f32>,
    glyphs: RefCell<GlyphCache>,
}

impl Canvas {
    pub(super) fn new(options: &VideoOptions, colors: &VideoPalette) -> Result<Self, String> {
        let pixmap = Pixmap::new(options.width, options.height)
            .ok_or_else(|| "cannot allocate the report canvas".to_owned())?;
        Ok(Self {
            pixmap: RefCell::new(pixmap),
            app_icon: Pixmap::decode_png(scene::APP_ICON)
                .map_err(|error| format!("cannot decode the application icon: {error}"))?,
            scale: options.canvas_scale(),
            palette: scene::Palette::new(colors)?,
            fonts: Fonts::load()?,
            clips: RefCell::new(Vec::new()),
            opacity: Cell::new(1.0),
            glyphs: RefCell::new(HashMap::new()),
        })
    }

    /// Draw one frame of the shared layout.
    pub(super) fn draw_frame(&self, payload: &VideoPayload, index: usize) {
        scene::render(self, &self.palette, payload, index);
    }

    #[cfg_attr(windows, allow(dead_code))]
    pub(super) fn copy_pixels(&self, out: &mut [u8]) {
        out.copy_from_slice(self.pixmap.borrow().data());
    }

    #[cfg_attr(windows, allow(dead_code))]
    pub(super) fn with_pixels<R>(&self, f: impl FnOnce(&[u8]) -> R) -> R {
        f(self.pixmap.borrow().data())
    }

    pub(super) fn save_png(&self, path: &std::path::Path) -> Result<(), String> {
        self.pixmap
            .borrow()
            .save_png(path)
            .map_err(|error| format!("cannot write the frame image: {error}"))
    }

    fn device(&self, value: f32) -> f32 {
        value * self.scale
    }

    fn paint(&self, ink: Color) -> Paint<'static> {
        let mut paint = Paint::default();
        let alpha = (self.opacity.get().clamp(0.0, 1.0) * 255.0).round() as u8;
        paint.set_color_rgba8(ink.r, ink.g, ink.b, alpha);
        paint.anti_alias = true;
        paint
    }

    fn clip_bounds(&self) -> Option<Rect> {
        self.clips.borrow().last().copied()
    }

    /// Visible part of an axis aligned rect, in device pixels.
    fn visible(&self, bounds: Rect) -> Option<tiny_skia::Rect> {
        let mut left = self.device(bounds.x);
        let mut top = self.device(bounds.y);
        let mut right = self.device(bounds.right());
        let mut bottom = self.device(bounds.bottom());
        if let Some(clip) = self.clip_bounds() {
            left = left.max(clip.x);
            top = top.max(clip.y);
            right = right.min(clip.right());
            bottom = bottom.min(clip.bottom());
        }
        if right <= left || bottom <= top {
            return None;
        }
        tiny_skia::Rect::from_ltrb(left, top, right, bottom)
    }

    /// Clip a segment to the active clip rect (Liang-Barsky).
    fn clip_segment(&self, from: (f32, f32), to: (f32, f32)) -> Option<((f32, f32), (f32, f32))> {
        let Some(clip) = self.clip_bounds() else {
            return Some((from, to));
        };
        let (mut x0, mut y0) = from;
        let (x1, y1) = to;
        let dx = x1 - x0;
        let dy = y1 - y0;
        let mut t0 = 0.0f32;
        let mut t1 = 1.0f32;
        for (p, q) in [
            (-dx, x0 - clip.x),
            (dx, clip.right() - x0),
            (-dy, y0 - clip.y),
            (dy, clip.bottom() - y0),
        ] {
            if p == 0.0 {
                if q < 0.0 {
                    return None;
                }
            } else {
                let t = q / p;
                if p < 0.0 {
                    t0 = t0.max(t);
                } else {
                    t1 = t1.min(t);
                }
                if t0 > t1 {
                    return None;
                }
            }
        }
        if t0 > 0.0 {
            x0 += t0 * dx;
            y0 += t0 * dy;
        }
        let mut x1 = x1;
        let mut y1 = y1;
        if t1 < 1.0 {
            x1 = from.0 + t1 * dx;
            y1 = from.1 + t1 * dy;
        }
        Some(((x0, y0), (x1, y1)))
    }

    fn unit(&self, face: &Face, size: f32) -> f32 {
        size / face
            .font
            .units_per_em()
            .unwrap_or_else(|| face.font.height_unscaled())
    }

    fn advance(&self, face: &Face, gid: GlyphId, size: f32) -> f32 {
        face.font.h_advance_unscaled(gid) * self.unit(face, size)
    }

    fn glyph_of(&self, group: &[Face], ch: char) -> Option<(usize, GlyphId)> {
        for (slot, face) in group.iter().enumerate() {
            let gid = face.font.glyph_id(ch);
            if gid.0 != 0 {
                return Some((slot, gid));
            }
        }
        group.first().map(|face| (0, face.font.glyph_id(ch)))
    }

    fn measure(&self, group: &[Face], chars: &[char], size: f32) -> f32 {
        let mut width = 0.0;
        for ch in chars {
            if let Some((slot, gid)) = self.glyph_of(group, *ch) {
                width += self.advance(&group[slot], gid, size);
            }
        }
        width
    }

    fn glyph_path(&self, face: &Face, gid: GlyphId, size: f32) -> Option<Rc<Path>> {
        let key = (face.id, gid.0, size.to_bits());
        if let Some(hit) = self.glyphs.borrow().get(&key) {
            return hit.clone();
        }
        let built = self.build_path(face, gid, size).map(Rc::new);
        self.glyphs.borrow_mut().insert(key, built.clone());
        built
    }

    fn build_path(&self, face: &Face, gid: GlyphId, size: f32) -> Option<Path> {
        // Font outlines are y up from the baseline; pixmaps are y down, so the sign flips here.
        // Curves continue where the previous one ended: only the contour start gets a move_to,
        // otherwise every segment becomes its own (zero area) subpath.
        let unit = self.unit(face, size);
        let outline = face.font.outline(gid)?;
        let mut builder = PathBuilder::new();
        let mut current: Option<(f32, f32)> = None;
        for curve in outline.curves {
            let start = match curve {
                OutlineCurve::Line(a, _) => (a.x * unit, -a.y * unit),
                OutlineCurve::Quad(a, _, _) => (a.x * unit, -a.y * unit),
                OutlineCurve::Cubic(a, _, _, _) => (a.x * unit, -a.y * unit),
            };
            let joined = current.is_some_and(|point| {
                (point.0 - start.0).abs() < 0.01 && (point.1 - start.1).abs() < 0.01
            });
            if !joined {
                if current.is_some() {
                    builder.close();
                }
                builder.move_to(start.0, start.1);
            }
            match curve {
                OutlineCurve::Line(_, b) => {
                    let b = (b.x * unit, -b.y * unit);
                    builder.line_to(b.0, b.1);
                    current = Some(b);
                }
                OutlineCurve::Quad(_, b, c) => {
                    let b = (b.x * unit, -b.y * unit);
                    let c = (c.x * unit, -c.y * unit);
                    builder.quad_to(b.0, b.1, c.0, c.1);
                    current = Some(c);
                }
                OutlineCurve::Cubic(_, b, c, d) => {
                    let b = (b.x * unit, -b.y * unit);
                    let c = (c.x * unit, -c.y * unit);
                    let d = (d.x * unit, -d.y * unit);
                    builder.cubic_to(b.0, b.1, c.0, c.1, d.0, d.1);
                    current = Some(d);
                }
            }
        }
        if current.is_some() {
            builder.close();
        }
        builder.finish()
    }

    fn rounded_path(bounds: tiny_skia::Rect, radius: f32) -> Option<Path> {
        let radius = radius.min(bounds.width().min(bounds.height()) / 2.0);
        if radius <= 0.0 {
            let mut builder = PathBuilder::new();
            builder.push_rect(bounds);
            return builder.finish();
        }
        let (x0, y0, x1, y1) = (bounds.left(), bounds.top(), bounds.right(), bounds.bottom());
        let mut builder = PathBuilder::new();
        builder.move_to(x0 + radius, y0);
        builder.line_to(x1 - radius, y0);
        builder.quad_to(x1, y0, x1, y0 + radius);
        builder.line_to(x1, y1 - radius);
        builder.quad_to(x1, y1, x1 - radius, y1);
        builder.line_to(x0 + radius, y1);
        builder.quad_to(x0, y1, x0, y1 - radius);
        builder.line_to(x0, y0 + radius);
        builder.quad_to(x0, y0, x0 + radius, y0);
        builder.close();
        builder.finish()
    }
}

impl Painter for Canvas {
    fn clear(&self, ink: Color) {
        self.pixmap.borrow_mut().fill(sk_color(ink));
    }

    fn app_icon(&self, bounds: Rect) {
        let transform = Transform::from_scale(
            self.device(bounds.w) / self.app_icon.width() as f32,
            self.device(bounds.h) / self.app_icon.height() as f32,
        )
        .post_translate(self.device(bounds.x), self.device(bounds.y));
        let paint = PixmapPaint {
            quality: FilterQuality::Bilinear,
            ..Default::default()
        };
        self.pixmap
            .borrow_mut()
            .draw_pixmap(0, 0, self.app_icon.as_ref(), &paint, transform, None);
    }

    fn text(&self, value: &str, bounds: Rect, font: usize, ink: Color, align: Align) {
        if value.is_empty() {
            return;
        }
        let size = self.device(FONT_SIZES[font]);
        let group = if FONT_SIZES[font] >= 24.0 {
            &self.fonts.strong
        } else {
            &self.fonts.normal
        };
        if group.is_empty() {
            return;
        }
        let width = self.device(bounds.w);
        let mut chars: Vec<char> = value.chars().collect();
        let mut measured = self.measure(group, &chars, size);
        if measured > width && chars.len() > 1 {
            chars.push('…');
            loop {
                measured = self.measure(group, &chars, size);
                if measured <= width || chars.len() <= 1 {
                    break;
                }
                chars.remove(chars.len() - 2);
            }
        }
        let left = self.device(bounds.x);
        let mut pen = match align {
            Align::Left => left,
            Align::Right => left + width - measured,
            Align::Center => left + (width - measured) / 2.0,
        };
        let ascent = group[0].font.ascent_unscaled() * self.unit(&group[0], size);
        let baseline = self.device(bounds.y) + ascent;
        let paint = self.paint(ink);
        let clip = self.clip_bounds();
        let mut pixmap = self.pixmap.borrow_mut();
        for ch in chars {
            let Some((slot, gid)) = self.glyph_of(group, ch) else {
                continue;
            };
            let face = &group[slot];
            let advance = self.advance(face, gid, size);
            if let Some(path) = self.glyph_path(face, gid, size) {
                let visible = match clip {
                    Some(clip) => {
                        pen + advance >= clip.x
                            && pen <= clip.right()
                            && baseline >= clip.y
                            && baseline - size <= clip.bottom()
                    }
                    None => true,
                };
                if visible {
                    if let Some(moved) =
                        Path::clone(&path).transform(Transform::from_translate(pen, baseline))
                    {
                        pixmap.fill_path(
                            &moved,
                            &paint,
                            FillRule::Winding,
                            Transform::identity(),
                            None,
                        );
                    }
                }
            }
            pen += advance;
        }
    }

    fn text_width(&self, value: &str, font: usize) -> f32 {
        let group = if FONT_SIZES[font] >= 24.0 {
            &self.fonts.strong
        } else {
            &self.fonts.normal
        };
        self.measure(group, &value.chars().collect::<Vec<_>>(), FONT_SIZES[font])
    }

    fn line(&self, x1: f32, y1: f32, x2: f32, y2: f32, ink: Color, width: f32) {
        let from = (self.device(x1), self.device(y1));
        let to = (self.device(x2), self.device(y2));
        let Some((from, to)) = self.clip_segment(from, to) else {
            return;
        };
        if from == to {
            return;
        }
        let mut builder = PathBuilder::new();
        builder.move_to(from.0, from.1);
        builder.line_to(to.0, to.1);
        let Some(path) = builder.finish() else { return };
        let paint = self.paint(ink);
        let stroke = Stroke {
            width: self.device(width).max(1.0),
            line_cap: LineCap::Butt,
            line_join: LineJoin::Miter,
            miter_limit: 4.0,
            dash: None,
        };
        self.pixmap
            .borrow_mut()
            .stroke_path(&path, &paint, &stroke, Transform::identity(), None);
    }

    fn rounded(&self, bounds: Rect, ink: Color, radius: f32) {
        let Some(visible) = self.visible(bounds) else {
            return;
        };
        let Some(path) = Self::rounded_path(visible, self.device(radius)) else {
            return;
        };
        let paint = self.paint(ink);
        self.pixmap.borrow_mut().fill_path(
            &path,
            &paint,
            FillRule::Winding,
            Transform::identity(),
            None,
        );
    }

    fn fill(&self, bounds: Rect, ink: Color) {
        let Some(visible) = self.visible(bounds) else {
            return;
        };
        let paint = self.paint(ink);
        self.pixmap
            .borrow_mut()
            .fill_rect(visible, &paint, Transform::identity(), None);
    }

    fn dot(&self, x: f32, y: f32, radius: f32, ink: Color) {
        let (cx, cy, r) = (self.device(x), self.device(y), self.device(radius));
        let Some(oval) = tiny_skia::Rect::from_ltrb(cx - r, cy - r, cx + r, cy + r) else {
            return;
        };
        if let Some(clip) = self.clip_bounds() {
            if oval.right() < clip.x
                || oval.left() > clip.right()
                || oval.bottom() < clip.y
                || oval.top() > clip.bottom()
            {
                return;
            }
        }
        let mut builder = PathBuilder::new();
        builder.push_oval(oval);
        let Some(path) = builder.finish() else { return };
        let paint = self.paint(ink);
        self.pixmap.borrow_mut().fill_path(
            &path,
            &paint,
            FillRule::Winding,
            Transform::identity(),
            None,
        );
    }

    fn clip(&self, bounds: Rect) {
        let mut clips = self.clips.borrow_mut();
        let mut next = Rect::new(
            self.device(bounds.x),
            self.device(bounds.y),
            self.device(bounds.w),
            self.device(bounds.h),
        );
        if let Some(current) = clips.last() {
            let left = next.x.max(current.x);
            let top = next.y.max(current.y);
            let right = next.right().min(current.right());
            let bottom = next.bottom().min(current.bottom());
            next = Rect::new(left, top, (right - left).max(0.0), (bottom - top).max(0.0));
        }
        clips.push(next);
    }

    fn unclip(&self) {
        self.clips.borrow_mut().pop();
    }

    fn opacity(&self, value: f32) {
        self.opacity.set(value);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::video_export::model::{
        Codec, Format, Theme, VideoFrames, VideoHeader, VideoLabels, VideoMarker, VideoOverview,
        VideoSummary,
    };

    fn payload() -> VideoPayload {
        let options = VideoOptions {
            report_type: crate::video_export::model::ReportType::Video,
            image_layout: crate::video_export::model::ImageLayout::Widescreen,
            show_markers: true,
            show_marker_details: true,
            width: 640,
            height: 360,
            fps: 10,
            codec: Codec::H264,
            acceleration: crate::video_export::model::Acceleration::Auto,
            quality: crate::video_export::model::Quality::High,
            format: Format::Mp4,
            duration_s: 1,
            theme: Theme::Dark,
            visible_series: [true; 4],
        };
        let frames = options.frames();
        VideoPayload {
            options,
            header: VideoHeader {
                title: "WITRN K2 / POWER-Z KM003C".into(),
                status: "Recorded".into(),
                status_kind: "complete".into(),
            },
            labels: VideoLabels {
                eyebrow: "laPower".into(),
                chart: "Output curves".into(),
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
                background: "#292929".into(),
                card: "#333333".into(),
                ink: "#ffffff".into(),
                muted: "#d6d6d6".into(),
                border: "#525252".into(),
                accent: "#479ef5".into(),
                soft: "#383838".into(),
                energy: "#d161c4".into(),
                series: [
                    "#65ade5".into(),
                    "#34d889".into(),
                    "#f98845".into(),
                    "#dc5e62".into(),
                ],
            },
            summary: VideoSummary {
                average_voltage_v: Some(5.0),
                elapsed_s: 1.0,
                points: frames as u64,
                average_power_w: Some(7.5),
                min_voltage_v: Some(4.9),
                max_voltage_v: Some(5.1),
                peak_current_a: Some(2.0),
                max_temp_c: Some(33.4),
                energy_wh: 0.0021,
                capacity_mah: 0.42,
                has_temperature: true,
            },
            overview: VideoOverview {
                bucket_ms: 100,
                points: vec![
                    [Some(0.0), Some(5.0), Some(0.4), Some(2.0), Some(28.0)],
                    [Some(500.0), Some(5.05), Some(1.6), Some(8.1), Some(31.0)],
                    [Some(1000.0), Some(5.0), Some(1.4), Some(7.0), Some(33.4)],
                ],
            },
            frames: VideoFrames {
                t: (0..frames).map(|index| index as f64 / 10.0).collect(),
                voltage: vec![Some(5.0); frames],
                current: vec![Some(1.5); frames],
                power: vec![Some(7.5); frames],
                temperature: vec![Some(31.0); frames],
            },
            markers: vec![VideoMarker {
                t_s: 0.5,
                label: "load step".into(),
                voltage: Some(5.05),
                current: Some(1.6),
                power: Some(8.1),
                temperature: Some(31.0),
            }],
        }
    }

    #[test]
    fn renders_a_readable_frame_with_the_requested_palette() {
        let value = payload();
        let canvas = Canvas::new(&value.options, &value.palette).unwrap();
        canvas.draw_frame(&value, 3);
        let mut pixels = vec![0u8; 640 * 360 * 4];
        canvas.copy_pixels(&mut pixels);
        // The canvas is cleared with the background colour, so the corner is exact.
        assert_eq!(&pixels[0..4], &[0x29, 0x29, 0x29, 0xff]);
        let mut colours = std::collections::HashSet::new();
        for chunk in pixels.chunks(4) {
            colours.insert([chunk[0], chunk[1], chunk[2]]);
        }
        assert!(
            colours.len() > 30,
            "the frame looks blank: {} colours",
            colours.len()
        );
        let png = std::env::temp_dir().join("lapower-frame.png");
        canvas.save_png(&png).unwrap();
        assert!(std::fs::metadata(&png).unwrap().len() > 4096);
    }
}
