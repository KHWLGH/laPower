// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-only
// For original project contributions; see COPYRIGHT.
//! User-selected window wallpaper, stored outside the install directory.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
const FILES: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("webp", "image/webp"),
];

fn directory(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("custom-background");
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn data_url(path: &Path) -> Result<String, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime = FILES
        .iter()
        .find_map(|(candidate, mime)| (*candidate == extension).then_some(*mime))
        .ok_or_else(|| "仅支持 PNG、JPG 和 WebP 图片".to_string())?;
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() == 0 || metadata.len() > MAX_IMAGE_BYTES {
        return Err("背景图片必须小于 25 MB".to_string());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if !valid_signature(&extension, &bytes) {
        return Err("背景图片文件已损坏或格式无效".to_string());
    }
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

fn supported_extension(path: &Path) -> Result<&'static str, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    FILES
        .iter()
        .find_map(|(candidate, _)| (*candidate == extension).then_some(*candidate))
        .ok_or_else(|| "仅支持 PNG、JPG 和 WebP 图片".to_string())
}

fn valid_signature(extension: &str, bytes: &[u8]) -> bool {
    match extension {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" | "jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

fn load_saved(app: &AppHandle) -> Result<Option<String>, String> {
    let folder = directory(app)?;
    for (extension, _) in FILES {
        let path = folder.join(format!("background.{extension}"));
        if path.is_file() {
            return data_url(&path).map(Some);
        }
    }
    Ok(None)
}

/// Open a native image picker and persist the selected raster image in app config.
#[tauri::command]
pub(crate) async fn choose_custom_background(app: AppHandle) -> Result<Option<String>, String> {
    let picked = crate::file_io::dialog_path(app.clone(), |builder| {
        builder
            .set_title("Choose background image")
            .add_filter("Images", &["png", "jpg", "jpeg", "webp"])
            .blocking_pick_file()
    })
    .await?;
    let Some(source) = picked else {
        return Ok(None);
    };

    tauri::async_runtime::spawn_blocking(move || {
        let extension = supported_extension(&source)?;
        let metadata = fs::metadata(&source).map_err(|error| error.to_string())?;
        if metadata.len() == 0 || metadata.len() > MAX_IMAGE_BYTES {
            return Err("背景图片必须小于 25 MB".to_string());
        }
        let bytes = fs::read(&source).map_err(|error| error.to_string())?;
        if !valid_signature(extension, &bytes) {
            return Err("图片内容与文件格式不匹配".to_string());
        }

        let folder = directory(&app)?;
        let destination = folder.join(format!("background.{extension}"));
        let temporary = folder.join(format!("background.{extension}.tmp"));
        fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
        if destination.exists() {
            fs::remove_file(&destination).map_err(|error| error.to_string())?;
        }
        fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
        for (other_extension, _) in FILES {
            if *other_extension != extension {
                let old = folder.join(format!("background.{other_extension}"));
                if old.exists() {
                    fs::remove_file(old).map_err(|error| error.to_string())?;
                }
            }
        }
        data_url(&destination).map(Some)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Restore the bundled wallpaper on startup when the user has not selected one.
#[tauri::command]
pub(crate) async fn load_custom_background(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || load_saved(&app))
        .await
        .map_err(|error| error.to_string())?
}

/// Remove the saved image and restore the bundled wallpaper.
#[tauri::command]
pub(crate) async fn clear_custom_background(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = directory(&app)?;
        for (extension, _) in FILES {
            let path = folder.join(format!("background.{extension}"));
            if path.exists() {
                fs::remove_file(path).map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}
