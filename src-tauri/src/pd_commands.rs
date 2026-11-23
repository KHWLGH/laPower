// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-or-later
// For original project contributions; see COPYRIGHT.
//! Tauri commands for USB-PD capture gating, decoding, paging and streaming import.

use std::sync::atomic::Ordering;

use tauri::State;

use crate::pd_capture::PdPage;
use crate::{file_io, pd_capture, AppState};

#[tauri::command]
pub(crate) fn set_pd_capture_enabled(enabled: bool, state: State<'_, AppState>) {
    state.pd_capture_enabled.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
pub(crate) fn pd_log_clear(state: State<'_, AppState>) -> Result<u64, crate::app_error::AppError> {
    let result: Result<u64, String> = (|| {
        Ok(state
            .pd_log
            .lock()
            .map_err(|_| "PD 日志状态已损坏".to_string())?
            .clear())
    })();
    result.map_err(|detail| crate::app_error::AppError::new("backendFailure", detail))
}

#[tauri::command]
pub(crate) fn decode_pd_at(
    index: u64,
    generation: u64,
    state: State<'_, AppState>,
) -> Result<witrn_hid::Metadata, crate::app_error::AppError> {
    let result: Result<witrn_hid::Metadata, String> = (|| {
        let log = state
            .pd_log
            .lock()
            .map_err(|_| "PD 日志状态已损坏".to_string())?;
        log.meta_in_generation(index, generation)
            .cloned()
            .ok_or_else(|| "没有这条报文的解码树".to_string())
    })();
    result.map_err(|detail| crate::app_error::AppError::new("decodeFailed", detail))
}

#[tauri::command]
pub(crate) async fn pd_log_import(
    handle: u32,
    state: State<'_, AppState>,
) -> Result<pd_capture::PdImportSummary, crate::app_error::AppError> {
    let reader = file_io::take_reader(&state, handle)
        .map_err(|detail| crate::app_error::AppError::new("backendFailure", detail))?;
    let (next, events) =
        tauri::async_runtime::spawn_blocking(move || pd_capture::import_from_reader(reader))
            .await
            .map_err(|error| {
                crate::app_error::AppError::new("backendFailure", error.to_string())
            })??;
    let mut log = state
        .pd_log
        .lock()
        .map_err(|_| crate::app_error::AppError::new("backendFailure", "PD 日志状态已损坏"))?;
    Ok(log.install_import(next, events))
}

#[tauri::command(async)]
pub(crate) fn pd_log_import_page(
    generation: u64,
    offset: usize,
    state: State<'_, AppState>,
) -> Result<pd_capture::PdImportPage, crate::app_error::AppError> {
    let result: Result<pd_capture::PdImportPage, String> = (|| {
        let mut log = state
            .pd_log
            .lock()
            .map_err(|_| "PD 日志状态已损坏".to_string())?;
        log.take_import_page(generation, offset)
    })();
    result.map_err(|detail| crate::app_error::AppError::new("backendFailure", detail))
}

#[tauri::command(async)]
pub(crate) fn pd_log_after(
    generation: Option<u64>,
    after_seq: Option<u64>,
    through_seq: Option<u64>,
    state: State<'_, AppState>,
) -> Result<PdPage, crate::app_error::AppError> {
    let result = state
        .pd_log
        .lock()
        .map_err(|_| "PD 日志状态已损坏".to_string())
        .and_then(|log| log.page_after(generation, after_seq, through_seq));
    result.map_err(|detail| crate::app_error::AppError::new("backendFailure", detail))
}
