// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-only
// For original project contributions; see COPYRIGHT.
//! Render documentation samples with the application's report model, scene and rasteriser.
//! No device, application settings, file dialogs or video encoder are involved.
#![allow(dead_code)] // Shared modules also expose encoder types unused by this tool.

#[path = "../../src-tauri/src/video_export/model.rs"]
mod model;
#[path = "../../src-tauri/src/video_export/scene.rs"]
mod scene;
#[path = "../../src-tauri/src/video_export/skia.rs"]
mod skia;

use std::path::PathBuf;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Job {
    payload: PathBuf,
    output: PathBuf,
    frame: usize,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = std::env::args_os()
        .nth(1)
        .ok_or("usage: showcase-reports <jobs.json>")?;
    let jobs: Vec<Job> = serde_json::from_slice(&std::fs::read(manifest)?)?;
    for job in jobs {
        let payload: model::VideoPayload = serde_json::from_slice(&std::fs::read(&job.payload)?)?;
        payload.validate()?;
        if job.frame >= payload.options.frames() {
            return Err("requested report frame is out of range".into());
        }
        let mut options = payload.options;
        (options.width, options.height) = payload.output_size();
        let canvas = skia::Canvas::new(&options, &payload.palette)?;
        canvas.draw_frame(&payload, job.frame);
        canvas.save_png(&job.output)?;
        println!("{}", job.output.display());
    }
    Ok(())
}
