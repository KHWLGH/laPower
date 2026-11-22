// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-only
// For original project contributions; see COPYRIGHT.

#[cfg(target_os = "windows")]
mod platform {
    use gpui::{
        canvas, div, point, prelude::*, px, rgba, size, App, Application, Bounds, Context, Path,
        PathBuilder, Pixels, Render, TitlebarOptions, Window, WindowBackgroundAppearance,
        WindowBounds, WindowHandle, WindowKind, WindowOptions,
    };
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
    };
    use std::thread;
    use windows_sys::Win32::{
        Foundation::HWND,
        Graphics::Gdi::{CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_DIFF},
        UI::WindowsAndMessaging::{
            GetAncestor, GetWindowLongPtrW, IsWindow, SetParent, SetWindowLongPtrW, SetWindowPos,
            ShowWindow, GA_PARENT, GWL_EXSTYLE, GWL_STYLE, SWP_FRAMECHANGED, SWP_NOACTIVATE,
            SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE,
            WS_BORDER, WS_CAPTION, WS_CHILD, WS_DISABLED, WS_DLGFRAME, WS_EX_NOACTIVATE,
            WS_EX_TRANSPARENT, WS_POPUP, WS_SYSMENU, WS_THICKFRAME,
        },
    };

    const MAGIC: u32 = 0x4750_5549;
    const HEADER_BYTES: usize = 32;
    const SERIES_BYTES: usize = 24;
    const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
    const MAX_POINTS_PER_SERIES: usize = 100_000;

    #[derive(Clone, Copy, Default, PartialEq, Eq)]
    struct SurfaceBounds {
        left: i32,
        top: i32,
        width: i32,
        height: i32,
    }

    #[derive(Clone, Default)]
    struct SeriesFrame {
        color: u32,
        width: f32,
        fill_opacity: f32,
        baseline: f32,
        points: Vec<[f32; 2]>,
    }

    #[derive(Clone, Default)]
    struct ChartFrame {
        bounds: SurfaceBounds,
        visible: bool,
        series: Vec<SeriesFrame>,
    }

    #[derive(Clone, Default)]
    struct FrameSet {
        frames: [Arc<ChartFrame>; 2],
        revisions: [u64; 2],
        overlays: Arc<Vec<[i32; 4]>>,
        overlay_revision: u64,
    }

    #[derive(Default)]
    pub struct Renderer {
        frames: Arc<RwLock<FrameSet>>,
        wake: Mutex<Option<async_channel::Sender<()>>>,
        ready: Arc<AtomicBool>,
    }

    impl Renderer {
        pub fn start(&self, parent: isize) -> Result<(), String> {
            if parent == 0 || unsafe { IsWindow(parent as HWND) } == 0 {
                return Err("Tauri 主窗口句柄无效".into());
            }
            let (wake_tx, wake_rx) = async_channel::bounded(1);
            *self.wake.lock().map_err(|_| "GPUI 通知通道已损坏")? = Some(wake_tx);
            let frames = Arc::clone(&self.frames);
            let ready = Arc::clone(&self.ready);
            thread::Builder::new()
                .name("lapower-gpui-chart".into())
                .spawn(move || run_gpui(parent as HWND, frames, wake_rx, ready))
                .map_err(|error| format!("无法启动 GPUI 图表线程: {error}"))?;
            Ok(())
        }

        pub fn is_ready(&self) -> bool {
            self.ready.load(Ordering::Acquire)
        }

        pub fn submit(&self, bytes: &[u8]) -> Result<(), String> {
            if !self.is_ready() {
                return Err("GPUI 图层不可用".into());
            }
            let (slot, frame) = decode_frame(bytes)?;
            {
                let mut frames = self.frames.write().map_err(|_| "GPUI 图表数据已损坏")?;
                frames.frames[slot] = Arc::new(frame);
                frames.revisions[slot] = frames.revisions[slot].wrapping_add(1);
            }
            self.wake();
            Ok(())
        }

        pub fn hide(&self) {
            if let Ok(mut frames) = self.frames.write() {
                for slot in 0..2 {
                    frames.frames[slot] = Arc::new(ChartFrame {
                        bounds: frames.frames[slot].bounds,
                        ..Default::default()
                    });
                    frames.revisions[slot] = frames.revisions[slot].wrapping_add(1);
                }
            }
            self.wake();
        }

        pub fn set_overlays(&self, rects: Vec<[i32; 4]>) -> Result<(), String> {
            if rects.len() > 32
                || rects.iter().any(|&[l, t, r, b]| {
                    l >= r
                        || t >= b
                        || [l, t, r, b]
                            .iter()
                            .any(|v| !(-1_000_000..=1_000_000).contains(v))
                })
            {
                return Err("GPUI overlay bounds are invalid".into());
            }
            let mut frames = self.frames.write().map_err(|_| "GPUI 图表数据已损坏")?;
            if *frames.overlays != rects {
                frames.overlays = Arc::new(rects);
                frames.overlay_revision = frames.overlay_revision.wrapping_add(1);
                drop(frames);
                self.wake();
            }
            Ok(())
        }

        fn wake(&self) {
            if let Ok(wake) = self.wake.lock() {
                if let Some(wake) = wake.as_ref() {
                    let _ = wake.try_send(());
                }
            }
        }
    }

    struct ChartSurface {
        frame: Arc<ChartFrame>,
    }

    impl Render for ChartSurface {
        fn render(&mut self, window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            let paths = build_paths(&self.frame, 1.0 / window.scale_factor());
            div().size_full().child(
                canvas(
                    |_, _, _| (),
                    move |_, _, window, _| {
                        for (path, color) in paths {
                            window.paint_path(path, color);
                        }
                    },
                )
                .size_full(),
            )
        }
    }

    fn build_paths(frame: &ChartFrame, scale: f32) -> Vec<(Path<Pixels>, gpui::Background)> {
        let mut paths = Vec::with_capacity(frame.series.len() * 2);
        for series in &frame.series {
            if series.points.len() < 2 {
                continue;
            }
            let alpha = (series.fill_opacity.clamp(0.0, 1.0) * 255.0).round() as u32;
            let mut fill = (alpha > 0).then(PathBuilder::fill);
            let mut stroke = PathBuilder::stroke(px(series.width * scale));
            let (mut first, mut last) = (None, None);
            let mut has_stroke = false;

            let baseline = series.baseline * scale;
            for &[x, y] in &series.points {
                let value = [x * scale, y * scale];
                if !value[0].is_finite() || !value[1].is_finite() {
                    if let Some(fill) = &mut fill {
                        close_fill(fill, first, last, baseline);
                    }
                    first = None;
                    last = None;
                    continue;
                }
                let pt = point(px(value[0]), px(value[1]));
                if first.is_none() {
                    first = Some(value);
                    stroke.move_to(pt);
                    if let Some(fill) = &mut fill {
                        fill.move_to(point(px(value[0]), px(baseline)));
                        fill.line_to(pt);
                    }
                } else {
                    if let Some(fill) = &mut fill {
                        fill.line_to(pt);
                    }
                    stroke.line_to(pt);
                    has_stroke = true;
                }
                last = Some(value);
            }
            if let Some(mut fill) = fill {
                close_fill(&mut fill, first, last, baseline);
                if let Ok(path) = fill.build() {
                    paths.push((path, rgba((series.color << 8) | alpha).into()));
                }
            }
            if has_stroke {
                if let Ok(path) = stroke.build() {
                    paths.push((path, rgba((series.color << 8) | 0xff).into()));
                }
            }
        }
        paths
    }

    fn close_fill(
        path: &mut PathBuilder,
        start: Option<[f32; 2]>,
        end: Option<[f32; 2]>,
        baseline: f32,
    ) {
        if let (Some(start), Some(end)) = (start, end) {
            if start[0] != end[0] || start[1] != end[1] {
                path.line_to(point(px(end[0]), px(baseline)));
                path.line_to(point(px(start[0]), px(baseline)));
                path.close();
            }
        }
    }

    fn decode_frame(bytes: &[u8]) -> Result<(usize, ChartFrame), String> {
        if !(HEADER_BYTES..=MAX_FRAME_BYTES).contains(&bytes.len()) {
            return Err("GPUI 图表帧长度超出限制".into());
        }
        let u32_at = |offset: usize| -> Result<u32, String> {
            let value = bytes.get(offset..offset + 4).ok_or("GPUI 图表帧头不完整")?;
            Ok(u32::from_le_bytes(
                value.try_into().map_err(|_| "GPUI 图表帧头不完整")?,
            ))
        };
        let f32_at = |offset: usize| -> Result<f32, String> { Ok(f32::from_bits(u32_at(offset)?)) };
        if u32_at(0)? != MAGIC || bytes[4] != 1 {
            return Err("GPUI 图表帧格式无效".into());
        }
        let slot = usize::from(bytes[5]);
        let count = usize::from(bytes[7]);
        if slot > 1 || count > 8 {
            return Err("GPUI 图表帧通道配置无效".into());
        }
        let (left, top, logical_width, logical_height, ratio) = (
            f32_at(8)?,
            f32_at(12)?,
            f32_at(16)?,
            f32_at(20)?,
            f32_at(24)?,
        );
        if ![left, top, logical_width, logical_height, ratio]
            .iter()
            .all(|value| value.is_finite())
            || !(1.0..=16_384.0).contains(&logical_width)
            || !(1.0..=16_384.0).contains(&logical_height)
            || !(0.5..=8.0).contains(&ratio)
        {
            return Err("GPUI 图表尺寸无效".into());
        }

        let mut offset = HEADER_BYTES;
        let mut series = Vec::with_capacity(count);
        for _ in 0..count {
            let header = bytes
                .get(offset..offset + SERIES_BYTES)
                .ok_or("GPUI 曲线头不完整")?;
            let channel =
                u32::from_le_bytes(header[0..4].try_into().map_err(|_| "GPUI 曲线头无效")?);
            let width = f32::from_le_bytes(header[4..8].try_into().map_err(|_| "GPUI 曲线头无效")?);
            let fill_opacity =
                f32::from_le_bytes(header[8..12].try_into().map_err(|_| "GPUI 曲线头无效")?);
            let baseline =
                f32::from_le_bytes(header[12..16].try_into().map_err(|_| "GPUI 曲线头无效")?);
            let point_count =
                u32::from_le_bytes(header[16..20].try_into().map_err(|_| "GPUI 曲线头无效")?)
                    as usize;
            if channel > 7
                || !(0.25..=64.0).contains(&width)
                || !(0.0..=1.0).contains(&fill_opacity)
                || !baseline.is_finite()
                || point_count > MAX_POINTS_PER_SERIES
            {
                return Err("GPUI 曲线参数无效".into());
            }
            let color = (u32::from(header[20]) << 16)
                | (u32::from(header[21]) << 8)
                | u32::from(header[22]);
            offset += SERIES_BYTES;
            let byte_count = point_count.checked_mul(8).ok_or("GPUI 曲线点数溢出")?;
            let data = bytes
                .get(offset..offset + byte_count)
                .ok_or("GPUI 曲线点数据不完整")?;
            let mut points = Vec::with_capacity(point_count);
            for point in data.chunks_exact(8) {
                let x = f32::from_le_bytes(point[0..4].try_into().map_err(|_| "GPUI 曲线点无效")?);
                let y = f32::from_le_bytes(point[4..8].try_into().map_err(|_| "GPUI 曲线点无效")?);
                if !(x.is_finite() && y.is_finite() || x.is_nan() && y.is_nan()) {
                    return Err("GPUI 曲线包含非法坐标".into());
                }
                points.push([x, y]);
            }
            offset += byte_count;
            series.push(SeriesFrame {
                color,
                width,
                fill_opacity,
                baseline,
                points,
            });
        }
        if offset != bytes.len() {
            return Err("GPUI 图表帧包含多余数据".into());
        }
        Ok((
            slot,
            ChartFrame {
                bounds: SurfaceBounds {
                    left: (left * ratio).round() as i32,
                    top: (top * ratio).round() as i32,
                    width: (logical_width * ratio).round().max(1.0) as i32,
                    height: (logical_height * ratio).round().max(1.0) as i32,
                },
                visible: bytes[6] != 0,
                series,
            },
        ))
    }

    fn attach_child(window: HWND, parent: HWND) -> Result<(), String> {
        unsafe {
            let style = GetWindowLongPtrW(window, GWL_STYLE) as u32;
            SetWindowLongPtrW(
                window,
                GWL_STYLE,
                ((style
                    & !(WS_POPUP
                        | WS_BORDER
                        | WS_CAPTION
                        | WS_DLGFRAME
                        | WS_SYSMENU
                        | WS_THICKFRAME))
                    | WS_CHILD
                    | WS_DISABLED) as isize,
            );
            let ex_style = GetWindowLongPtrW(window, GWL_EXSTYLE) as u32;
            SetWindowLongPtrW(
                window,
                GWL_EXSTYLE,
                (ex_style | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE) as isize,
            );
            // Keep GPUI's DirectComposition swap chain. Applying a layered bitmap or
            // resizing a newly parented hidden window can break its first native frame.
            SetParent(window, parent);
            if GetAncestor(window, GA_PARENT) != parent {
                return Err(format!(
                    "无法嵌入 GPUI 图层: {}",
                    std::io::Error::last_os_error()
                ));
            }
            // Recompute the client area after changing this popup into a child.
            // Without SWP_FRAMECHANGED, the old top-level non-client border
            // survives reparenting and consumes almost the entire overview height.
            if SetWindowPos(
                window,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED
                    | SWP_NOMOVE
                    | SWP_NOSIZE
                    | SWP_NOACTIVATE
                    | SWP_NOOWNERZORDER
                    | SWP_NOZORDER,
            ) == 0
            {
                return Err(format!(
                    "无法刷新 GPUI 子窗口边框: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
        Ok(())
    }

    fn update_child(window: HWND, frame: &ChartFrame) -> bool {
        unsafe {
            if !frame.visible {
                ShowWindow(window, SW_HIDE);
                return true;
            }
            SetWindowPos(
                window,
                std::ptr::null_mut(),
                frame.bounds.left,
                frame.bounds.top,
                frame.bounds.width,
                frame.bounds.height,
                SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
            ) != 0
        }
    }

    // The chart HWND sits above WebView2, so leave holes for its foreground controls.
    fn clip_child(window: HWND, bounds: SurfaceBounds, overlays: &[[i32; 4]]) -> bool {
        let rects: Vec<_> = overlays
            .iter()
            .filter_map(|&[l, t, r, b]| {
                let l = (l - bounds.left).max(0);
                let t = (t - bounds.top).max(0);
                let r = (r - bounds.left).min(bounds.width);
                let b = (b - bounds.top).min(bounds.height);
                (l < r && t < b).then_some([l, t, r, b])
            })
            .collect();
        unsafe {
            if rects.is_empty() {
                return SetWindowRgn(window, std::ptr::null_mut(), 1) != 0;
            }
            let region = CreateRectRgn(0, 0, bounds.width, bounds.height);
            if region.is_null() {
                return false;
            }
            for [l, t, r, b] in rects {
                let hole = CreateRectRgn(l, t, r, b);
                if hole.is_null() {
                    DeleteObject(region);
                    return false;
                }
                let combined = CombineRgn(region, region, hole, RGN_DIFF);
                DeleteObject(hole);
                if combined == 0 {
                    DeleteObject(region);
                    return false;
                }
            }
            if SetWindowRgn(window, region, 1) != 0 {
                // Win32 owns the region after a successful SetWindowRgn.
                return true;
            }
            DeleteObject(region);
            false
        }
    }

    fn open_surface(
        cx: &mut App,
        parent: HWND,
    ) -> Result<(WindowHandle<ChartSurface>, HWND), String> {
        let mut native = None;
        let handle = cx
            .open_window(
                WindowOptions {
                    // The popup style has no frame. `None` instead enables GPUI's
                    // custom titlebar handling, which insets WM_NCCALCSIZE as
                    // though this were a resizable top-level window. That clips
                    // the axes-aligned child surface on the sides and bottom.
                    titlebar: Some(TitlebarOptions {
                        appears_transparent: false,
                        ..Default::default()
                    }),
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        point(px(0.0), px(0.0)),
                        size(px(640.0), px(480.0)),
                    ))),
                    window_background: WindowBackgroundAppearance::Transparent,
                    kind: WindowKind::PopUp,
                    focus: false,
                    show: false,
                    is_movable: false,
                    is_resizable: false,
                    is_minimizable: false,
                    ..Default::default()
                },
                |window, cx| {
                    if let Ok(handle) = window.window_handle() {
                        if let RawWindowHandle::Win32(handle) = handle.as_raw() {
                            native = Some(handle.hwnd.get() as HWND);
                        }
                    }
                    cx.new(|_| ChartSurface {
                        frame: Arc::new(ChartFrame::default()),
                    })
                },
            )
            .map_err(|error| format!("无法创建 GPUI 图层: {error:#}"))?;
        let native = native.ok_or("未取得 GPUI 的 Win32 窗口句柄")?;
        attach_child(native, parent)?;
        Ok((handle, native))
    }

    fn run_gpui(
        parent: HWND,
        frames: Arc<RwLock<FrameSet>>,
        wake_rx: async_channel::Receiver<()>,
        ready: Arc<AtomicBool>,
    ) {
        Application::new().run(move |cx: &mut App| {
            let [(main, main_hwnd), (overview, overview_hwnd)] = match open_surface(cx, parent)
                .and_then(|main| open_surface(cx, parent).map(|overview| [main, overview]))
            {
                Ok(surfaces) => surfaces,
                Err(error) => {
                    eprintln!("GPUI 图表初始化失败: {error}");
                    cx.quit();
                    return;
                }
            };
            ready.store(true, Ordering::Release);

            let handles = [main, overview];
            let native = [main_hwnd, overview_hwnd];
            let mut revisions = [0u64; 2];
            let mut overlay_revision = 0;
            let mut placement = [(false, SurfaceBounds::default()); 2];
            cx.spawn(async move |cx| loop {
                if wake_rx.recv().await.is_err() {
                    break;
                }
                let snapshot = frames.read().ok().map(|frames| frames.clone());
                if let Some(snapshot) = snapshot {
                    for slot in 0..2 {
                        let frame_changed = revisions[slot] != snapshot.revisions[slot];
                        let overlay_changed = overlay_revision != snapshot.overlay_revision;
                        if !frame_changed && !overlay_changed {
                            continue;
                        }
                        revisions[slot] = snapshot.revisions[slot];
                        let frame = Arc::clone(&snapshot.frames[slot]);
                        let position = (frame.visible, frame.bounds);
                        let moved = position != placement[slot];
                        placement[slot] = position;
                        let window_ok = !moved || update_child(native[slot], &frame);
                        let clip_ok = !frame.visible
                            || !(moved || overlay_changed)
                            || clip_child(native[slot], frame.bounds, &snapshot.overlays);
                        let view_ok = !frame_changed
                            || handles[slot]
                                .update(cx, |surface, _window, cx| {
                                    surface.frame = frame;
                                    cx.notify();
                                })
                                .is_ok();
                        if !window_ok || !clip_ok || !view_ok {
                            ready.store(false, Ordering::Release);
                            for hwnd in native {
                                unsafe { ShowWindow(hwnd, SW_HIDE) };
                            }
                            return;
                        }
                    }
                    overlay_revision = snapshot.overlay_revision;
                }
            })
            .detach();
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn test_frame() -> Vec<u8> {
            let points = [[0.0_f32, 0.0_f32], [f32::NAN, f32::NAN], [80.0, 48.0]];
            let mut bytes = vec![0; HEADER_BYTES + SERIES_BYTES + points.len() * 8];
            bytes[0..4].copy_from_slice(&MAGIC.to_le_bytes());
            bytes[4] = 1;
            bytes[5] = 1;
            bytes[6] = 1;
            bytes[7] = 1;
            for (offset, value) in [
                (8, 100.0_f32),
                (12, 50.0_f32),
                (16, 200.0_f32),
                (20, 100.0_f32),
                (24, 1.25_f32),
            ] {
                bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            }

            let series = HEADER_BYTES;
            bytes[series..series + 4].copy_from_slice(&2_u32.to_le_bytes());
            bytes[series + 4..series + 8].copy_from_slice(&2.5_f32.to_le_bytes());
            bytes[series + 8..series + 12].copy_from_slice(&0.25_f32.to_le_bytes());
            bytes[series + 12..series + 16].copy_from_slice(&48.0_f32.to_le_bytes());
            bytes[series + 16..series + 20].copy_from_slice(&(points.len() as u32).to_le_bytes());
            bytes[series + 20..series + 23].copy_from_slice(&[0x12, 0x34, 0x56]);
            for (index, point) in points.iter().enumerate() {
                let offset = series + SERIES_BYTES + index * 8;
                bytes[offset..offset + 4].copy_from_slice(&point[0].to_le_bytes());
                bytes[offset + 4..offset + 8].copy_from_slice(&point[1].to_le_bytes());
            }
            bytes
        }

        #[test]
        fn decodes_dpi_scaled_curve_frame_and_nan_gaps() {
            let (slot, frame) = decode_frame(&test_frame()).expect("valid frame");

            assert_eq!(slot, 1);
            assert!(frame.visible);
            assert_eq!(frame.bounds.left, 125);
            assert_eq!(frame.bounds.top, 63);
            assert_eq!(frame.bounds.width, 250);
            assert_eq!(frame.bounds.height, 125);
            assert_eq!(frame.series.len(), 1);
            assert_eq!(frame.series[0].color, 0x123456);
            assert_eq!(frame.series[0].width, 2.5);
            assert_eq!(frame.series[0].fill_opacity, 0.25);
            assert_eq!(frame.series[0].points.len(), 3);
            assert!(frame.series[0].points[1][0].is_nan());
            assert!(frame.series[0].points[1][1].is_nan());
        }

        #[test]
        fn rejects_invalid_frame_headers_and_coordinates() {
            let mut bytes = test_frame();
            bytes[4] = 2;
            assert!(decode_frame(&bytes).is_err());

            let mut bytes = test_frame();
            bytes[5] = 2;
            assert!(decode_frame(&bytes).is_err());

            let mut bytes = test_frame();
            let point = HEADER_BYTES + SERIES_BYTES + 8;
            bytes[point..point + 4].copy_from_slice(&f32::INFINITY.to_le_bytes());
            assert!(decode_frame(&bytes).is_err());

            let mut bytes = test_frame();
            bytes.push(0);
            assert!(decode_frame(&bytes).is_err());
        }
    }
}

#[cfg(target_os = "windows")]
pub use platform::Renderer;

#[cfg(not(target_os = "windows"))]
#[derive(Default)]
pub struct Renderer;

#[cfg(not(target_os = "windows"))]
impl Renderer {
    pub fn is_ready(&self) -> bool {
        false
    }
    pub fn submit(&self, _bytes: &[u8]) -> Result<(), String> {
        Ok(())
    }
    pub fn hide(&self) {}

    pub fn set_overlays(&self, _rects: Vec<[i32; 4]>) -> Result<(), String> {
        Ok(())
    }
}
