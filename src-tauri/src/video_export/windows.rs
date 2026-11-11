// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-only
// For original project contributions; see COPYRIGHT.
//! Direct2D drawing target and Media Foundation encoding for the video report.
//!
//! Windows draws the shared layout from [`super::scene`] with Direct2D / DirectWrite onto a WIC
//! bitmap and hands the result to Media Foundation, which turns the frames into H.264 or HEVC. The
//! GPU path in [`super::gpu`] draws the same layout straight onto a D3D11 texture; this module
//! keeps the CPU fallback because a report export must work on hosts without a video processor.
//!
//! Which encoder Media Foundation actually used is reported, so a hardware claim is only ever made
//! when hardware was really used.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use windows::core::{Interface, HSTRING, PCWSTR};
use windows::Win32::Graphics::Direct2D::{Common::*, *};
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Graphics::DirectWrite::*;
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::Graphics::Imaging::*;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::*;
use windows_numerics::{Matrix3x2, Vector2};

use super::model::{
    Acceleration, Codec, VideoCapability, VideoOptions, VideoPalette, VideoPayload,
};
use super::scene::{self, Align, Color, Painter, Rect, FONT_SIZES};

use super::failure::{Context, Failure, Result};
use super::gpu::GpuFrames;

/// Serialises every consumer of Media Foundation and Direct2D in this process: sink writers and
/// the COM apartment are process-wide, and two concurrent probes would corrupt both.
static ENCODER: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Kept next to the ladder in [`super::scene`]: the layout picks a size, Windows picks the face.
const FONT_FAMILY: &str = "Microsoft YaHei UI";

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn color(ink: Color) -> D2D1_COLOR_F {
    D2D1_COLOR_F {
        r: f32::from(ink.r) / 255.0,
        g: f32::from(ink.g) / 255.0,
        b: f32::from(ink.b) / 255.0,
        a: 1.0,
    }
}

fn d2d_rect(bounds: Rect) -> D2D_RECT_F {
    D2D_RECT_F {
        left: bounds.x,
        top: bounds.y,
        right: bounds.right(),
        bottom: bounds.bottom(),
    }
}

/// COM apartment plus Media Foundation for one encoding session.
struct MediaSession;

impl MediaSession {
    fn start() -> Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .ctx("cannot initialise the video COM apartment")?;
            if let Err(error) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
                CoUninitialize();
                return Err(Failure(format!(
                    "Windows Media Foundation is unavailable: {error}"
                )));
            }
        }
        Ok(Self)
    }
}

impl Drop for MediaSession {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
            CoUninitialize();
        }
    }
}

/// A render target that either owns its own WIC bitmap (the CPU path every encoder accepts) or
/// draws straight into the encoder's D3D11 texture (the GPU path in [(super::gpu)]).
pub(super) struct Canvas {
    write: IDWriteFactory,
    bitmap: Option<IWICBitmap>,
    target: ID2D1RenderTarget,
    app_icon: ID2D1Bitmap,
    brush: ID2D1SolidColorBrush,
    leading: Vec<IDWriteTextFormat>,
    trailing: Vec<IDWriteTextFormat>,
    centered: Vec<IDWriteTextFormat>,
    palette: scene::Palette,
    width: u32,
}

impl Painter for Canvas {
    fn clear(&self, ink: Color) {
        unsafe {
            self.target.Clear(Some(&color(ink)));
        }
    }

    fn app_icon(&self, bounds: Rect) {
        unsafe {
            self.target.DrawBitmap(
                &self.app_icon,
                Some(&d2d_rect(bounds)),
                1.0,
                D2D1_BITMAP_INTERPOLATION_MODE_LINEAR,
                None,
            );
        }
    }

    fn text(&self, value: &str, bounds: Rect, font: usize, ink: Color, align: Align) {
        let format = match align {
            Align::Left => &self.leading[font],
            Align::Right => &self.trailing[font],
            Align::Center => &self.centered[font],
        };
        self.draw(value, d2d_rect(bounds), format, ink);
    }

    fn text_width(&self, value: &str, font: usize) -> f32 {
        unsafe {
            let measured = (|| -> windows::core::Result<f32> {
                let layout = self.write.CreateTextLayout(
                    &wide(value),
                    &self.leading[font],
                    100_000.0,
                    1000.0,
                )?;
                let mut metrics = DWRITE_TEXT_METRICS::default();
                layout.GetMetrics(&mut metrics)?;
                Ok(metrics.widthIncludingTrailingWhitespace)
            })();
            measured.unwrap_or(f32::INFINITY)
        }
    }

    fn line(&self, x1: f32, y1: f32, x2: f32, y2: f32, ink: Color, width: f32) {
        unsafe {
            self.brush.SetColor(&color(ink));
            self.target.DrawLine(
                Vector2 { X: x1, Y: y1 },
                Vector2 { X: x2, Y: y2 },
                &self.brush,
                width,
                None,
            );
        }
    }

    fn rounded(&self, bounds: Rect, ink: Color, radius: f32) {
        unsafe {
            self.brush.SetColor(&color(ink));
            self.target.FillRoundedRectangle(
                &D2D1_ROUNDED_RECT {
                    rect: d2d_rect(bounds),
                    radiusX: radius,
                    radiusY: radius,
                },
                &self.brush,
            );
        }
    }

    /// Solid fills reuse one brush: the card surfaces and the canvas clear are the only opaque
    /// fills, and a per-frame brush would leak one COM object per frame.
    fn fill(&self, bounds: Rect, ink: Color) {
        unsafe {
            self.brush.SetColor(&color(ink));
            self.target.FillRectangle(&d2d_rect(bounds), &self.brush);
        }
    }

    fn dot(&self, x: f32, y: f32, radius: f32, ink: Color) {
        unsafe {
            self.brush.SetColor(&color(ink));
            self.target.FillEllipse(
                &D2D1_ELLIPSE {
                    point: Vector2 { X: x, Y: y },
                    radiusX: radius,
                    radiusY: radius,
                },
                &self.brush,
            );
        }
    }

    fn clip(&self, bounds: Rect) {
        unsafe {
            self.target
                .PushAxisAlignedClip(&d2d_rect(bounds), D2D1_ANTIALIAS_MODE_PER_PRIMITIVE);
        }
    }

    fn unclip(&self) {
        unsafe {
            self.target.PopAxisAlignedClip();
        }
    }

    fn opacity(&self, value: f32) {
        unsafe {
            self.brush.SetOpacity(value);
        }
    }
}

impl Canvas {
    fn save_png(&self, path: &Path, height: u32) -> Result<()> {
        unsafe {
            let factory: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
            let stream = factory.CreateStream()?;
            stream.InitializeFromFilename(&HSTRING::from(path.as_os_str()), 0x4000_0000)?;
            let encoder = factory.CreateEncoder(&GUID_ContainerFormatPng, std::ptr::null())?;
            encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;
            let mut frame = None;
            let mut properties = None;
            encoder.CreateNewFrame(&mut frame, &mut properties)?;
            let frame = frame.ok_or_else(|| Failure("cannot create the PNG frame".into()))?;
            frame.Initialize(properties.as_ref())?;
            frame.SetSize(self.width, height)?;
            let mut format = GUID_WICPixelFormat32bppBGRA;
            frame.SetPixelFormat(&mut format)?;
            frame.WriteSource(
                self.bitmap
                    .as_ref()
                    .ok_or_else(|| Failure("PNG needs a CPU canvas".into()))?,
                std::ptr::null(),
            )?;
            frame.Commit()?;
            encoder.Commit()?;
        }
        Ok(())
    }

    pub(super) fn new(options: &VideoOptions, colors: &VideoPalette) -> Result<Self> {
        Self::with_texture(options, colors, None)
    }

    /// Draw into the encoder's D3D11 texture when the GPU path is active, otherwise a WIC bitmap.
    pub(super) fn with_texture(
        options: &VideoOptions,
        colors: &VideoPalette,
        texture: Option<&ID3D11Texture2D>,
    ) -> Result<Self> {
        let palette = scene::Palette::new(colors)?;
        unsafe {
            let factory: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                    .ctx("WIC is unavailable")?;
            let d2d: ID2D1Factory = D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)
                .ctx("Direct2D is unavailable")?;
            let properties = D2D1_RENDER_TARGET_PROPERTIES {
                r#type: D2D1_RENDER_TARGET_TYPE_DEFAULT,
                pixelFormat: D2D1_PIXEL_FORMAT {
                    format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
                },
                dpiX: 96.0,
                dpiY: 96.0,
                ..Default::default()
            };
            let (bitmap, target) = match texture {
                Some(texture) => {
                    let surface: windows::Win32::Graphics::Dxgi::IDXGISurface = texture.cast()?;
                    (
                        None,
                        d2d.CreateDxgiSurfaceRenderTarget(&surface, &properties)
                            .ctx("cannot draw into the GPU frame")?,
                    )
                }
                None => {
                    let bitmap = factory
                        .CreateBitmap(
                            options.width,
                            options.height,
                            &GUID_WICPixelFormat32bppPBGRA,
                            WICBitmapCacheOnLoad,
                        )
                        .ctx("cannot allocate the report canvas")?;
                    let target = d2d
                        .CreateWicBitmapRenderTarget(&bitmap, &properties)
                        .ctx("cannot create the Direct2D render target")?;
                    (Some(bitmap), target)
                }
            };
            let brush = target
                .CreateSolidColorBrush(&color(palette.ink), None)
                .ctx("cannot create the drawing brush")?;
            let stream = factory
                .CreateStream()
                .ctx("cannot create the icon stream")?;
            stream.InitializeFromMemory(scene::APP_ICON)?;
            let decoder = factory
                .CreateDecoderFromStream(&stream, std::ptr::null(), WICDecodeMetadataCacheOnLoad)
                .ctx("cannot decode the application icon")?;
            let source = decoder.GetFrame(0)?;
            let converter = factory.CreateFormatConverter()?;
            converter.Initialize(
                &source,
                &GUID_WICPixelFormat32bppPBGRA,
                WICBitmapDitherTypeNone,
                None,
                0.0,
                WICBitmapPaletteTypeCustom,
            )?;
            let app_icon = target
                .CreateBitmapFromWicBitmap(&converter, None)
                .ctx("cannot load the application icon into the report canvas")?;
            let write: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)
                .ctx("DirectWrite is unavailable")?;
            let mut leading = Vec::with_capacity(FONT_SIZES.len());
            let mut trailing = Vec::with_capacity(FONT_SIZES.len());
            let mut centered = Vec::with_capacity(FONT_SIZES.len());
            for size in FONT_SIZES {
                for (alignment, slot) in [
                    (DWRITE_TEXT_ALIGNMENT_LEADING, &mut leading),
                    (DWRITE_TEXT_ALIGNMENT_TRAILING, &mut trailing),
                    (DWRITE_TEXT_ALIGNMENT_CENTER, &mut centered),
                ] {
                    let font = write
                        .CreateTextFormat(
                            &HSTRING::from(FONT_FAMILY),
                            None,
                            if size >= 24.0 {
                                DWRITE_FONT_WEIGHT_SEMI_BOLD
                            } else {
                                DWRITE_FONT_WEIGHT_NORMAL
                            },
                            DWRITE_FONT_STYLE_NORMAL,
                            DWRITE_FONT_STRETCH_NORMAL,
                            size,
                            &HSTRING::from("zh-CN"),
                        )
                        .ctx("cannot create the report text format")?;
                    font.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP)?;
                    font.SetTextAlignment(alignment)?;
                    // Character trimming keeps a long record name on one line instead of letting
                    // it push the clock off the canvas.
                    font.SetTrimming(
                        &DWRITE_TRIMMING {
                            granularity: DWRITE_TRIMMING_GRANULARITY_CHARACTER,
                            ..Default::default()
                        },
                        &write.CreateEllipsisTrimmingSign(&font)?,
                    )?;
                    slot.push(font);
                }
            }
            let scale = options.canvas_scale();
            target.SetTransform(&Matrix3x2 {
                M11: scale,
                M12: 0.0,
                M21: 0.0,
                M22: scale,
                M31: 0.0,
                M32: 0.0,
            });
            target.SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
            Ok(Self {
                write,
                bitmap,
                target,
                app_icon,
                brush,
                leading,
                trailing,
                centered,
                palette,
                width: options.width,
            })
        }
    }

    fn draw(&self, value: &str, bounds: D2D_RECT_F, font: &IDWriteTextFormat, ink: Color) {
        if value.is_empty() {
            return;
        }
        unsafe {
            self.brush.SetColor(&color(ink));
            self.target.DrawText(
                &wide(value),
                font,
                &bounds,
                &self.brush,
                D2D1_DRAW_TEXT_OPTIONS_CLIP,
                DWRITE_MEASURING_MODE_NATURAL,
            );
        }
    }

    /// Draw one frame of the shared layout. Only the WIC path has pixels to copy out; the GPU
    /// path leaves the frame in the encoder's texture.
    pub(super) fn draw_frame(
        &self,
        payload: &VideoPayload,
        frame: usize,
        pixels: &mut [u8],
    ) -> Result<()> {
        unsafe {
            self.target.BeginDraw();
        }
        scene::render(self, &self.palette, payload, frame);
        unsafe {
            self.target.EndDraw(None, None)?;
            if let Some(bitmap) = &self.bitmap {
                bitmap.CopyPixels(std::ptr::null(), self.width * 4, pixels)?;
            }
        }
        Ok(())
    }
}

/// PNG rendering uses WIC and Direct2D without starting a video encoder or Media Foundation.
pub(super) fn image_report(
    payload: &VideoPayload,
    path: &Path,
    cancel: &AtomicBool,
) -> std::result::Result<(), String> {
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    if cancel.load(Ordering::Acquire) {
        return Err("report export was cancelled".into());
    }
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|error| error.to_string())?;
    }
    let _apartment = Apartment;
    let mut options = payload.options;
    let (width, height) = payload.output_size();
    options.height = height;
    let canvas = Canvas::new(&options, &payload.palette).map_err(|error| error.to_string())?;
    let mut pixels = vec![0; width as usize * height as usize * 4];
    canvas
        .draw_frame(payload, 0, &mut pixels)
        .map_err(|error| error.to_string())?;
    if cancel.load(Ordering::Acquire) {
        return Err("report export was cancelled".into());
    }
    canvas
        .save_png(path, height)
        .map_err(|error| error.to_string())
}

/// Top-down NV12 so no encoder has to guess RGB stride or orientation.
///
/// BT.709 limited range: luma clamps to 16..235, chroma to 16..240. The coefficients carry the
/// x4 scale of the 2x2 sums, hence the >>18 shifts.
fn nv12(bgra: &[u8], out: &mut [u8], width: u32, height: u32) {
    let w = width as usize;
    let h = height as usize;
    let plane = w * h;
    for y in (0..h).step_by(2) {
        for x in (0..w).step_by(2) {
            let mut sr = 0i32;
            let mut sg = 0i32;
            let mut sb = 0i32;
            for dy in 0..2 {
                for dx in 0..2 {
                    let at = (y + dy) * w + x + dx;
                    let b = i32::from(bgra[at * 4]);
                    let g = i32::from(bgra[at * 4 + 1]);
                    let r = i32::from(bgra[at * 4 + 2]);
                    out[at] = (((47 * r + 157 * g + 16 * b + 128) >> 8) + 16).clamp(16, 235) as u8;
                    sr += r;
                    sg += g;
                    sb += b;
                }
            }
            let at = plane + y / 2 * w + x;
            out[at] = (((-6596 * sr - 22189 * sg + 28785 * sb + 131072) >> 18) + 128).clamp(16, 240)
                as u8;
            out[at + 1] =
                (((28785 * sr - 26145 * sg - 2640 * sb + 131072) >> 18) + 128).clamp(16, 240) as u8;
        }
    }
}

/// BT.709, limited range, progressive, square pixels. The same shape is used for the encoder
/// output type and the NV12 input type, which is what Media Foundation expects here.
fn media_type(subtype: &windows::core::GUID, options: &VideoOptions) -> Result<IMFMediaType> {
    unsafe {
        let media = MFCreateMediaType()?;
        media.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        media.SetGUID(&MF_MT_SUBTYPE, subtype)?;
        media.SetUINT64(
            &MF_MT_FRAME_SIZE,
            (u64::from(options.width) << 32) | u64::from(options.height),
        )?;
        media.SetUINT64(&MF_MT_FRAME_RATE, (u64::from(options.fps) << 32) | 1)?;
        media.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)?;
        media.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        media.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
        media.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
        media.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
        media.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
        Ok(media)
    }
}

/// The NV12 input type Media Foundation expects; the GPU sample pool reuses it.
pub(super) fn nv12_type(options: &VideoOptions) -> Result<IMFMediaType> {
    media_type(&MFVideoFormat_NV12, options)
}

/// Create the sink writer and its single video stream. The third value is the encoder that
/// Media Foundation actually bound, read back from its own attributes.
///
/// The shared quality policy scales bitrate with pixels and frame rate.
fn writer(
    path: &Path,
    options: &VideoOptions,
    gpu: Option<&GpuFrames>,
) -> Result<(IMFSinkWriter, u32, &'static str)> {
    let wide: Vec<u16> = path
        .as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain(Some(0))
        .collect();
    unsafe {
        let mut attributes = None;
        MFCreateAttributes(&mut attributes, 3)?;
        let attributes = attributes.ctx("cannot create the writer attributes")?;
        // The MOV pass rewrites the brands; the container itself is always the MP4 one.
        attributes.SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MPEG4)?;
        // CPU-rendered frames may still use hardware. Software mode alone disables hardware
        // transforms; the actual encoder is verified below for both forced modes.
        attributes.SetUINT32(
            &MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,
            u32::from(options.acceleration != Acceleration::Software),
        )?;
        if let Some(frames) = gpu {
            attributes.SetUnknown(&MF_SINK_WRITER_D3D_MANAGER, &frames.gpu.manager)?;
            // Export runs as fast as the texture pool permits, not at playback speed.
            attributes.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1)?;
        }
        let writer = MFCreateSinkWriterFromURL(PCWSTR(wide.as_ptr()), None, &attributes)
            .ctx("Windows Media Foundation cannot write this container")?;
        let subtype = match options.codec {
            Codec::H264 => MFVideoFormat_H264,
            Codec::H265 => MFVideoFormat_HEVC,
        };
        let output = media_type(&subtype, options)?;
        output.SetUINT32(&MF_MT_AVG_BITRATE, options.bitrate())?;
        let stream = writer.AddStream(&output).ctx_with(|| {
            format!(
                "{} is unavailable for {}x{} at {} fps",
                options.codec.label(),
                options.width,
                options.height,
                options.fps
            )
        })?;
        let input = media_type(&MFVideoFormat_NV12, options)?;
        writer
            .SetInputMediaType(stream, &input, None)
            .ctx_with(|| format!("{} does not accept this NV12 input", options.codec.label()))?;
        writer
            .BeginWriting()
            .ctx_with(|| format!("{} cannot start this combination", options.codec.label()))?;
        // A sink writer silently falls back to the software MFT, so only the encoder's own
        // attributes justify a hardware claim -- on either path.
        let mut raw = std::ptr::null_mut();
        writer.GetServiceForStream(
            stream,
            &windows::core::GUID::zeroed(),
            &IMFTransform::IID,
            &mut raw,
        )?;
        if raw.is_null() {
            return Err(Failure::from(
                "Media Foundation did not expose the video encoder",
            ));
        }
        let attributes = IMFTransform::from_raw(raw).GetAttributes()?;
        let hardware = attributes
            .GetStringLength(&MFT_ENUM_HARDWARE_URL_Attribute)
            .is_ok();
        if (gpu.is_some() || options.acceleration == Acceleration::Hardware) && !hardware {
            // Keep the retry honest: the zero-copy path only pays off with a hardware MFT, so a
            // software encoder here is why the CPU attempt is worth running.
            return Err(Failure::from(
                "Media Foundation selected a software encoder for the GPU path",
            ));
        }
        if options.acceleration == Acceleration::Software && hardware {
            return Err(Failure::from(
                "Media Foundation selected hardware for software mode",
            ));
        }
        Ok((
            writer,
            stream,
            if hardware { "hardware" } else { "software" },
        ))
    }
}

/// Stamp a sample with its exact position on the timeline and submit it.
fn write_sample(
    writer: &IMFSinkWriter,
    stream: u32,
    sample: &IMFSample,
    index: u64,
    fps: u32,
) -> Result<()> {
    unsafe {
        // 100 ns units: integer arithmetic on the frame index means no drift over 60 seconds.
        let time = index * 10_000_000 / u64::from(fps);
        let next = (index + 1) * 10_000_000 / u64::from(fps);
        sample.SetSampleTime(time as i64)?;
        sample.SetSampleDuration((next - time) as i64)?;
        // Only the first frame is a clean point; a keyframe per second would inflate the file
        // for a report nobody scrubs.
        sample.SetUINT32(&MFSampleExtension_CleanPoint, u32::from(index == 0))?;
        writer
            .WriteSample(stream, sample)
            .ctx_with(|| format!("cannot submit video frame {index}"))?;
    }
    Ok(())
}

/// Submit one NV12 frame from system memory.
fn sample(writer: &IMFSinkWriter, stream: u32, frame: &[u8], index: u64, fps: u32) -> Result<()> {
    unsafe {
        let buffer = MFCreateMemoryBuffer(frame.len() as u32)?;
        let mut destination = std::ptr::null_mut();
        buffer.Lock(&mut destination, None, None)?;
        std::ptr::copy_nonoverlapping(frame.as_ptr(), destination, frame.len());
        buffer.Unlock()?;
        buffer.SetCurrentLength(frame.len() as u32)?;
        let sample = MFCreateSample()?;
        sample.AddBuffer(&buffer)?;
        write_sample(writer, stream, &sample, index, fps)?;
    }
    Ok(())
}

/// What one export actually used.
#[derive(Debug)]
pub(super) struct EncoderUsed {
    /// `hardware` or `software`, taken from the encoder's own attributes.
    pub(super) name: &'static str,
    /// Why the zero-copy path was abandoned, when a lesser path still produced the file. Only set
    /// for a final software encode: an export that recovered hardware by copying frames is not a
    /// failure the user needs to read about.
    pub(super) fallback: Option<String>,
}

/// Encode the whole report and report the encoder as soon as one is running.
///
/// The GPU path is attempted first: it keeps every frame on the graphics card and is what makes a
/// 4K export finish in reasonable time. A host without a video processor, a driver that refuses
/// the conversion or an encoder that only accepts system memory fails here and is retried on the
/// CPU path instead of aborting the export.
pub(super) fn encode(
    payload: &VideoPayload,
    path: &Path,
    cancel: &AtomicBool,
    mut on_encoder: impl FnMut(&'static str),
    mut progress: impl FnMut(f64),
) -> std::result::Result<EncoderUsed, String> {
    let mut options = payload.options;
    let mut errors = Vec::new();
    // Hardware can accept either GPU textures or CPU-rendered frames. Only auto may cross
    // from those attempts to a writer with hardware transforms disabled.
    let attempts: &[(bool, Acceleration)] = match options.acceleration {
        Acceleration::Software => &[(false, Acceleration::Software)],
        Acceleration::Hardware => &[
            (true, Acceleration::Hardware),
            (false, Acceleration::Hardware),
        ],
        Acceleration::Auto => &[
            (true, Acceleration::Hardware),
            (false, Acceleration::Hardware),
            (false, Acceleration::Software),
        ],
    };
    for &(gpu, acceleration) in attempts {
        if cancel.load(Ordering::Acquire) {
            return Err("video encoding was cancelled".into());
        }
        if !errors.is_empty() {
            std::fs::File::create(path).map_err(|error| error.to_string())?;
            progress(0.0);
        }
        options.acceleration = acceleration;
        match encode_attempt(
            payload,
            &options,
            path,
            cancel,
            &mut on_encoder,
            &mut progress,
            gpu,
        ) {
            Ok(name) => {
                return Ok(EncoderUsed {
                    name,
                    fallback: (name == "software" && !errors.is_empty()).then(|| errors.join("; ")),
                })
            }
            Err(error) => errors.push(error.to_string()),
        }
    }
    Err(errors.join("; "))
}

fn encode_attempt(
    payload: &VideoPayload,
    options: &VideoOptions,
    path: &Path,
    cancel: &AtomicBool,
    on_encoder: &mut dyn FnMut(&'static str),
    progress: &mut dyn FnMut(f64),
    gpu_path: bool,
) -> Result<&'static str> {
    let _lock = ENCODER
        .lock()
        .map_err(|_| Failure("the video encoder state is poisoned".into()))?;
    let _session = MediaSession::start()?;
    let gpu = if gpu_path {
        Some(GpuFrames::new(options).ctx("the GPU video path is unavailable")?)
    } else {
        None
    };
    let canvas = match &gpu {
        Some(frames) => Canvas::with_texture(options, &payload.palette, Some(&frames.canvas))?,
        None => Canvas::new(options, &payload.palette)?,
    };
    let (writer, stream, encoder) = writer(path, options, gpu.as_ref())?;
    // The dialog shows the encoder from the first poll, so it is published before any frame work.
    on_encoder(encoder);
    let size = options.width as usize * options.height as usize;
    // The GPU path never materialises a frame in system memory.
    let mut pixels = vec![0u8; if gpu.is_some() { 0 } else { size * 4 }];
    let mut frame = vec![0u8; if gpu.is_some() { 0 } else { size * 3 / 2 }];
    let count = payload.frames.t.len();
    for index in 0..count {
        if cancel.load(Ordering::Acquire) {
            return Err("video encoding was cancelled".into());
        }
        canvas
            .draw_frame(payload, index, &mut pixels)
            .ctx_with(|| format!("cannot draw video frame {index}"))?;
        match &gpu {
            Some(frames) => {
                let sample = frames.sample(cancel)?;
                write_sample(&writer, stream, &sample, index as u64, options.fps)?;
            }
            None => {
                nv12(&pixels, &mut frame, options.width, options.height);
                sample(&writer, stream, &frame, index as u64, options.fps)?;
            }
        }
        progress((index + 1) as f64 / count.max(1) as f64);
    }
    if cancel.load(Ordering::Acquire) {
        return Err("video encoding was cancelled".into());
    }
    unsafe {
        writer
            .Finalize()
            .ctx("the video container was not finalised")?;
    }
    if options.format == super::model::Format::Mov {
        super::mov::quicktime(path)?;
    }
    Ok(encoder)
}

/// Probe one combination and cache it for the rest of the process.
///
/// The probe exercises the same writer and one-frame submit path as a real export, so a
/// combination is only reported available when encoding it actually works. Probing one
/// combination at a time is deliberate: a first dialog open used to run up to 48 real encodes
/// (24 combinations 脳 hardware + software), which on a host with a virtual display adapter is
/// both slow and needlessly load-dependent.
pub(super) fn capability(options: &VideoOptions) -> VideoCapability {
    let lock = ENCODER.lock().unwrap_or_else(|poison| poison.into_inner());
    let outcome = probe(options);
    drop(lock);
    match outcome {
        Ok((available, encoder, reason)) => VideoCapability {
            width: options.width,
            height: options.height,
            fps: options.fps,
            codec: options.codec,
            available,
            bitrate: options.bitrate(),
            reason,
            encoder,
        },
        Err(error) => VideoCapability {
            width: options.width,
            height: options.height,
            fps: options.fps,
            codec: options.codec,
            available: false,
            bitrate: options.bitrate(),
            reason: Some(error.to_string()),
            encoder: None,
        },
    }
}

fn probe(options: &VideoOptions) -> Result<(bool, Option<String>, Option<String>)> {
    let session = MediaSession::start().map_err(|failure| Failure(failure.to_string()))?;
    let _session = session;
    let attempt = |gpu_path: bool, mode: Acceleration| -> Result<&'static str> {
        let path = std::env::temp_dir().join(format!(
            "lapower-codec-probe-{}-{}-{}x{}-{}-{}-{}.mp4",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default(),
            options.width,
            options.height,
            options.fps,
            match options.codec {
                Codec::H264 => "h264",
                Codec::H265 => "h265",
            },
            u8::from(gpu_path),
        ));
        struct ProbeFile(std::path::PathBuf);
        impl Drop for ProbeFile {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let _cleanup = ProbeFile(path.clone());
        let mut selected = *options;
        selected.acceleration = mode;
        let options = &selected;
        let gpu = if gpu_path {
            Some(GpuFrames::new(options)?)
        } else {
            None
        };
        // Creating the Direct2D target is part of the GPU path: probe it too, so an export never
        // discovers halfway through that it cannot draw there.
        if let Some(frames) = &gpu {
            Canvas::with_texture(options, &probe_palette(), Some(&frames.canvas))?;
        }
        let (writer, stream, encoder) = writer(&path, options, gpu.as_ref())?;
        let size = options.width as usize * options.height as usize;
        match &gpu {
            Some(frames) => {
                let cancel = AtomicBool::new(false);
                let frame = frames.sample(&cancel)?;
                write_sample(&writer, stream, &frame, 0, options.fps)?;
            }
            None => {
                let mut frame = vec![128u8; size * 3 / 2];
                // Black luma with neutral chroma: the cheapest legal frame.
                frame[..size].fill(16);
                sample(&writer, stream, &frame, 0, options.fps)?;
            }
        }
        unsafe {
            let finalized = writer.Finalize();
            drop(writer);
            let _ = std::fs::remove_file(&path);
            finalized.map_err(|error| format!("cannot finalise the probe: {error}"))?;
        }
        Ok(encoder)
    };
    let attempts: &[(bool, Acceleration)] = match options.acceleration {
        Acceleration::Software => &[(false, Acceleration::Software)],
        Acceleration::Hardware => &[
            (true, Acceleration::Hardware),
            (false, Acceleration::Hardware),
        ],
        Acceleration::Auto => &[
            (true, Acceleration::Hardware),
            (false, Acceleration::Hardware),
            (false, Acceleration::Software),
        ],
    };
    let mut errors = Vec::new();
    for &(gpu, mode) in attempts {
        match attempt(gpu, mode) {
            Ok(encoder) => return Ok((true, Some(encoder.to_owned()), None)),
            Err(error) => errors.push(error.to_string()),
        }
    }
    Ok((false, None, Some(errors.join("; "))))
}

/// Colours the probes draw with; the real export sends the user's palette instead.
fn probe_palette() -> VideoPalette {
    VideoPalette {
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video_export::model::{
        Format, Theme, VideoFrames, VideoHeader, VideoLabels, VideoMarker, VideoOverview,
        VideoSummary, FRAME_RATES, RESOLUTIONS,
    };

    /// One-second 720p report. Small on purpose: this exercises Direct2D, DirectWrite, NV12
    /// conversion and the Media Foundation sink writer end to end, which nothing else does.
    fn payload(format: Format) -> VideoPayload {
        let options = VideoOptions {
            report_type: crate::video_export::model::ReportType::Video,
            image_layout: crate::video_export::model::ImageLayout::Widescreen,
            show_markers: true,
            show_marker_details: true,
            width: 1280,
            height: 720,
            fps: 24,
            codec: Codec::H264,
            acceleration: crate::video_export::model::Acceleration::Auto,
            quality: crate::video_export::model::Quality::High,
            format,
            duration_s: 1,
            theme: Theme::Light,
            visible_series: [true; 4],
        };
        let frames = options.frames();
        let labels = VideoLabels {
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
        };
        VideoPayload {
            options,
            header: VideoHeader {
                title: "WITRN K2".into(),
                status: "Recorded".into(),
                status_kind: "complete".into(),
            },
            labels,
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
            summary: VideoSummary {
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
            overview: VideoOverview {
                bucket_ms: 4,
                points: vec![
                    [Some(0.0), Some(5.0), Some(1.0), Some(5.0), Some(30.0)],
                    [Some(500.0), Some(5.1), Some(1.1), Some(5.6), Some(30.5)],
                    [Some(1000.0), Some(4.9), Some(0.9), Some(4.4), Some(31.0)],
                ],
            },
            frames: VideoFrames {
                t: (0..frames).map(|index| index as f64 / 24.0).collect(),
                voltage: vec![Some(5.0); frames],
                current: vec![Some(1.0); frames],
                power: vec![Some(5.0); frames],
                temperature: vec![Some(30.0); frames],
            },
            markers: vec![VideoMarker {
                t_s: 0.5,
                label: "half".into(),
                voltage: Some(5.0),
                current: Some(1.0),
                power: Some(5.0),
                temperature: Some(30.0),
            }],
        }
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "lapower-video-{}-{}",
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
    fn software_export_writes_a_playable_mp4_and_can_switch_to_quicktime() {
        let mut value = payload(Format::Mp4);
        value.options.acceleration = Acceleration::Software;
        value.validate().unwrap();
        let path = scratch("report.mp4");
        // Both callbacks land in one shared cell: an encoder name that arrives after any progress
        // is useless to the dialog.
        let seen = std::cell::RefCell::new((Vec::<&'static str>::new(), 0.0f64, None));
        let encoder = encode(
            &value,
            &path,
            &AtomicBool::new(false),
            |name| {
                let mut seen = seen.borrow_mut();
                seen.0.push(name);
                if seen.2.is_none() {
                    seen.2 = Some(seen.1);
                }
            },
            |progress| seen.borrow_mut().1 = progress,
        )
        .unwrap();
        let (reported, last, progress_at_report) = seen.into_inner();
        assert!(
            last > 0.99,
            "progress must reach one before the file is published"
        );
        // The dialog shows the encoder while it is still encoding, so the name cannot wait for
        // the finished file.
        assert!(
            !reported.is_empty(),
            "the encoder must be reported before the export finishes"
        );
        assert_eq!(progress_at_report, Some(0.0));
        assert_eq!(encoder.name, "software");
        assert!(encoder.fallback.is_none());
        assert_eq!(reported.last().copied(), Some(encoder.name));
        let bytes = std::fs::read(&path).unwrap();
        assert!(
            bytes.len() > 4096,
            "the encoded report is suspiciously small"
        );
        assert_eq!(
            &bytes[4..8],
            b"ftyp",
            "an MP4 must start with a file type box"
        );
        // The same file becomes a QuickTime movie in place, keeping its length.
        let quicktime = scratch("report.mov");
        std::fs::copy(&path, &quicktime).unwrap();
        super::super::mov::quicktime(&quicktime).unwrap();
        let converted = std::fs::read(&quicktime).unwrap();
        assert_eq!(&converted[8..12], b"qt  ");
        assert_eq!(converted.len(), bytes.len());
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&quicktime);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn cancellation_stops_before_finalising_the_container() {
        let value = payload(Format::Mp4);
        let path = scratch("cancelled.mp4");
        let cancel = AtomicBool::new(true);
        let error = encode(&value, &path, &cancel, |_| {}, |_| {}).unwrap_err();
        assert!(error.contains("cancelled"), "unexpected error: {error}");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn cancelling_a_running_attempt_does_not_retry_or_touch_the_destination() {
        let value = payload(Format::Mp4);
        let target = scratch("existing.mp4");
        std::fs::write(&target, b"original recording").unwrap();
        let staged = super::super::stage_path(&target).unwrap();
        let cancel = AtomicBool::new(false);
        let mut attempts = 0;
        let result = encode(
            &value,
            &staged,
            &cancel,
            |_| attempts += 1,
            |_| cancel.store(true, Ordering::Release),
        );
        assert!(result.unwrap_err().contains("cancelled"));
        assert_eq!(attempts, 1, "cancellation must not restart another encoder");
        assert_eq!(std::fs::read(&target).unwrap(), b"original recording");
        // The owning worker removes this stage after a cancelled attempt.
        std::fs::remove_file(&staged).unwrap();
        assert!(!staged.exists());
        std::fs::remove_dir_all(target.parent().unwrap()).unwrap();
    }

    /// Both rasterisers must draw the same frame: skia is what macOS and Linux ship, so a layout
    /// or glyph regression there has to fail here instead of in a user's video.
    #[test]
    fn both_backends_render_the_same_frame() {
        let _session = MediaSession::start().unwrap();
        let value = payload(Format::Mp4);
        let options = &value.options;
        let (width, height) = (options.width as usize, options.height as usize);
        let direct = Canvas::new(options, &value.palette).unwrap();
        let mut left = vec![0u8; width * height * 4];
        direct.draw_frame(&value, 3, &mut left).unwrap();
        // Direct2D writes BGRA; compare in the same channel order the portable backend uses.
        for chunk in left.chunks_mut(4) {
            chunk.swap(0, 2);
        }
        let portable = super::super::skia::Canvas::new(options, &value.palette).unwrap();
        portable.draw_frame(&value, 3);
        let mut right = vec![0u8; width * height * 4];
        portable.copy_pixels(&mut right);
        // Mean absolute luma per 32 x 18 block: same layout, different glyph rasterisers.
        let (blocks_x, blocks_y) = (32usize, 18usize);
        let mut total = 0.0f64;
        let mut blocks = 0.0f64;
        for by in 0..blocks_y {
            for bx in 0..blocks_x {
                let mut sum = 0.0f64;
                let mut count = 0.0f64;
                for y in (by * height / blocks_y)..((by + 1) * height / blocks_y) {
                    for x in (bx * width / blocks_x)..((bx + 1) * width / blocks_x) {
                        let at = (y * width + x) * 4;
                        let luma = |pixels: &[u8]| {
                            0.2126 * pixels[at] as f64
                                + 0.7152 * pixels[at + 1] as f64
                                + 0.0722 * pixels[at + 2] as f64
                        };
                        sum += (luma(&left) - luma(&right)).abs();
                        count += 1.0;
                    }
                }
                total += sum / count.max(1.0);
                blocks += 1.0;
            }
        }
        let difference = total / blocks;
        assert!(
            difference < 3.0,
            "the two backends disagree by {difference:.2} on average"
        );
    }

    /// Every combination the dialog offers must be probeable, and an unavailable one must say
    /// why. The probe is per combination now, so each row is checked on its own.
    #[test]
    fn capability_probe_reports_every_offered_combination() {
        let mut encodable = 0;
        for (width, height) in RESOLUTIONS {
            for fps in FRAME_RATES {
                for codec in [Codec::H264, Codec::H265] {
                    let options = VideoOptions {
                        report_type: crate::video_export::model::ReportType::Video,
                        image_layout: crate::video_export::model::ImageLayout::Widescreen,
                        show_markers: true,
                        show_marker_details: true,
                        width,
                        height,
                        fps,
                        codec,
                        acceleration: crate::video_export::model::Acceleration::Auto,
                        quality: crate::video_export::model::Quality::High,
                        format: Format::Mp4,
                        duration_s: 1,
                        theme: Theme::Light,
                        visible_series: [true; 4],
                    };
                    let capability = capability(&options);
                    assert_eq!(capability.width, width);
                    assert_eq!(capability.fps, fps);
                    if capability.available {
                        encodable += 1;
                        assert!(
                            matches!(capability.encoder.as_deref(), Some("hardware" | "software")),
                            "{width}x{height}@{fps} {codec:?} claims to be available without an encoder"
                        );
                    } else {
                        assert!(
                            capability.reason.is_some(),
                            "{width}x{height}@{fps} {codec:?} is unavailable without a reason"
                        );
                    }
                }
            }
        }
        assert!(
            encodable > 0,
            "this host cannot encode a single offered combination"
        );
    }
}
