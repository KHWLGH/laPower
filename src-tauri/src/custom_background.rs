// SPDX-License-Identifier: GPL-3.0-only
// Based on community contribution from PR #11; refined for laPower. See COPYRIGHT.
//! User-selected window wallpaper, stored outside the install directory.

use crate::app_error::AppError;
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

fn backend_error(detail: impl ToString) -> AppError {
    AppError::new("backendFailure", detail.to_string())
}

fn directory(app: &AppHandle) -> Result<PathBuf, AppError> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(backend_error)?
        .join("custom-background");
    fs::create_dir_all(&path).map_err(backend_error)?;
    Ok(path)
}

fn data_url(path: &Path) -> Result<String, AppError> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime = FILES
        .iter()
        .find_map(|(candidate, mime)| (*candidate == extension).then_some(*mime))
        .ok_or_else(|| AppError::message("customBackgroundUnsupported", std::iter::empty()))?;
    let metadata = fs::metadata(path).map_err(backend_error)?;
    if metadata.len() == 0 || metadata.len() > MAX_IMAGE_BYTES {
        return Err(AppError::message(
            "customBackgroundTooLarge",
            std::iter::empty(),
        ));
    }
    let bytes = fs::read(path).map_err(backend_error)?;
    if !valid_signature(&extension, &bytes) {
        return Err(AppError::message(
            "customBackgroundInvalid",
            std::iter::empty(),
        ));
    }
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

fn supported_extension(path: &Path) -> Result<&'static str, AppError> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    FILES
        .iter()
        .find_map(|(candidate, _)| (*candidate == extension).then_some(*candidate))
        .ok_or_else(|| AppError::message("customBackgroundUnsupported", std::iter::empty()))
}

fn valid_signature(extension: &str, bytes: &[u8]) -> bool {
    match extension {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" | "jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

fn load_saved(app: &AppHandle) -> Result<Option<String>, AppError> {
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
pub(crate) async fn choose_custom_background(
    app: AppHandle,
    title: Option<String>,
    filter_name: Option<String>,
) -> Result<Option<String>, AppError> {
    let picked = crate::file_io::dialog_path(app.clone(), move |builder| {
        builder
            .set_title(title.unwrap_or_else(|| "Choose background image".into()))
            .add_filter(
                filter_name.unwrap_or_else(|| "Images".into()),
                &["png", "jpg", "jpeg", "webp"],
            )
            .blocking_pick_file()
    })
    .await
    .map_err(backend_error)?;
    let Some(source) = picked else {
        return Ok(None);
    };

    tauri::async_runtime::spawn_blocking(move || {
        let extension = supported_extension(&source)?;
        let metadata = fs::metadata(&source).map_err(backend_error)?;
        if metadata.len() == 0 || metadata.len() > MAX_IMAGE_BYTES {
            return Err(AppError::message(
                "customBackgroundTooLarge",
                std::iter::empty(),
            ));
        }
        let bytes = fs::read(&source).map_err(backend_error)?;
        if !valid_signature(extension, &bytes) {
            return Err(AppError::message(
                "customBackgroundInvalid",
                std::iter::empty(),
            ));
        }

        let folder = directory(&app)?;
        let destination = folder.join(format!("background.{extension}"));
        let temporary = folder.join(format!("background.{extension}.tmp"));
        fs::write(&temporary, bytes).map_err(backend_error)?;
        if destination.exists() {
            fs::remove_file(&destination).map_err(backend_error)?;
        }
        fs::rename(&temporary, &destination).map_err(backend_error)?;
        for (other_extension, _) in FILES {
            if *other_extension != extension {
                let old = folder.join(format!("background.{other_extension}"));
                if old.exists() {
                    fs::remove_file(old).map_err(backend_error)?;
                }
            }
        }
        data_url(&destination).map(Some)
    })
    .await
    .map_err(backend_error)?
}

/// Load a user-selected custom background on startup if present.
#[tauri::command]
pub(crate) async fn load_custom_background(app: AppHandle) -> Result<Option<String>, AppError> {
    tauri::async_runtime::spawn_blocking(move || load_saved(&app))
        .await
        .map_err(backend_error)?
}

/// Remove the saved custom background image and return to the default backdrop.
#[tauri::command]
pub(crate) async fn clear_custom_background(app: AppHandle) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = directory(&app)?;
        for (extension, _) in FILES {
            let path = folder.join(format!("background.{extension}"));
            if path.is_file() {
                fs::remove_file(path).map_err(backend_error)?;
            }
        }
        Ok(())
    })
    .await
    .map_err(backend_error)?
}
