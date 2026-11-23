// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-or-later
// For original project contributions; see COPYRIGHT.
//! Background CDC trigger worker thread and Tauri trigger commands for POWER-Z meters.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use km003c::trigger::{PdoCache, TriggerSession};
use km003c::{TriggerCommand, TriggerOutcome};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

/// How often the trigger thread checks whether its session is still running.
const TRIGGER_IDLE: Duration = Duration::from_millis(100);

pub(super) const MAX_TRANSCRIPT_BYTES: usize = 256 * 1024;

#[derive(Default)]
pub(super) struct TriggerTranscript {
    pub(super) lines: VecDeque<String>,
    pub(super) bytes: usize,
    pub(super) truncated: bool,
}

impl TriggerTranscript {
    pub(super) fn push(&mut self, text: &str) {
        for line in text.lines().filter(|line| !line.is_empty()) {
            // A single oversized line is discarded whole, never inside UTF-8.
            if line.len() + 1 > MAX_TRANSCRIPT_BYTES {
                self.lines.clear();
                self.bytes = 0;
                self.truncated = true;
                continue;
            }
            while self.bytes + line.len() + 1 > MAX_TRANSCRIPT_BYTES {
                if let Some(old) = self.lines.pop_front() {
                    self.bytes -= old.len() + 1;
                    self.truncated = true;
                }
            }
            self.bytes += line.len() + 1;
            self.lines.push_back(line.to_string());
        }
    }
}

#[derive(Serialize)]
pub(crate) struct TriggerReply {
    #[serde(flatten)]
    pub(super) outcome: TriggerOutcome,
    pub(super) transcript: String,
    pub(super) transcript_truncated: bool,
}

/// Handles the trigger commands need, kept outside the device slot so a draining stream
/// never blocks a cancel.
pub(crate) struct Km003cControl {
    pub(super) generation: u64,
    pub(super) tx: mpsc::Sender<TriggerMsg>,
    pub(super) busy: Arc<AtomicBool>,
    pub(super) cancel: Arc<AtomicBool>,
}

pub(super) enum TriggerMsg {
    Run {
        cmd: TriggerCommand,
        req_id: String,
        reply: mpsc::Sender<TriggerReply>,
    },
    /// The bulk handle was reopened; the CDC port and entered protocol are stale.
    DropCdc,
}

#[derive(Clone, Serialize)]
struct TriggerProgress<'a> {
    generation: u64,
    req_id: &'a str,
    text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detection: Option<&'a km003c::DetectionReport>,
}

#[derive(Clone, Serialize)]
pub(super) struct PdmState {
    generation: u64,
    pub(super) open: bool,
    pub(super) message: &'static str,
    pub(super) description: crate::app_error::AppError,
}

/// Commands run one at a time, in arrival order, until the session stops.
pub(super) fn trigger_loop(
    mut session: TriggerSession,
    rx: mpsc::Receiver<TriggerMsg>,
    running: Arc<AtomicBool>,
    pdo_cache: PdoCache,
    app: AppHandle,
    generation: u64,
) {
    while running.load(Ordering::Acquire) {
        match rx.recv_timeout(TRIGGER_IDLE) {
            Ok(TriggerMsg::Run { cmd, req_id, reply }) => {
                let mut transcript = TriggerTranscript::default();
                let outcome = session.run_with_detection(
                    &cmd,
                    &pdo_cache,
                    &mut |text| {
                        transcript.push(text);
                        let _ = app.emit(
                            "km003c-trigger-progress",
                            TriggerProgress {
                                generation,
                                req_id: &req_id,
                                text,
                                detection: None,
                            },
                        );
                    },
                    &mut |detection| {
                        let _ = app.emit(
                            "km003c-trigger-progress",
                            TriggerProgress {
                                generation,
                                req_id: &req_id,
                                text: "",
                                detection: Some(detection),
                            },
                        );
                    },
                );
                let _ = reply.send(TriggerReply {
                    outcome,
                    transcript: transcript.lines.into_iter().collect::<Vec<_>>().join("\n"),
                    transcript_truncated: transcript.truncated,
                });
            }
            Ok(TriggerMsg::DropCdc) => {
                if session.drop_cdc() {
                    let _ = app.emit(
                        "km003c-pdm-state",
                        PdmState {
                            generation,
                            open: false,
                            message: "PDM 已断开，请重新打开",
                            description: crate::app_error::AppError::new("triggerNeedPdm", ""),
                        },
                    );
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// Clears the busy flag however the waiting command ends.
struct BusyGuard(Arc<AtomicBool>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Run one trigger command on the connected meter and wait for its outcome.
///
/// Replies stream in as `km003c-trigger-progress` events meanwhile. A scan can take
/// minutes, so the wait happens on a blocking-pool thread, not an async worker.
#[tauri::command]
pub(crate) async fn km003c_trigger(
    generation: u64,
    req_id: String,
    cmd: TriggerCommand,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, crate::app_error::AppError> {
    let result: Result<TriggerReply, String> = async {
        let (tx, busy, cancel) = {
            let slot = state.km003c.lock().map_err(|_| "KM003C 控制状态已损坏")?;
            let control = slot
                .as_ref()
                .filter(|control| control.generation == generation)
                .ok_or("设备未连接或已更换")?;
            (
                control.tx.clone(),
                Arc::clone(&control.busy),
                Arc::clone(&control.cancel),
            )
        };
        if busy.swap(true, Ordering::AcqRel) {
            return Err("上一条协议命令仍在执行".into());
        }
        let guard = BusyGuard(busy);
        // Cleared before sending: a cancel that races the dequeue still applies to this command.
        cancel.store(false, Ordering::Release);
        let (reply, outcome) = mpsc::channel();
        tx.send(TriggerMsg::Run { cmd, req_id, reply })
            .map_err(|_| "设备未连接")?;
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = guard;
            outcome.recv()
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|_| "协议控制线程已退出".to_string())
    }
    .await;
    result
        .map(|reply| {
            let mut value = serde_json::to_value(&reply).expect("serializable trigger outcome");
            let outcome = reply.outcome;
            if !outcome.ok {
                let code = match outcome.code.as_deref() {
                    Some("pdm_required") => "triggerNeedPdm",
                    Some("cancelled") => "triggerCancelled",
                    Some("scan_timeout") => "triggerTimeout",
                    Some("scan_failed") => "scanFailed",
                    _ => "operationFailed",
                };
                value["description"] =
                    serde_json::to_value(crate::app_error::AppError::new(code, outcome.message))
                        .expect("serializable message");
            }
            value
        })
        .map_err(|detail| crate::app_error::AppError::new("backendFailure", detail))
}

/// Abort the command in flight; its reply arrives with code `cancelled`.
#[tauri::command(async)]
pub(crate) fn km003c_cancel_trigger(
    generation: u64,
    state: State<'_, AppState>,
) -> Result<(), crate::app_error::AppError> {
    let result: Result<(), String> = (|| {
        let slot = state.km003c.lock().map_err(|_| "KM003C 控制状态已损坏")?;
        if let Some(control) = slot
            .as_ref()
            .filter(|control| control.generation == generation)
        {
            control.cancel.store(true, Ordering::Release);
        }
        Ok(())
    })();
    result.map_err(|detail| crate::app_error::AppError::new("backendFailure", detail))
}
