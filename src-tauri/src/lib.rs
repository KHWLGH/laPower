// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-or-later
// For original project contributions; see COPYRIGHT.
mod acquire;
mod app_error;
#[cfg(target_os = "macos")]
mod app_menu;
mod app_nap;
// Public so `boot_timing` callers can read the file it writes without duplicating the layout.
pub mod boot_timing;
mod custom_background;
mod file_io;
mod hid_source;
mod km003c_session;
mod locale;
mod pd_capture;
mod pd_commands;
// Public only so `cargo bench` can drive the emit path; the app itself never re-exports it.
pub mod stream;
mod stream_commands;
mod temp_commands;
mod temperature_reader;
mod titlebar;
mod updates;
mod usb_port;
mod video_export;
#[cfg(target_os = "windows")]
mod windows_icon;

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tauri::{Emitter, Manager};

use pd_capture::PdLog;

/// 已知的维简设备型号
#[derive(Clone)]
pub struct KnownDevice {
    pub name: &'static str,
    pub vid: u16,
    pub pid: u16,
}

/// 维简设备的厂商 ID
pub const WITRN_VID: u16 = 0x0716;

/// 支持的维简设备列表
pub const KNOWN_DEVICES: &[KnownDevice] = &[
    KnownDevice {
        name: "WITRN K2",
        vid: WITRN_VID,
        pid: 0x5060,
    },
    KnownDevice {
        name: "WITRN U3",
        vid: WITRN_VID,
        pid: 0x5063,
    },
    // Some U3 firmware/variants report PID 0x5044 (observed in the field).
    KnownDevice {
        name: "WITRN U3",
        vid: WITRN_VID,
        pid: 0x5044,
    },
    // Some C5 firmware/variants report PID 0x5053 (observed in the field).
    KnownDevice {
        name: "WITRN C5",
        vid: WITRN_VID,
        pid: 0x5053,
    },
    KnownDevice {
        name: "WITRN C5",
        vid: WITRN_VID,
        pid: 0x5064,
    },
];

/// 设备家族：决定采集源、是否提供协议控制
#[derive(Clone, Copy, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DeviceFamily {
    Witrn,
    Km003c,
}

/// 枚举到的设备信息
#[derive(Clone, Serialize, Debug)]
pub struct DeviceInfo {
    pub path: String,
    pub vid: u16,
    pub pid: u16,
    pub serial_number: Option<String>,
    pub usb_port: Option<String>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub model_name: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_description: Option<app_error::AppError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) interface_description: Option<app_error::AppError>,
    pub interface_number: i32,
    pub usage_page: u16,
    pub family: DeviceFamily,
    /// 支持协议触发（PDM / PD 请求 / 快充触发）
    pub controls: bool,
    /// 设备能提供的最高采样率（次/秒）
    pub max_rate_hz: u32,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
pub(crate) struct DeviceData {
    pub(crate) voltage: f32,
    pub(crate) current: f32,
    pub(crate) power: f32,
    pub(crate) dp: Option<f32>,          // D+；越界或缺测为 null，不断整帧
    pub(crate) dn: Option<f32>,          // D-
    pub(crate) cc1: f32,                 // CC1
    pub(crate) cc2: f32,                 // CC2
    pub(crate) temperature: Option<f32>, // 仪表温度；缺失为 null，避免 JSON NaN 丢掉整帧
    pub(crate) ah: Option<f32>,          // 仪表累计容量 Ah；没有累加器的设备为 null
    pub(crate) wh: Option<f32>,          // 仪表累计能量 Wh
}

pub(crate) struct DeviceSession {
    pub(crate) generation: u64,
    pub(crate) controls: mpsc::SyncSender<stream::Control>,
    pub(crate) produced: Arc<AtomicU64>,
    pub(crate) consumed: Arc<AtomicU64>,
    pub(crate) end: Arc<Mutex<Option<stream::End>>>,
}

pub(crate) struct BackgroundTask {
    pub(crate) running: Arc<AtomicBool>,
    /// Producer precedes emitter; commands joining these always run off the UI thread.
    pub(crate) joins: Vec<JoinHandle<()>>,
    pub(crate) session: Option<DeviceSession>,
}

impl BackgroundTask {
    pub(crate) fn stop(self) {
        self.running.store(false, Ordering::Relaxed);
        for join in self.joins {
            if join.join().is_err() {
                eprintln!("后台任务线程异常退出");
            }
        }
    }
}

pub(crate) struct AppState {
    pub(crate) device_task: Mutex<Option<BackgroundTask>>,
    pub(crate) generation: AtomicU64,
    pub(crate) sample_rate: Arc<AtomicU64>,
    pub(crate) current_device_info: Arc<Mutex<Option<DeviceInfo>>>,
    pub(crate) temp_task: Mutex<Option<BackgroundTask>>,
    pub(crate) pd_log: Arc<Mutex<PdLog>>,
    pub(crate) pd_capture_enabled: Arc<AtomicBool>,
    /// 当前 POWER-Z 会话的协议控制句柄；与设备槽分开加锁，排空流时不阻塞取消。
    pub(crate) km003c: Mutex<Option<km003c_session::Km003cControl>>,
    /// CSV 导入 / 导出 / 临时恢复文件的文件句柄。
    pub(crate) files: Mutex<file_io::FileRegistry>,
    /// 报告视频的单槽编码任务；编码线程自己持有 `Arc`，不借用 `State`。
    pub(crate) video_exports: std::sync::Arc<video_export::VideoExports>,
    /// 末包已校验、进入销毁流程：置位后禁止新建连接，退出事件放行。
    pub(crate) shutting_down: AtomicBool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            device_task: Mutex::new(None),
            generation: AtomicU64::new(0),
            sample_rate: Arc::new(AtomicU64::new(250)),
            current_device_info: Arc::new(Mutex::new(None)),
            temp_task: Mutex::new(None),
            pd_log: Arc::new(Mutex::new(PdLog::default())),
            // 默认跟随记录且未开始记录：与前端 ingest 门控一致，不入库。
            pd_capture_enabled: Arc::new(AtomicBool::new(false)),
            km003c: Mutex::new(None),
            files: Mutex::new(file_io::FileRegistry::default()),
            video_exports: std::sync::Arc::new(video_export::VideoExports::default()),
            shutting_down: AtomicBool::new(false),
        }
    }
}

/// 返回原生运行平台，不依赖 WebView 的 UA 或窗口样式。
#[tauri::command]
fn get_runtime_platform() -> &'static str {
    std::env::consts::OS
}

/// Return the locale selected by the host environment. The frontend applies
/// the language mapping and browser fallback so this command stays read-only.
#[tauri::command]
fn get_system_locale() -> String {
    locale::system_locale()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    boot_timing::mark("run_enter");
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build());
    boot_timing::mark("plugins_registered");

    // macOS keeps the native traffic lights (tauri.macos.conf.json), so it has
    // no use for decorum's overlay titlebar, and decorum's traffic-light
    // positioner can dereference a missing Cocoa superview during window
    // creation. Keep the plugin on Windows and Linux.
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.plugin(tauri_plugin_decorum::init());
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .menu(app_menu::build)
            .on_menu_event(app_menu::handle);
    }

    let app = builder
        .manage(AppState::default())
        .setup(|app| {
            boot_timing::mark("setup_enter");
            file_io::start_spool_checkpoints(app.handle().clone());
            // 自定义标题栏：Windows 由 decorum 注入带贴靠布局浮窗的窗口控制按钮
            // （前端按设计令牌重绘，并用内置 Fluent SVG 替换 Segoe 字形以免 Win10 缺字）；
            // Linux 无此支持，改由前端 windowcontrols.js 自绘按钮与边缘调整大小热区。
            #[cfg(target_os = "windows")]
            {
                use tauri_plugin_decorum::WebviewWindowExt;
                let main_window = app
                    .get_webview_window("main")
                    .expect("main window must exist");
                main_window
                    .create_overlay_titlebar()
                    .expect("failed to create overlay titlebar");
                boot_timing::mark("titlebar_created");
                windows_icon::configure(&main_window);
            }
            boot_timing::mark("setup_exit");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            updates::check_for_updates,
            updates::open_project_page,
            boot_timing::get_boot_timing,
            boot_timing::report_boot_timing,
            get_runtime_platform,
            get_system_locale,
            custom_background::choose_custom_background,
            custom_background::load_custom_background,
            custom_background::clear_custom_background,
            titlebar::titlebar_double_click,
            stream_commands::connect_device_by_path,
            stream_commands::disconnect_device,
            stream_commands::drain_device_stream,
            stream_commands::abandon_device_stream,
            stream_commands::set_recording_segment,
            stream_commands::ack_device_stream,
            stream_commands::set_sample_rate,
            stream_commands::shutdown,
            stream_commands::enumerate_devices,
            stream_commands::get_current_device_info,
            temp_commands::connect_temp_service,
            temp_commands::disconnect_temp_service,
            pd_commands::set_pd_capture_enabled,
            pd_commands::pd_log_clear,
            pd_commands::decode_pd_at,
            pd_commands::pd_log_after,
            pd_commands::pd_log_import,
            pd_commands::pd_log_import_page,
            km003c_session::trigger_worker::km003c_trigger,
            km003c_session::trigger_worker::km003c_cancel_trigger,
            file_io::csv_export_pick,
            file_io::pd_export_pick,
            file_io::text_export_pick,
            file_io::png_export_pick,
            file_io::paired_export_pick,
            file_io::csv_import_pick,
            file_io::pd_import_pick,
            file_io::csv_read_chunk,
            file_io::csv_read_close,
            file_io::csv_write_chunk,
            file_io::csv_write_patch,
            file_io::csv_write_sync,
            file_io::csv_write_close,
            file_io::spool_open,
            file_io::spool_recovery_list,
            file_io::spool_recovery_open,
            file_io::spool_recovery_delete,
            video_export::video_export_capability,
            video_export::video_export_pick,
            video_export::video_export_start,
            video_export::video_export_status,
            video_export::video_export_current,
            video_export::video_export_cancel,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // 原生退出（macOS 菜单 / ⌘Q、末窗口销毁）不会经过前端 onCloseRequested。首次
    // ExitRequested 拦下并交给前端，走与关闭按钮一致的确认 + 排空 + ACK 流程；
    // shutdown 校验通过、置位 shutting_down 后再次派发的 ExitRequested 才真正放行。
    app.run(|handle, event| {
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            let state = handle.state::<AppState>();
            if state.shutting_down.load(Ordering::Acquire) || code.is_some() {
                return;
            }
            api.prevent_exit();
            let _ = handle.emit("app-exit-requested", ());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hid_source::*;
    use crate::stream_commands::*;
    use std::collections::VecDeque;
    use std::thread;
    use std::time::{Duration, Instant};

    fn valid_frame() -> [u8; 64] {
        let mut frame = [0u8; 64];
        frame[0] = 0xFF;
        frame[14..18].copy_from_slice(&1.25f32.to_le_bytes());
        frame[18..22].copy_from_slice(&4.5f32.to_le_bytes());
        frame[30..34].copy_from_slice(&1.2f32.to_le_bytes());
        frame[34..38].copy_from_slice(&1.1f32.to_le_bytes());
        frame[42..46].copy_from_slice(&23.5f32.to_le_bytes());
        frame[46..50].copy_from_slice(&5.0f32.to_le_bytes());
        frame[50..54].copy_from_slice(&2.0f32.to_le_bytes());
        frame[55] = 50;
        frame[56] = 90;
        frame
    }

    struct QueuedHid {
        reports: Mutex<VecDeque<Option<[u8; 64]>>>,
        timeouts: Mutex<Vec<i32>>,
    }

    impl QueuedHid {
        fn new(reports: impl IntoIterator<Item = Option<[u8; 64]>>) -> Self {
            Self {
                reports: Mutex::new(reports.into_iter().collect()),
                timeouts: Mutex::new(Vec::new()),
            }
        }
    }

    impl HidReader for QueuedHid {
        fn read_timeout(&self, buf: &mut [u8], timeout_ms: i32) -> Result<usize, hidapi::HidError> {
            self.timeouts.lock().unwrap().push(timeout_ms);
            match self.reports.lock().unwrap().pop_front().flatten() {
                Some(report) => {
                    buf[..report.len()].copy_from_slice(&report);
                    Ok(report.len())
                }
                None => Ok(0),
            }
        }
    }

    #[test]
    fn hid_boundary_drains_old_reports_and_fences_the_next_backdated_batch() {
        use crate::acquire::Source;
        // Four old reports, empty queue, then three reports arriving during boundary work.
        let queue = QueuedHid::new(
            std::iter::repeat_n(Some(valid_frame()), 4)
                .chain([None])
                .chain(std::iter::repeat_n(Some(valid_frame()), 3))
                .chain([None]),
        );
        let epoch = Instant::now() - Duration::from_millis(150);
        let mut source = HidSource::new(queue, epoch);
        source.last_sample_us = Some(100_000);
        let mut old = Vec::new();
        assert!(source.barrier(&mut old).is_ok());
        assert_eq!(old.len(), 4, "the old segment owns every queued report");
        assert!(old
            .windows(2)
            .all(|pair| pair[0].received_us < pair[1].received_us));
        assert!(source
            .device
            .timeouts
            .lock()
            .unwrap()
            .iter()
            .all(|&ms| ms == 0));
        let boundary = epoch.elapsed().as_micros() as u64;
        source.seal_boundary(boundary);
        let mut new = Vec::new();
        assert!(source.read(10, &mut new).is_ok());
        assert_eq!(new.len(), 3);
        assert!(new.iter().all(|arrival| arrival.received_us >= boundary));
        assert!(new
            .windows(2)
            .all(|pair| pair[0].received_us <= pair[1].received_us));
    }

    #[test]
    fn empty_hid_boundary_still_fences_pause_resume_and_rate_changes() {
        use crate::acquire::Source;
        let queue = QueuedHid::new([None, Some(valid_frame()), Some(valid_frame()), None]);
        let epoch = Instant::now() - Duration::from_millis(150);
        let mut source = HidSource::new(queue, epoch);
        source.last_sample_us = Some(100_000);
        let mut old = Vec::new();
        assert!(source.barrier(&mut old).is_ok());
        assert!(old.is_empty());
        let boundary = epoch.elapsed().as_micros() as u64;
        source.seal_boundary(boundary);
        let mut new = Vec::new();
        assert!(source.read(10, &mut new).is_ok());
        assert_eq!(new.len(), 2);
        assert!(new.iter().all(|arrival| arrival.received_us >= boundary));
    }

    #[test]
    fn reader_hid_boundaries_keep_old_backlogs_in_their_original_segments() {
        use crate::acquire::{Arrival, ReaderCtx, Source, Stop};
        struct Once {
            hid: HidSource<QueuedHid>,
            read: bool,
        }
        impl Source for Once {
            fn min_rate_ms(&self) -> u64 {
                10
            }
            fn read(&mut self, rate: u64, out: &mut Vec<Arrival>) -> Result<(), Stop> {
                if self.read {
                    return Err(Stop::Unplugged);
                }
                self.read = true;
                self.hid.read(rate, out)
            }
            fn barrier(&mut self, out: &mut Vec<Arrival>) -> Result<(), Stop> {
                self.hid.barrier(out)
            }
            fn seal_boundary(&mut self, at: u64) {
                self.hid.seal_boundary(at);
            }
        }
        let queue = QueuedHid::new(
            (0..4).flat_map(|_| std::iter::repeat_n(Some(valid_frame()), 3).chain([None])),
        );
        let epoch = Instant::now() - Duration::from_millis(150);
        let mut hid = HidSource::new(queue, epoch);
        hid.last_sample_us = Some(100_000);
        let (tx, rx) = mpsc::sync_channel(4096);
        let (control_tx, controls) = mpsc::sync_channel(8);
        let replies = [1, 0, 2].map(|segment| {
            let (reply, rx) = mpsc::channel();
            control_tx
                .send(stream::Control::Segment {
                    segment,
                    pd_enabled: false,
                    reply,
                })
                .unwrap();
            rx
        });
        acquire::run_reader(
            Once { hid, read: false },
            ReaderCtx {
                generation: 1,
                epoch,
                wall_anchor_ms: 1000,
                running: Arc::new(AtomicBool::new(true)),
                sample_rate: Arc::new(AtomicU64::new(10)),
                pd_log: Arc::new(Mutex::new(PdLog::default())),
                pd_capture: Arc::new(AtomicBool::new(false)),
                device_info: Arc::new(Mutex::new(None)),
                tx,
                controls,
                produced: Arc::new(AtomicU64::new(0)),
                consumed: Arc::new(AtomicU64::new(0)),
                end: Arc::new(Mutex::new(None)),
            },
        );
        let boundaries = replies.map(|rx| rx.recv().unwrap().unwrap());
        let points: Vec<_> = rx
            .into_iter()
            .filter_map(|item| match item {
                DeviceOutgoing::Sample(point) => Some(point),
                _ => None,
            })
            .collect();
        assert!(
            boundaries[0].after_seq > 0,
            "preview backlog is drained before recording starts"
        );
        for (start, end, segment) in [
            (0, boundaries[0].after_seq, 0),
            (boundaries[0].after_seq, boundaries[1].after_seq, 1),
            (boundaries[1].after_seq, boundaries[2].after_seq, 0),
        ] {
            assert!(end > start, "the old backlog was not dropped");
            assert!(points
                .iter()
                .filter(|point| point.seq > start && point.seq <= end)
                .all(|point| point.segment == segment));
        }
        let resumed: Vec<_> = points
            .iter()
            .filter(|point| point.seq > boundaries[2].after_seq)
            .collect();
        assert!(!resumed.is_empty());
        assert!(resumed
            .iter()
            .all(|point| point.segment == 2 && point.received_us >= boundaries[2].received_us));
        assert!(points
            .iter()
            .filter(|point| point.segment != 0)
            .all(|point| point.received_us >= point.segment_start_us));
    }

    #[test]
    fn hid_boundary_rejects_a_queue_that_exceeds_the_bounded_drain() {
        use crate::acquire::Source;
        for count in [BACKLOG_DRAIN_CAP, BACKLOG_DRAIN_CAP + 1] {
            let queue =
                QueuedHid::new(std::iter::repeat_n(Some(valid_frame()), count).chain([None]));
            let mut source = HidSource::new(queue, Instant::now());
            let mut out = Vec::new();
            let result = source.barrier(&mut out);
            if count == BACKLOG_DRAIN_CAP {
                assert!(result.is_ok());
                assert_eq!(out.len(), count);
            } else {
                assert!(matches!(result, Err(acquire::Stop::Failed(_))));
                assert!(
                    out.is_empty(),
                    "a failed barrier publishes no partial batch"
                );
            }
        }
    }

    fn device_info(path: &str, interface_number: i32, usage_page: u16) -> DeviceInfo {
        DeviceInfo {
            path: path.to_string(),
            vid: 0x0716,
            pid: 0x5060,
            serial_number: Some("test-device".to_string()),
            usb_port: Some("4-4".to_string()),
            manufacturer: Some("WITRN".to_string()),
            product: Some("K2".to_string()),
            model_name: "WITRN K2".to_string(),
            display_name: "WITRN K2 (USB 4-4)".to_string(),
            model_description: None,
            interface_description: None,
            interface_number,
            usage_page,
            family: DeviceFamily::Witrn,
            controls: false,
            max_rate_hz: 100,
        }
    }

    #[test]
    fn decode_to_transport_pipeline_is_lossless_and_bit_exact() {
        // Exercises the real HID decode -> window selection -> channel -> batch emitter chain
        // at volume: every decoded frame must survive in order, gapless, with bit-exact f32
        // channels. Timing is informational (debug profile); WebView/HID latency not covered.
        let decoded = parse_device_data(&valid_frame()).expect("valid frame decodes");
        const N: u64 = 50_000;
        let (tx, rx) = mpsc::sync_channel::<stream::Outgoing>(N as usize + stream::CHANNEL_CAP);
        let produced = Arc::new(AtomicU64::new(0));
        let mut selection = stream::Selection::new(stream::SELECTED_CAP, Arc::clone(&produced));
        let consumer = thread::spawn(move || {
            let mut out = Vec::new();
            stream::emit_loop(
                rx,
                || Duration::from_millis(stream::BATCH_MS_FLOOR),
                |samples, _, _| {
                    out.extend_from_slice(samples);
                    Ok(())
                },
            )
            .unwrap();
            out
        });
        let started = Instant::now();
        for i in 0..N {
            selection.offer(stream::Sample {
                data: decoded.clone(),
                current_abs: None,
                power_abs: None,
                generation: 1,
                seq: 0,
                segment: 1,
                received_us: i * 10_000,
                wall_anchor_ms: 0,
                segment_start_us: 0,
                rate_ms: 10,
            });
            selection
                .select()
                .expect("backlog stays bounded with a live consumer");
            selection.drain(&tx).expect("emitter attached");
        }
        selection.select().expect("final select");
        selection.finish(&tx).expect("finish drains to consumer");
        drop(tx);
        let points = consumer.join().unwrap();
        let secs = started.elapsed().as_secs_f64();
        assert_eq!(
            points.len() as u64,
            N,
            "decode->transport must drop or duplicate nothing"
        );
        assert_eq!(produced.load(Ordering::Acquire), N);
        assert!(
            points.iter().all(|p| p.data == decoded),
            "f32 channels must survive the transport bit-for-bit"
        );
        for (i, p) in points.iter().enumerate() {
            assert_eq!(p.seq, i as u64 + 1, "sequence stays gapless and monotonic");
            assert_eq!(
                p.received_us,
                (i as u64) * 10_000,
                "a one-frame window keeps its own receive time"
            );
        }
        eprintln!(
            "native decode->transport: {N} frames in {:.1} ms = {:.0} pts/s (real HID decode + window + channel + batch emitter)",
            secs * 1000.0,
            N as f64 / secs
        );
    }

    #[test]
    fn drain_joins_final_delivery_and_keeps_the_unacknowledged_session() {
        let (tx, rx) = mpsc::sync_channel(1);
        let (controls, _control_rx) = mpsc::sync_channel(1);
        let produced = Arc::new(AtomicU64::new(0));
        let consumed = Arc::new(AtomicU64::new(0));
        let end = Arc::new(Mutex::new(None));
        let reader_end = Arc::clone(&end);
        let mut selection = stream::Selection::new(2, Arc::clone(&produced));
        for received_us in [10, 20, 30] {
            selection.offer(stream::Sample {
                data: parse_device_data(&valid_frame()).unwrap(),
                current_abs: None,
                power_abs: None,
                generation: 7,
                seq: 0,
                segment: 1,
                received_us,
                wall_anchor_ms: 1000,
                segment_start_us: 0,
                rate_ms: 10,
            });
            if received_us != 30 {
                selection.select().unwrap();
                selection.drain(&tx).unwrap();
            }
        }
        let read_join = thread::spawn(move || {
            selection.finish(&tx).unwrap();
            let receipt = stream::End {
                generation: 7,
                last_seq: selection.seq,
                error: None,
            };
            *reader_end.lock().unwrap() = Some(receipt.clone());
            tx.send(DeviceOutgoing::End(receipt)).unwrap();
        });
        let delivered = Arc::new(Mutex::new((Vec::new(), None)));
        let emitted = Arc::clone(&delivered);
        let emit_join = thread::spawn(move || {
            stream::emit_loop(
                rx,
                || Duration::from_millis(stream::BATCH_MS_FLOOR),
                |samples, _, end| {
                    let mut output = emitted.lock().unwrap();
                    assert!(output.1.is_none(), "no samples may follow End");
                    output.0.extend_from_slice(samples);
                    output.1 = end.cloned();
                    Ok(())
                },
            )
            .unwrap();
        });
        let mut task = BackgroundTask {
            running: Arc::new(AtomicBool::new(true)),
            joins: vec![read_join, emit_join],
            session: Some(DeviceSession {
                generation: 7,
                controls,
                produced,
                consumed,
                end,
            }),
        };
        let receipt = drain_device_task(&mut task).unwrap().unwrap();
        assert!(!task.running.load(Ordering::Acquire));
        assert!(task.joins.is_empty());
        assert_eq!((receipt.generation, receipt.last_seq), (7, 3));
        assert!(receipt.error.is_none());
        let session = task.session.as_ref().unwrap();
        assert_eq!(session.produced.load(Ordering::Acquire), receipt.last_seq);
        assert_eq!(
            session.consumed.load(Ordering::Acquire),
            0,
            "delivery is not a frontend ack"
        );
        let output = delivered.lock().unwrap();
        assert_eq!(
            output
                .0
                .iter()
                .map(|s| (s.seq, s.received_us))
                .collect::<Vec<_>>(),
            [(1, 10), (2, 20), (3, 30)]
        );
        assert_eq!(output.1.as_ref().unwrap().last_seq, receipt.last_seq);
        assert_eq!(
            drain_device_task(&mut task).unwrap().unwrap().last_seq,
            receipt.last_seq
        );
    }

    /// 终态逃生口只能退休「已停止 + 已有末包回执 + 同代」的会话，且不得冒充 ACK。
    #[test]
    fn abandon_only_retires_a_stopped_session_with_a_receipt() {
        let (controls, _control_rx) = mpsc::sync_channel(1);
        let end = Arc::new(Mutex::new(None));
        let consumed = Arc::new(AtomicU64::new(1));
        let mut task = BackgroundTask {
            running: Arc::new(AtomicBool::new(true)),
            joins: vec![],
            session: Some(DeviceSession {
                generation: 7,
                controls,
                produced: Arc::new(AtomicU64::new(3)),
                consumed: Arc::clone(&consumed),
                end: Arc::clone(&end),
            }),
        };

        assert!(
            abandon_device_task(&mut task, 7).is_err(),
            "a running producer must not be abandoned"
        );
        task.running.store(false, Ordering::Release);
        assert!(
            abandon_device_task(&mut task, 7).is_err(),
            "no receipt yet: the drain must complete first"
        );

        *end.lock().unwrap() = Some(stream::End {
            generation: 7,
            last_seq: 3,
            error: None,
        });
        assert!(
            abandon_device_task(&mut task, 8).is_err(),
            "a stale generation must not retire the newer session"
        );

        let receipt = abandon_device_task(&mut task, 7).unwrap().unwrap();
        assert_eq!((receipt.generation, receipt.last_seq), (7, 3));
        assert_eq!(
            consumed.load(Ordering::Acquire),
            1,
            "abandoning is not an acknowledgment of the hole"
        );
        assert!(
            task.session.is_some(),
            "the helper validates; only the command retires the slot"
        );
    }

    #[test]
    fn known_pids_map_to_model_names() {
        assert_eq!(model_name_for(WITRN_VID, 0x5060), "WITRN K2");
        assert_eq!(model_name_for(WITRN_VID, 0x5063), "WITRN U3");
        assert_eq!(model_name_for(WITRN_VID, 0x5044), "WITRN U3");
        assert_eq!(model_name_for(WITRN_VID, 0x5053), "WITRN C5");
        assert_eq!(model_name_for(WITRN_VID, 0x5064), "WITRN C5");
        assert_eq!(
            model_name_for(WITRN_VID, 0x50FF),
            "Unknown WITRN device (0716:50FF)"
        );
    }

    #[test]
    fn parses_valid_frame_at_protocol_offsets() {
        let data = parse_device_data(&valid_frame()).expect("valid frame should parse");
        assert_eq!(data.voltage, 5.0);
        assert_eq!(data.current, 2.0);
        assert_eq!(data.power, 10.0);
        assert_eq!(data.temperature, Some(23.5));
        assert_eq!(data.cc1, 5.0);
        assert_eq!(data.cc2, 9.0);
    }

    #[test]
    fn rejects_wrong_header_and_non_finite_values() {
        let mut frame = valid_frame();
        frame[0] = 0;
        assert!(parse_device_data(&frame).is_none());

        let mut frame = valid_frame();
        frame[46..50].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(parse_device_data(&frame).is_none());
    }

    #[test]
    fn rejects_out_of_range_measurements() {
        let mut frame = valid_frame();
        frame[46..50].copy_from_slice(&60.1f32.to_le_bytes());
        assert!(parse_device_data(&frame).is_none());

        let mut frame = valid_frame();
        frame[50..54].copy_from_slice(&10.1f32.to_le_bytes());
        assert!(
            parse_device_data(&frame).is_some(),
            "10.1 A overshoot should still parse"
        );

        let mut frame = valid_frame();
        frame[50..54].copy_from_slice(&20.1f32.to_le_bytes());
        assert!(parse_device_data(&frame).is_none());
    }

    #[test]
    fn keeps_frame_but_drops_temperature_when_out_of_range() {
        let mut frame = valid_frame();
        frame[42..46].copy_from_slice(&150.1f32.to_le_bytes());

        let data = parse_device_data(&frame).expect("越界温度不应丢掉整帧");
        assert_eq!(data.voltage, 5.0);
        assert_eq!(data.temperature, None);
        let json = serde_json::to_string(&data).expect("缺失温度必须能进 JSON");
        assert!(
            json.contains("\"temperature\":null"),
            "temperature must serialize as null, got {json}"
        );
    }

    #[test]
    fn drops_out_of_range_data_lines_without_rejecting_the_frame() {
        let mut frame = valid_frame();
        frame[30..34].copy_from_slice(&1e20f32.to_le_bytes());
        let data = parse_device_data(&frame).expect("越界 D+ 不应丢掉整帧");
        assert_eq!(data.voltage, 5.0);
        assert_eq!(data.dp, None);
    }

    #[test]
    fn prefers_vendor_defined_hid_interface_for_same_physical_device() {
        let devices = vec![
            device_info("keyboard", 0, 0x0001),
            device_info("data", 1, 0xFF00),
        ];

        let filtered = prefer_vendor_defined_interfaces(devices);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].path, "data");
    }

    #[test]
    fn keeps_same_batch_meters_on_different_ports_separate() {
        let mut left = device_info("left", 1, 0xFF00);
        left.usb_port = Some("4-4".to_string());
        let mut right = device_info("right", 1, 0xFF00);
        right.path = "right".to_string();
        right.usb_port = Some("4-5".to_string());

        let filtered = prefer_vendor_defined_interfaces(vec![left, right]);
        assert_eq!(filtered.len(), 2);
    }

    #[test]
    fn uses_usb_port_to_group_devices_without_serial_numbers() {
        let mut keyboard = device_info("keyboard", 0, 0x0001);
        keyboard.serial_number = None;
        keyboard.usb_port = Some("4-4".to_string());

        let mut data = device_info("data", 1, 0xFF00);
        data.serial_number = None;
        data.usb_port = Some("4-5".to_string());

        let filtered = prefer_vendor_defined_interfaces(vec![keyboard, data]);
        assert_eq!(filtered.len(), 2);
    }

    #[test]
    fn keeps_usb_name_when_adding_multiple_interface_suffixes() {
        let devices = finalize_device_infos(vec![
            device_info("data-0", 0, 0xFF00),
            device_info("data-1", 1, 0xFF01),
        ]);

        assert_eq!(
            devices[0].display_name,
            "WITRN K2 (USB 4-4) [Interface 0 / Usage 0xFF00]"
        );
        assert_eq!(
            devices[1].display_name,
            "WITRN K2 (USB 4-4) [Interface 1 / Usage 0xFF01]"
        );
    }
}
