// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-or-later
// For original project contributions; see COPYRIGHT.
//! Tauri commands managing the optional external TCP temperature service thread.

use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};

use crate::stream_commands::stop_task;
use crate::{temperature_reader, AppState, BackgroundTask};

/// 连接温度服务
#[tauri::command(async)]
pub(crate) fn connect_temp_service(
    ip: String,
    port: u16,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, crate::app_error::AppError> {
    let result: Result<String, String> = (|| {
        {
            let mut task_slot = state
                .temp_task
                .lock()
                .map_err(|_| "温度任务状态已损坏".to_string())?;
            stop_task(&mut task_slot);
        }

        let addr = format!("{ip}:{port}");
        let mut addrs: Vec<_> = (ip.as_str(), port)
            .to_socket_addrs()
            .map_err(|e| format!("无效地址: {e}"))?
            .collect();
        if addrs.is_empty() {
            return Err(format!("无法解析地址 {addr}"));
        }
        addrs.sort_by_key(|socket| u8::from(socket.is_ipv6()));

        let mut last_error = None;
        let mut stream = None;
        for socket in addrs {
            match TcpStream::connect_timeout(&socket, Duration::from_secs(5)) {
                Ok(connected) => {
                    stream = Some(connected);
                    break;
                }
                Err(error) => last_error = Some(error),
            }
        }
        let stream = stream.ok_or_else(|| {
            format!(
                "连接失败: {}",
                last_error
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "无可用地址".to_string())
            )
        })?;

        stream
            .set_read_timeout(Some(Duration::from_millis(250)))
            .map_err(|e| format!("设置超时失败: {}", e))?;

        let mut task_slot = state
            .temp_task
            .lock()
            .map_err(|_| "温度任务状态已损坏".to_string())?;
        stop_task(&mut task_slot);

        // 启动接收线程
        let running = Arc::new(AtomicBool::new(true));
        let running_for_thread = Arc::clone(&running);

        let join = thread::spawn(move || {
            let result = temperature_reader::receive(stream, &running_for_thread, |temp| {
                let _ = app.emit("temp-data", temp);
            });
            if running_for_thread.load(Ordering::Relaxed) {
                if let Err(error) = result {
                    eprintln!("温度读取错误: {error}");
                }
                let _ = app.emit("temp-disconnected", ());
            }
            running_for_thread.store(false, Ordering::Relaxed);
        });
        task_slot.replace(BackgroundTask {
            running,
            joins: vec![join],
            session: None,
        });

        Ok(format!("已连接到温度服务 {}", addr))
    })();
    result.map_err(|detail| crate::app_error::AppError::new("tempConnectFailed", detail))
}

/// 断开温度服务
#[tauri::command(async)]
pub(crate) fn disconnect_temp_service(
    state: State<'_, AppState>,
) -> Result<String, crate::app_error::AppError> {
    let result: Result<String, String> = (|| {
        let mut task_slot = state
            .temp_task
            .lock()
            .map_err(|_| "温度任务状态已损坏".to_string())?;
        stop_task(&mut task_slot);
        Ok("已断开温度服务连接".to_string())
    })();
    result.map_err(|detail| crate::app_error::AppError::new("tempDisconnectFailed", detail))
}
