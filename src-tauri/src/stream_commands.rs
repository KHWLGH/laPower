// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-or-later
// For original project contributions; see COPYRIGHT.
//! Device connection lifecycle, acquisition stream orchestration and shutdown commands.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use hidapi::HidApi;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::hid_source::{collect_supported_device_infos, device_info_from_hid, HidSource};
use crate::pd_capture::{now_ms, PdEvent};
use crate::{
    acquire, app_error, km003c_session, stream, usb_port, AppState, BackgroundTask, DeviceFamily,
    DeviceInfo, DeviceSession,
};

pub(crate) use stream::Outgoing as DeviceOutgoing;

pub(crate) fn emit_device_outgoing(
    app: &AppHandle,
    samples: &[stream::Sample],
    pds: &[PdEvent],
    end: Option<&stream::End>,
) -> Result<(), String> {
    if !samples.is_empty() {
        app.emit("device-data-batch", samples)
            .map_err(|e| e.to_string())?;
    }
    if !pds.is_empty() {
        app.emit("pd-data-batch", pds).map_err(|e| e.to_string())?;
    }
    if let Some(end) = end {
        let payload = serde_json::json!({
            "generation": end.generation, "last_seq": end.last_seq, "error": end.error,
            "description": end.error.as_ref().map(|detail| app_error::AppError::new("streamStopped", detail.clone()))
        });
        if end.error.is_some() {
            app.emit("stream-error", &payload)
                .map_err(|e| e.to_string())?;
        }
        app.emit("device-stream-end", &payload)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

const PD_IPC_PENDING_CAP: usize = 256;

pub(crate) fn enqueue_pd_pending(pending: &mut VecDeque<PdEvent>, event: PdEvent) {
    if pending.len() >= PD_IPC_PENDING_CAP {
        pending.pop_front();
    }
    pending.push_back(event);
}

/// 把 pending 里的 PD 事件尽量送进通道。发送端已断开时返回 `false`。
pub(crate) fn drain_pd_pending(
    tx: &mpsc::SyncSender<DeviceOutgoing>,
    pending: &mut VecDeque<PdEvent>,
) -> bool {
    while let Some(event) = pending.pop_front() {
        match tx.try_send(DeviceOutgoing::Pd(Box::new(event))) {
            Ok(()) => {}
            Err(mpsc::TrySendError::Disconnected(_)) => return false,
            Err(mpsc::TrySendError::Full(msg)) => {
                if let DeviceOutgoing::Pd(boxed) = msg {
                    pending.push_front(*boxed);
                }
                break;
            }
        }
    }
    true
}

/// Keep the stopped session until its final seq has been acknowledged.
pub(crate) fn drain_device_task(task: &mut BackgroundTask) -> Result<Option<stream::End>, String> {
    task.running.store(false, Ordering::Release);
    for join in task.joins.drain(..) {
        join.join().map_err(|_| "device worker panicked")?;
    }
    match &task.session {
        Some(session) => Ok(session
            .end
            .lock()
            .map_err(|_| "stream end state poisoned")?
            .clone()),
        None => Ok(None),
    }
}

pub(crate) fn stop_task(slot: &mut Option<BackgroundTask>) {
    if let Some(task) = slot.take() {
        task.stop();
    }
}

/// 终态逃生口的前半段：校验并取回末包回执，不动 `consumed`。
///
/// 与 `drain_device_task` 分开放，是为了让 `shutdown` 的严格校验一字不改地继续守着
/// 正常路径。走到这里的生产端已经停止、线程已 join、`end` 已定稿，屏障保护的样本
/// 不会再出现；此时只剩「放行销毁」与「整个进程再也退不出去」两个选项。
/// 这里绝不写 `consumed`——空洞仍然是未消费。
pub(crate) fn abandon_device_task(
    task: &mut BackgroundTask,
    generation: u64,
) -> Result<Option<stream::End>, String> {
    if task.running.load(Ordering::Acquire) {
        return Err("cannot abandon a running stream".into());
    }
    if !task.joins.is_empty() {
        return Err("drain_device_stream must complete before abandon_device_stream".into());
    }
    let Some(session) = task.session.as_ref() else {
        return Ok(None);
    };
    if session.generation != generation {
        return Err("stale stream generation".into());
    }
    let end = session
        .end
        .lock()
        .map_err(|_| "stream end state poisoned")?
        .clone()
        .ok_or("no stream end receipt to abandon")?;
    Ok(Some(end))
}

/// 枚举所有已连接的设备：维简 HID 仪表与 POWER-Z KM003C / KM002C
#[tauri::command(async)]
pub(crate) fn enumerate_devices() -> Result<Vec<DeviceInfo>, crate::app_error::AppError> {
    let result: Result<Vec<DeviceInfo>, String> = (|| {
        let api = HidApi::new().map_err(|e| format!("无法初始化HID API: {}", e))?;
        let mut devices = collect_supported_device_infos(&api);
        devices.extend(km003c_session::device_infos());
        Ok(devices)
    })();
    result.map_err(|detail| crate::app_error::AppError::new("hidInitFailed", detail))
}

/// 获取当前连接的设备信息
#[tauri::command]
pub(crate) fn get_current_device_info(
    state: State<'_, AppState>,
) -> Result<Option<DeviceInfo>, crate::app_error::AppError> {
    state
        .current_device_info
        .lock()
        .map(|info| info.clone())
        .map_err(|_| crate::app_error::AppError::new("backendFailure", "设备信息状态已损坏"))
}

#[tauri::command(async)]
pub(crate) fn connect_device_by_path(
    path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<stream::Open, crate::app_error::AppError> {
    let result: Result<stream::Open, String> = connect_device_on_path(path, &state, app);
    result.map_err(|detail| crate::app_error::AppError::new("deviceConnectionFailed", detail))
}

fn connect_device_on_path(
    path: String,
    state: &AppState,
    app: AppHandle,
) -> Result<stream::Open, String> {
    if let Some(location) = path.strip_prefix(km003c_session::PATH_PREFIX) {
        return km003c_session::connect(&path, location, state, app);
    }
    let api = HidApi::new().map_err(|e| e.to_string())?;

    let current_info = collect_supported_device_infos(&api)
        .into_iter()
        .find(|device| device.path == path)
        .or_else(|| {
            api.device_list()
                .find(|device| device.path().to_string_lossy() == path)
                .map(|device| device_info_from_hid(&api, device))
        })
        .ok_or("找不到指定设备")?;
    let (mut task_slot, had_session) = claim_device_slot(state)?;

    // 与 USB 端口枚举共用非独占打开策略。
    let path_cstr = std::ffi::CString::new(path.clone()).map_err(|e| e.to_string())?;
    let device = match usb_port::open_device_nonexclusive(&api, path_cstr.as_c_str()) {
        Ok(device) => device,
        Err(e) => {
            report_open_failure(state, &app, had_session);
            return Err(format!("无法打开设备: {}", e));
        }
    };
    // 维简仪表没有写通路，不提供协议控制。
    if let Ok(mut control) = state.km003c.lock() {
        *control = None;
    }
    Ok(launch_stream(
        state,
        app,
        &mut task_slot,
        current_info,
        |seed| (HidSource::new(device, seed.epoch), Vec::new()),
    ))
}

/// 为新连接占用设备槽：退出中拒绝；旧代还有未消费的已选点时拒绝退休它。
///
/// 返回持有中的设备槽锁，以及之前是否存在会话（打开失败时据此通知前端断开）。
pub(crate) fn claim_device_slot(
    state: &AppState,
) -> Result<(std::sync::MutexGuard<'_, Option<BackgroundTask>>, bool), String> {
    // Reconnect cannot retire a generation with unconsumed selected data.
    let mut task_slot = state.device_task.lock().map_err(|_| "设备任务状态已损坏")?;
    if state.shutting_down.load(Ordering::Acquire) {
        return Err("app is shutting down".into());
    }
    if let Some(task) = task_slot.as_mut() {
        let end = drain_device_task(task)?.ok_or("missing stream end receipt")?;
        let session = task.session.as_ref().ok_or("missing stream session")?;
        if session.consumed.load(Ordering::Acquire) != end.last_seq {
            return Err("consume and acknowledge old generation before reconnecting".into());
        }
    }
    let had_session = task_slot.is_some();
    stop_task(&mut task_slot);
    Ok((task_slot, had_session))
}

/// 旧会话已退休、新设备却打不开：前端仍以为连着，必须告诉它断开了。
pub(crate) fn report_open_failure(state: &AppState, app: &AppHandle, had_session: bool) {
    if had_session {
        if let Ok(mut info) = state.current_device_info.lock() {
            *info = None;
        }
        let _ = app.emit("device-disconnected", ());
    }
}

/// 新会话的身份与时钟，在构造采集源之前确定。
pub(crate) struct SessionSeed {
    pub generation: u64,
    pub epoch: Instant,
    /// 会话存活标志；读线程、发射线程与附属线程共用。
    pub running: Arc<AtomicBool>,
}

/// 为已打开的设备启动发射线程与读线程，并装入设备槽。
///
/// `build` 在分配 generation 之后构造采集源，可以顺带启动附属线程；附属线程排在
/// 读线程与发射线程之后 join，停止条件同样是 `running`。
pub(crate) fn launch_stream<S, F>(
    state: &AppState,
    app: AppHandle,
    task_slot: &mut Option<BackgroundTask>,
    info: DeviceInfo,
    build: F,
) -> stream::Open
where
    S: acquire::Source + 'static,
    F: FnOnce(&SessionSeed) -> (S, Vec<JoinHandle<()>>),
{
    if let Ok(mut current) = state.current_device_info.lock() {
        *current = Some(info);
    }

    // 每个连接拥有自己的停止标志；旧连接即使延迟醒来也不会看到新连接的状态。
    let running_arc = Arc::new(AtomicBool::new(true));
    let generation = state.generation.fetch_add(1, Ordering::Relaxed) + 1;
    let epoch = Instant::now();
    let wall_anchor_ms = now_ms();
    let seed = SessionSeed {
        generation,
        epoch,
        running: Arc::clone(&running_arc),
    };
    let (source, extra_joins) = build(&seed);

    let (tx, rx) = mpsc::sync_channel(stream::CHANNEL_CAP);
    let (controls, control_rx) = mpsc::sync_channel(64);
    let produced = Arc::new(AtomicU64::new(0));
    let consumed = Arc::new(AtomicU64::new(0));
    let end = Arc::new(Mutex::new(None));
    let emit_app = app.clone();
    let emit_rate_arc = Arc::clone(&state.sample_rate);
    let emit_running = Arc::clone(&running_arc);
    let emit_join = thread::spawn(move || {
        let result = emit_app
            .emit(
                "device-stream-open",
                stream::Open {
                    generation,
                    wall_anchor_ms,
                },
            )
            .map_err(|e| e.to_string())
            .and_then(|()| {
                stream::emit_loop(
                    rx,
                    || {
                        Duration::from_millis(stream::batch_window_ms(
                            emit_rate_arc.load(Ordering::Relaxed),
                        ))
                    },
                    |samples, pds, end| emit_device_outgoing(&emit_app, samples, pds, end),
                )
            });
        if let Err(error) = result {
            emit_running.store(false, Ordering::Release);
            let _ = emit_app.emit(
                "stream-error",
                serde_json::json!({ "generation": generation, "last_seq": 0, "error": error,
                    "description": app_error::AppError::new("streamStopped", error.clone()) }),
            );
        }
    });

    // Only the read thread changes segment/rate, always between device reads.
    let ctx = acquire::ReaderCtx {
        generation,
        epoch,
        wall_anchor_ms,
        running: Arc::clone(&running_arc),
        sample_rate: Arc::clone(&state.sample_rate),
        pd_log: Arc::clone(&state.pd_log),
        pd_capture: Arc::clone(&state.pd_capture_enabled),
        device_info: Arc::clone(&state.current_device_info),
        tx,
        controls: control_rx,
        produced: Arc::clone(&produced),
        consumed: Arc::clone(&consumed),
        end: Arc::clone(&end),
    };
    let read_join = thread::spawn(move || acquire::run_reader(source, ctx));

    let mut joins = vec![read_join, emit_join];
    joins.extend(extra_joins);
    task_slot.replace(BackgroundTask {
        running: running_arc,
        joins,
        session: Some(DeviceSession {
            generation,
            controls,
            produced,
            consumed,
            end,
        }),
    });

    stream::Open {
        generation,
        wall_anchor_ms,
    }
}

#[tauri::command(async)]
pub(crate) fn disconnect_device(
    generation: Option<u64>,
    state: State<'_, AppState>,
) -> Result<Option<stream::End>, crate::app_error::AppError> {
    drain_device_stream(generation, state)
}

#[tauri::command(async)]
pub(crate) fn drain_device_stream(
    generation: Option<u64>,
    state: State<'_, AppState>,
) -> Result<Option<stream::End>, crate::app_error::AppError> {
    let result: Result<Option<stream::End>, String> = (|| {
        let mut slot = state.device_task.lock().map_err(|_| "设备任务状态已损坏")?;
        // A stale drain from an old connection must never stop the newer session.
        let stale = slot
            .as_ref()
            .and_then(|task| task.session.as_ref())
            .is_some_and(|session| generation.is_some_and(|g| session.generation != g));
        if stale {
            return Ok(None);
        }
        let result = slot.as_mut().map(drain_device_task).transpose()?.flatten();
        *state
            .current_device_info
            .lock()
            .map_err(|_| "设备信息状态已损坏")? = None;
        Ok(result)
    })();
    result.map_err(|detail| crate::app_error::AppError::new("backendFailure", detail))
}

/// 退休一个终态会话：让已经死掉的连接不再把「断开 / 重连 / 退出」全部锁死。
///
/// 只接受已经停止且已有末包回执的会话，并且不改写 `consumed`，所以空洞依旧算未消费。
/// `shutdown` 的校验保持原样——放宽只发生在这条显式路径上。
#[tauri::command(async)]
pub(crate) fn abandon_device_stream(
    generation: u64,
    state: State<'_, AppState>,
) -> Result<Option<stream::End>, crate::app_error::AppError> {
    let result: Result<Option<stream::End>, String> = (|| {
        let mut slot = state.device_task.lock().map_err(|_| "设备任务状态已损坏")?;
        let Some(task) = slot.as_mut() else {
            return Ok(None);
        };
        let end = abandon_device_task(task, generation)?;
        slot.take();
        Ok(end)
    })();
    result.map_err(|detail| crate::app_error::AppError::new("backendFailure", detail))
}

#[tauri::command(async)]
pub(crate) fn set_recording_segment(
    generation: u64,
    segment: u64,
    pd_enabled: bool,
    state: State<'_, AppState>,
) -> Result<stream::Boundary, crate::app_error::AppError> {
    let result: Result<stream::Boundary, String> = (|| {
        let (reply, rx) = mpsc::channel();
        {
            let slot = state.device_task.lock().map_err(|_| "设备任务状态已损坏")?;
            let task = slot.as_ref().ok_or("device is not connected")?;
            let session = task.session.as_ref().ok_or("no stream session")?;
            if session.generation != generation || !task.running.load(Ordering::Acquire) {
                return Err("stale or stopped stream generation".into());
            }
            session
                .controls
                .try_send(stream::Control::Segment {
                    segment,
                    pd_enabled,
                    reply,
                })
                .map_err(|e| format!("recording control unavailable: {e}"))?;
        }
        // No timeout: an indeterminate timed-out start must never silently activate later.
        rx.recv()
            .map_err(|_| "device stopped before recording boundary".to_string())?
    })();
    result.map_err(|detail| crate::app_error::AppError::new("backendFailure", detail))
}

#[tauri::command(async)]
pub(crate) fn ack_device_stream(
    generation: u64,
    seq: u64,
    state: State<'_, AppState>,
) -> Result<(), crate::app_error::AppError> {
    let result: Result<(), String> = (|| {
        let slot = state.device_task.lock().map_err(|_| "设备任务状态已损坏")?;
        let session = slot
            .as_ref()
            .and_then(|task| task.session.as_ref())
            .ok_or("no stream session")?;
        if session.generation != generation {
            return Err("stale stream acknowledgment".into());
        }
        if seq > session.produced.load(Ordering::Acquire) {
            return Err("ack beyond selected seq".into());
        }
        session.consumed.fetch_max(seq, Ordering::Release);
        Ok(())
    })();
    result.map_err(|detail| crate::app_error::AppError::new("backendFailure", detail))
}

#[tauri::command(async)]
pub(crate) fn set_sample_rate(
    rate: u64,
    generation: Option<u64>,
    state: State<'_, AppState>,
) -> Result<Option<stream::Boundary>, crate::app_error::AppError> {
    let result: Result<Option<stream::Boundary>, String> = (|| {
        if !(1..=60_000).contains(&rate) {
            return Err("采样间隔必须在 1 到 60000 毫秒之间".to_string());
        }
        let minimum = state
            .current_device_info
            .lock()
            .map_err(|_| "设备信息状态已损坏")?
            .as_ref()
            .map_or(1, |info| {
                if info.family == DeviceFamily::Witrn {
                    10
                } else {
                    1
                }
            });
        if rate < minimum {
            return Err(format!("当前设备的采样间隔不能低于 {minimum} 毫秒"));
        }
        let (reply, rx) = mpsc::channel();
        {
            let slot = state.device_task.lock().map_err(|_| "设备任务状态已损坏")?;
            let live = slot
                .as_ref()
                .filter(|task| task.running.load(Ordering::Acquire))
                .filter(|task| {
                    // 仅对匹配代次下速率命令；旧连接的迟到命令不得改新代。
                    task.session
                        .as_ref()
                        .is_some_and(|s| generation.is_none_or(|g| s.generation == g))
                });
            if let Some(task) = live {
                let session = task.session.as_ref().ok_or("no stream session")?;
                session
                    .controls
                    .try_send(stream::Control::Rate { rate, reply })
                    .map_err(|e| format!("sample rate control unavailable: {e}"))?;
            } else {
                state.sample_rate.store(rate, Ordering::Release);
                return Ok(None);
            }
        }
        rx.recv()
            .map_err(|_| "device stopped before rate boundary".to_string())?
            .map(Some)
    })();
    result.map_err(|detail| crate::app_error::AppError::new("backendFailure", detail))
}

/// 退出流程的唯一入口：先停后台任务，再强制销毁主窗口。
///
/// 必须用 `destroy` 而不是 `close`——`close` 会重新派发 close-requested 事件，
/// 与前端的退出确认监听器构成回环，窗口反而关不掉（Tauri v2 起的行为变更）。
///
/// 标为 `async` 交由 Tauri 的工作线程调度：`stop_task` 会 join 后台线程，
/// 而这些线程退出前可能仍在 `emit`（需要主线程处理），在主线程上阻塞等待会死锁。
#[tauri::command(async)]
pub(crate) fn shutdown(
    generation: Option<u64>,
    last_seq: Option<u64>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), crate::app_error::AppError> {
    let result: Result<(), String> = (|| {
        {
            let slot = state.device_task.lock().map_err(|_| "设备任务状态已损坏")?;
            if let Some(task) = slot.as_ref() {
                let session = task.session.as_ref().ok_or("no stream session")?;
                let end = session
                    .end
                    .lock()
                    .map_err(|_| "stream end state poisoned")?;
                let end = end
                    .as_ref()
                    .ok_or("drain_device_stream must complete before shutdown")?;
                if task.running.load(Ordering::Acquire)
                    || !task.joins.is_empty()
                    || generation != Some(end.generation)
                    || last_seq != Some(end.last_seq)
                    || session.consumed.load(Ordering::Acquire) != end.last_seq
                {
                    return Err("final stream seq has not been consumed and acknowledged".into());
                }
            }
            // Publish the teardown intent while still holding the device lock so a
            // concurrent connect either sees the old session or is rejected outright.
            state.shutting_down.store(true, Ordering::Release);
        }
        if let Ok(mut task) = state.temp_task.lock() {
            stop_task(&mut task);
        }
        // 编码线程不向 WebView 发事件，因此在这里等待它不会与 IPC 发射线程互等；
        // 超时只记日志，进程退出会回收线程，残留的暂存文件带 pid 便于识别。
        state.video_exports.begin_shutdown();
        // 前端已写完落盘尾部；这里只兜底把缓冲写进磁盘。
        if let Ok(mut files) = state.files.lock() {
            files.close_all();
        }
        match app.get_webview_window("main") {
            Some(window) => window.destroy().map_err(|e| e.to_string())?,
            None => app.exit(0),
        }
        Ok(())
    })();
    result.map_err(|detail| crate::app_error::AppError::new("backendFailure", detail))
}
