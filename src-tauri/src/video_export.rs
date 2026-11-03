//! Host-owned video report encoder.
//!
//! The job deliberately belongs to the process, not to the window: closing the dialog or
//! navigating away must not cancel an export that is already running, and the same slot
//! answers a reopened dialog (that is what `video_export_current` is for).
//!
//! Only one encode runs at a time. Media Foundation sinks are not reentrant across threads,
//! and a queued second job would silently double the disk and CPU the user just asked for.

mod model;
mod scene;
// Portable backend: skia draws, OpenH264 (or VideoToolbox on macOS) encodes and the muxer writes
// the container. Windows only compiles it for tests, where it exercises the same code path.
#[cfg(target_os = "macos")]
mod apple;
#[cfg(any(not(windows), test))]
mod mp4;
#[cfg(any(not(windows), test))]
mod portable;
#[cfg(any(not(windows), test))]
mod skia;
#[cfg(any(not(windows), test))]
mod software;
// The QuickTime brand rewrite only exists because Media Foundation always writes an MP4
// container; the portable muxer writes QuickTime brands itself.
#[cfg(windows)]
mod failure;
#[cfg(windows)]
mod gpu;
#[cfg(windows)]
mod mov;
#[cfg(windows)]
mod windows;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::app_error::AppError;
use crate::AppState;
use model::{
    VideoCapability, VideoError, VideoOptions, VideoPayload, VideoStartRequest, VideoState,
    VideoStatus,
};

/// Diagnostics carry the raw reason; the frontend translates the code and appends it.
const ENCODER_UNAVAILABLE: &str = "videoEncoderUnavailable";
const PAYLOAD_INVALID: &str = "videoPayloadInvalid";
const JOB_BUSY: &str = "videoJobBusy";
const JOB_UNKNOWN: &str = "videoJobUnknown";
const SHUTTING_DOWN: &str = "videoShuttingDown";
const SPACE_INSUFFICIENT: &str = "videoSpaceInsufficient";
const TARGET_INVALID: &str = "videoTempTargetInvalid";
const ENCODE_FAILED: &str = "videoEncodeFailed";

/// Reserved headroom on top of the estimated stream size, so a full disk fails before the
/// first frame instead of at 90%.
const SPACE_HEADROOM: u64 = 64 * 1024 * 1024;

/// How long shutdown waits for a cancelled encode. A longer wait would delay quitting for a
/// file the user just abandoned; a shorter one would leave a half-written staging file behind.
const SHUTDOWN_WAIT: Duration = Duration::from_secs(2);

struct VideoJob {
    status: VideoStatus,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
struct VideoSlot {
    job: Option<VideoJob>,
    /// A picked destination that has not been claimed by `start` yet.
    pending: Option<(String, PathBuf)>,
    shutting_down: bool,
    /// Signals the worker's completion to `begin_shutdown`.
    finished: Arc<(Mutex<()>, Condvar)>,
}

/// Single-slot encoder state shared through `AppState`.
#[derive(Default)]
pub(crate) struct VideoExports(Mutex<VideoSlot>);

#[derive(Serialize)]
pub(crate) struct PickedVideoTarget {
    /// Single-use claim on the destination. The frontend never sends a path.
    ticket: String,
    name: String,
}

fn now_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default()
}

fn error(code: &'static str, detail: impl Into<String>) -> AppError {
    AppError::new(code, detail)
}

impl VideoExports {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, VideoSlot>, AppError> {
        self.0
            .lock()
            .map_err(|_| error(ENCODE_FAILED, "video export state is poisoned"))
    }

    fn remember_target(&self, path: PathBuf) -> Result<PickedVideoTarget, AppError> {
        let name = path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| error(TARGET_INVALID, "the chosen path has no file name"))?;
        let ticket = format!("{}-{}-{name}", std::process::id(), now_nanos());
        let mut slot = self.lock()?;
        if slot.shutting_down {
            return Err(error(SHUTTING_DOWN, "the host is shutting down"));
        }
        slot.pending = Some((ticket.clone(), path));
        Ok(PickedVideoTarget { ticket, name })
    }

    fn claim_target(&self, ticket: &str) -> Result<PathBuf, AppError> {
        let mut slot = self.lock()?;
        if slot.shutting_down {
            return Err(error(SHUTTING_DOWN, "the host is shutting down"));
        }
        let matches = slot
            .pending
            .as_ref()
            .is_some_and(|(pending, _)| pending == ticket);
        if !matches {
            return Err(error(
                TARGET_INVALID,
                "the destination ticket is stale or already used",
            ));
        }
        // Consume the ticket before anything else can fail, so a retry needs a new dialog.
        let (_, path) = slot.pending.take().expect("checked above");
        Ok(path)
    }

    fn reserve(&self, options: VideoOptions) -> Result<(VideoStatus, Arc<AtomicBool>), AppError> {
        let mut slot = self.lock()?;
        if slot.shutting_down {
            return Err(error(SHUTTING_DOWN, "the host is shutting down"));
        }
        if slot
            .job
            .as_ref()
            .is_some_and(|job| job.status.state.is_active())
        {
            return Err(error(JOB_BUSY, "another video is already encoding"));
        }
        let id = format!("video-{}-{}", std::process::id(), now_nanos());
        let status = VideoStatus::queued(id, options);
        let cancel = Arc::new(AtomicBool::new(false));
        slot.job = Some(VideoJob {
            status: status.clone(),
            cancel: cancel.clone(),
        });
        Ok((status, cancel))
    }

    fn update(&self, id: &str, change: impl FnOnce(&mut VideoJob)) -> bool {
        let Ok(mut slot) = self.0.lock() else {
            return false;
        };
        let Some(job) = slot.job.as_mut().filter(|job| job.status.id == id) else {
            return false;
        };
        change(job);
        true
    }

    fn status(&self, id: &str) -> Result<VideoStatus, AppError> {
        self.lock()?
            .job
            .as_ref()
            .filter(|job| job.status.id == id)
            .map(|job| job.status.clone())
            .ok_or_else(|| error(JOB_UNKNOWN, "the video job was replaced or never existed"))
    }

    fn current(&self) -> Result<Option<VideoStatus>, AppError> {
        Ok(self.lock()?.job.as_ref().map(|job| job.status.clone()))
    }

    fn cancel(&self, id: &str) -> Result<VideoStatus, AppError> {
        let mut slot = self.lock()?;
        let job = slot
            .job
            .as_mut()
            .filter(|job| job.status.id == id)
            .ok_or_else(|| error(JOB_UNKNOWN, "the video job was replaced or never existed"))?;
        job.cancel.store(true, Ordering::Release);
        Ok(job.status.clone())
    }

    /// Stop accepting new jobs, cancel the running one, and wait for its worker to exit.
    pub(crate) fn begin_shutdown(&self) {
        let finished = {
            let Ok(mut slot) = self.0.lock() else {
                return;
            };
            slot.shutting_down = true;
            slot.pending = None;
            if let Some(job) = slot.job.as_ref() {
                job.cancel.store(true, Ordering::Release);
            }
            slot.finished.clone()
        };
        let (lock, wake) = &*finished;
        let Ok(mut guard) = lock.lock() else {
            return;
        };
        // A cancelled encode still has to be observed as finished; a request alone would let
        // the process exit with a partially written staging file.
        while self.is_active() {
            let Ok((next, timeout)) = wake.wait_timeout(guard, SHUTDOWN_WAIT) else {
                return;
            };
            guard = next;
            if timeout.timed_out() {
                break;
            }
        }
    }

    fn is_active(&self) -> bool {
        self.0.lock().is_ok_and(|slot| {
            slot.job
                .as_ref()
                .is_some_and(|job| job.status.state.is_active())
        })
    }

    fn finish(
        &self,
        id: &str,
        state: VideoState,
        failure: Option<VideoError>,
        path: Option<PathBuf>,
    ) {
        self.update(id, |job| {
            job.status.state = state;
            if state == VideoState::Completed {
                job.status.progress = 1.0;
            }
            if let Some(failure) = failure {
                job.status.error = Some(failure);
            }
            if let Some(path) = path {
                job.status.path = Some(path.display().to_string());
                job.status.name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned());
            }
        });
        // Wake `begin_shutdown` even when the job was already replaced: the condvar is the
        // only thing standing between a cancelled encode and a clean exit.
        let finished = self.0.lock().ok().map(|slot| Arc::clone(&slot.finished));
        if let Some(finished) = finished {
            let (lock, wake) = &*finished;
            if let Ok(_guard) = lock.lock() {
                wake.notify_all();
            }
        }
    }
}

/// Staging path next to the destination, so the commit is a same-volume rename.
fn stage_path(target: &Path) -> Result<PathBuf, AppError> {
    let parent = target
        .parent()
        .ok_or_else(|| error(TARGET_INVALID, "the chosen path has no directory"))?;
    if !parent.is_dir() {
        return Err(error(TARGET_INVALID, "the chosen directory does not exist"));
    }
    let name = target
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .ok_or_else(|| error(TARGET_INVALID, "the chosen path has no file name"))?;
    let stamp = now_nanos();
    for attempt in 0..100 {
        let candidate = parent.join(format!(
            ".{name}.lapower-video-{}-{stamp}-{attempt}.tmp",
            std::process::id()
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(_) => return Ok(candidate),
            Err(failure) if failure.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(failure) => {
                return Err(error(
                    TARGET_INVALID,
                    format!("cannot create the staging file: {failure}"),
                ))
            }
        }
    }
    Err(error(
        TARGET_INVALID,
        "cannot allocate a staging file next to the destination",
    ))
}

/// Same-volume commit: the user already accepted replacement in the native dialog, so the
/// rename is allowed to overwrite.
fn commit(staged: &Path, target: &Path) -> Result<(), String> {
    std::fs::rename(staged, target).map_err(|failure| {
        let _ = std::fs::remove_file(staged);
        format!("cannot move the encoded video into place: {failure}")
    })
}

fn ensure_space(target: &Path, options: &VideoOptions) -> Result<(), AppError> {
    let estimate = u64::from(options.duration_s)
        .saturating_mul(u64::from(options.width))
        .saturating_mul(u64::from(options.height))
        .saturating_mul(u64::from(options.fps))
        / 8;
    let directory = target
        .parent()
        .ok_or_else(|| error(TARGET_INVALID, "the chosen path has no directory"))?;
    let available = fs2::available_space(directory).map_err(|failure| {
        error(
            SPACE_INSUFFICIENT,
            format!("cannot read free space: {failure}"),
        )
    })?;
    if available < estimate.saturating_add(SPACE_HEADROOM) {
        return Err(error(
            SPACE_INSUFFICIENT,
            format!("the destination needs {estimate} bytes of headroom"),
        ));
    }
    Ok(())
}

/// Whether one combination can be encoded on this host.
///
/// Probed on demand and cached per combination for the rest of the process: a probe is a real
/// one-frame encode, so probing all 24 combinations up front is both slow and exposed to any
/// adapter/driver hiccup. The dialog asks for the combination the user is actually looking at.
#[tauri::command(async)]
pub(crate) fn video_export_capability(options: VideoOptions) -> Result<VideoCapability, AppError> {
    options
        .validate()
        .map_err(|detail| error(PAYLOAD_INVALID, detail))?;
    Ok(capability_cached(options))
}

/// Resolution, frame rate and codec identify one probed combination.
type CapabilityKey = (u32, u32, u32, model::Codec);
type CapabilityCache = std::sync::Mutex<std::collections::HashMap<CapabilityKey, VideoCapability>>;

fn capability_cached(options: VideoOptions) -> VideoCapability {
    static CACHE: std::sync::OnceLock<CapabilityCache> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let key = (options.width, options.height, options.fps, options.codec);
    if let Ok(guard) = cache.lock() {
        if let Some(hit) = guard.get(&key) {
            return hit.clone();
        }
    }
    let capability = probe(options);
    if let Ok(mut guard) = cache.lock() {
        guard.insert(key, capability.clone());
    }
    capability
}

fn probe(options: VideoOptions) -> VideoCapability {
    #[cfg(windows)]
    {
        windows::capability(&options)
    }
    #[cfg(target_os = "macos")]
    {
        apple::capability(&options)
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        software_capability(&options)
    }
}

/// Whether the bundled H.264 encoder can write this combination.
///
/// OpenH264 has no HEVC, so those combinations are reported unavailable instead of failing later;
/// the frontend disables them and explains why.
#[cfg(not(windows))]
fn software_capability(options: &VideoOptions) -> VideoCapability {
    let available = options.codec == model::Codec::H264;
    VideoCapability {
        width: options.width,
        height: options.height,
        fps: options.fps,
        codec: options.codec,
        available,
        reason: (!available).then(|| "the built-in encoder only provides H.264".to_owned()),
        encoder: available.then(|| "software".to_owned()),
    }
}

fn unavailable_reason(options: &VideoOptions) -> Option<String> {
    let capability = capability_cached(*options);
    (!capability.available).then(|| {
        capability
            .reason
            .unwrap_or_else(|| "this host cannot encode the requested combination".to_owned())
    })
}

/// Ask where the report goes. The path stays here: the frontend only receives a claim.
#[tauri::command]
pub(crate) async fn video_export_pick(
    default_name: String,
    title: Option<String>,
    filter_name: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<PickedVideoTarget>, AppError> {
    // Debug builds can pre-answer the picker so local automation never opens a native dialog (and
    // never takes the foreground). Release builds do not compile this branch at all: the path
    // there can only come from the user.
    if cfg!(debug_assertions) {
        if let Some(path) = std::env::var_os("LAPOWER_VIDEO_TARGET") {
            return state
                .video_exports
                .remember_target(PathBuf::from(path))
                .map(Some);
        }
    }
    // The dialog filter follows the extension the frontend proposed; anything else falls back
    // to MP4 rather than inventing a filter the user did not choose.
    let extension = Path::new(&default_name)
        .extension()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| value == "mp4" || value == "mov")
        .unwrap_or_else(|| "mp4".into());
    let filter = extension.clone();
    let picked = crate::file_io::dialog_path(app, move |builder| {
        builder
            .set_title(title.unwrap_or_else(|| "Export video report".into()))
            .add_filter(
                filter_name.unwrap_or_else(|| "Video".into()),
                &[filter.as_str()],
            )
            .set_file_name(default_name)
            .blocking_save_file()
    })
    .await
    .map_err(|detail| error(TARGET_INVALID, detail))?;
    let Some(path) = picked else {
        return Ok(None);
    };
    state.video_exports.remember_target(path).map(Some)
}

/// Start encoding a frozen payload into the picked destination.
#[tauri::command]
pub(crate) async fn video_export_start(
    request: VideoStartRequest,
    state: State<'_, AppState>,
) -> Result<VideoStatus, AppError> {
    request
        .payload
        .validate()
        .map_err(|detail| error(PAYLOAD_INVALID, detail))?;
    let target = state.video_exports.claim_target(&request.ticket)?;
    let options = request.payload.options;
    // Capability is cached per combination, so an unsupported one fails here instead of
    // stalling the single encoder slot inside Media Foundation.
    if let Some(reason) = unavailable_reason(&options) {
        return Err(error(ENCODER_UNAVAILABLE, reason));
    }
    // Both checks run before the staging file exists: a rejected request must not leave a
    // hidden file next to the user's chosen directory.
    ensure_space(&target, &options)?;
    let staged = stage_path(&target)?;
    let (status, cancel) = state.video_exports.reserve(options)?;
    state.video_exports.update(&status.id, |job| {
        job.status.state = VideoState::Encoding;
    });
    let id = status.id.clone();
    // The worker owns its Arcs; nothing here may borrow `State` once the command returns.
    let owner = Arc::clone(&state.video_exports);
    let encode_cancel = cancel.clone();
    let payload = request.payload;
    let staged_for_job = staged.clone();
    let target_for_job = target.clone();
    let spawned = std::thread::Builder::new()
        .name("lapower-video".into())
        .spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                encode_report(&payload, &staged_for_job, &encode_cancel, &owner, &id)
            }))
            .unwrap_or_else(|_| Err(("encoder thread panicked".to_string(), None)));
            let cancelled = encode_cancel.load(Ordering::Acquire);
            match outcome {
                Ok(encoded) => match commit(&staged_for_job, &target_for_job) {
                    Ok(()) => {
                        owner.update(&id, |job| {
                            job.status.encoder = Some(encoded.encoder.to_owned());
                            job.status.fallback = encoded.fallback.clone();
                        });
                        owner.finish(&id, VideoState::Completed, None, Some(target_for_job));
                    }
                    Err(detail) => {
                        let _ = std::fs::remove_file(&staged_for_job);
                        owner.finish(
                            &id,
                            VideoState::Failed,
                            Some(VideoError {
                                code: ENCODE_FAILED,
                                detail,
                            }),
                            None,
                        );
                    }
                },
                Err((detail, encoder)) => {
                    let _ = std::fs::remove_file(&staged_for_job);
                    if let Some(encoder) = encoder {
                        owner.update(&id, |job| job.status.encoder = Some(encoder));
                    }
                    owner.finish(
                        &id,
                        if cancelled {
                            VideoState::Cancelled
                        } else {
                            VideoState::Failed
                        },
                        (!cancelled).then_some(VideoError {
                            code: ENCODE_FAILED,
                            detail,
                        }),
                        None,
                    );
                }
            }
        });
    if let Err(failure) = spawned {
        // Without this the slot would stay "queued" forever and every later export would be
        // rejected as busy.
        let _ = std::fs::remove_file(&staged);
        state.video_exports.finish(
            &status.id,
            VideoState::Failed,
            Some(VideoError {
                code: ENCODE_FAILED,
                detail: format!("cannot start the encoder thread: {failure}"),
            }),
            None,
        );
        return Err(error(
            ENCODE_FAILED,
            format!("cannot start the encoder thread: {failure}"),
        ));
    }
    Ok(status)
}

/// The encoder a finished (or running) export is using, plus the reason the zero-copy path was
/// abandoned when a lesser path still produced the file.
struct Encoded {
    encoder: &'static str,
    fallback: Option<String>,
}

/// Render and encode one payload. The encoder callback fires before the first frame so the dialog
/// can name the encoder while it runs instead of guessing; the failure carries the diagnostic the
/// status will report.
fn encode_report(
    payload: &VideoPayload,
    staged: &Path,
    cancel: &AtomicBool,
    exports: &VideoExports,
    id: &str,
) -> std::result::Result<Encoded, (String, Option<String>)> {
    // Only the portable path needs them by &mut; Windows takes them by value.
    #[cfg_attr(windows, allow(unused_mut))]
    let mut on_encoder = |name: &'static str| {
        exports.update(id, |job| job.status.encoder = Some(name.to_owned()));
    };
    #[cfg_attr(windows, allow(unused_mut))]
    let mut progress = |value: f64| {
        exports.update(id, |job| job.status.progress = value);
    };
    #[cfg(windows)]
    {
        windows::encode(payload, staged, cancel, on_encoder, progress)
            .map(|used| Encoded {
                encoder: used.name,
                fallback: used.fallback,
            })
            .map_err(|detail| (detail, None))
    }
    #[cfg(not(windows))]
    {
        portable_encode(payload, staged, cancel, &mut on_encoder, &mut progress)
            .map(|used| Encoded {
                encoder: used.encoder,
                fallback: used.fallback,
            })
            .map_err(|detail| (detail, None))
    }
}

/// macOS: VideoToolbox on the GPU first, the bundled encoder if the session cannot start.
#[cfg(target_os = "macos")]
fn portable_encode(
    payload: &VideoPayload,
    staged: &Path,
    cancel: &AtomicBool,
    on_encoder: &mut dyn FnMut(&'static str),
    progress: &mut dyn FnMut(f64),
) -> std::result::Result<Encoded, String> {
    let mut hardware_encoder = match apple::Vt::new(&payload.options) {
        Ok(encoder) => encoder,
        Err(detail) => return software_only(payload, staged, cancel, on_encoder, progress, detail),
    };
    on_encoder(hardware_encoder.name());
    match portable::encode(payload, staged, cancel, progress, &mut hardware_encoder) {
        Ok(encoder) => Ok(Encoded {
            encoder: encoder_name(&encoder),
            fallback: None,
        }),
        Err(hardware_error) => {
            if cancel.load(Ordering::Acquire) {
                return Err(hardware_error);
            }
            software_only(
                payload,
                staged,
                cancel,
                on_encoder,
                progress,
                hardware_error,
            )
        }
    }
}

#[cfg(target_os = "macos")]
fn software_only(
    payload: &VideoPayload,
    staged: &Path,
    cancel: &AtomicBool,
    on_encoder: &mut dyn FnMut(&'static str),
    progress: &mut dyn FnMut(f64),
    hardware_error: String,
) -> std::result::Result<Encoded, String> {
    // The software attempt always starts from an empty container.
    let _ = std::fs::File::create(staged);
    let mut encoder = software::H264::new(&payload.options)?;
    on_encoder(encoder.name());
    portable::encode(payload, staged, cancel, progress, &mut encoder)
        .map(|_| Encoded {
            encoder: "software",
            fallback: Some(hardware_error.clone()),
        })
        .map_err(|software| format!("{hardware_error}; then {software}"))
}

/// Every other non-Windows host renders with the portable rasteriser and encodes with OpenH264.
#[cfg(all(not(windows), not(target_os = "macos")))]
fn portable_encode(
    payload: &VideoPayload,
    staged: &Path,
    cancel: &AtomicBool,
    on_encoder: &mut dyn FnMut(&'static str),
    progress: &mut dyn FnMut(f64),
) -> std::result::Result<Encoded, String> {
    let mut encoder = software::H264::new(&payload.options)?;
    on_encoder(encoder.name());
    portable::encode(payload, staged, cancel, progress, &mut encoder).map(|_| Encoded {
        encoder: "software",
        fallback: None,
    })
}

#[cfg(target_os = "macos")]
fn encoder_name(name: &str) -> &'static str {
    if name == "hardware" {
        "hardware"
    } else {
        "software"
    }
}

#[tauri::command]
pub(crate) fn video_export_status(
    id: String,
    state: State<'_, AppState>,
) -> Result<VideoStatus, AppError> {
    state.video_exports.status(&id)
}

#[tauri::command]
pub(crate) fn video_export_current(
    state: State<'_, AppState>,
) -> Result<Option<VideoStatus>, AppError> {
    state.video_exports.current()
}

#[tauri::command]
pub(crate) fn video_export_cancel(
    id: String,
    state: State<'_, AppState>,
) -> Result<VideoStatus, AppError> {
    state.video_exports.cancel(&id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use model::{Codec, Format, Theme};

    fn options(duration_s: u32) -> VideoOptions {
        VideoOptions {
            width: 1280,
            height: 720,
            fps: 24,
            codec: Codec::H264,
            format: Format::Mp4,
            duration_s,
            theme: Theme::Light,
            visible_series: [true; 4],
        }
    }

    #[test]
    fn a_finished_job_frees_the_slot_but_keeps_its_status() {
        let exports = VideoExports::default();
        let (first, cancel) = exports.reserve(options(1)).unwrap();
        assert!(exports.reserve(options(1)).is_err());
        exports.update(&first.id, |job| job.status.state = VideoState::Encoding);
        exports.finish(
            &first.id,
            VideoState::Completed,
            None,
            Some(PathBuf::from("/tmp/a.mp4")),
        );
        assert!(!cancel.load(Ordering::Acquire), "完成不应被记成取消");
        let status = exports.status(&first.id).unwrap();
        assert_eq!(status.state, VideoState::Completed);
        assert_eq!(status.progress, 1.0);
        assert_eq!(status.name.as_deref(), Some("a.mp4"));
        let (second, _) = exports.reserve(options(1)).unwrap();
        assert_eq!(
            exports.status(&second.id).unwrap().state,
            VideoState::Queued
        );
        assert!(exports.status(&first.id).is_err(), "旧 id 应已失效");
    }

    #[test]
    fn cancellation_is_only_a_request_until_the_worker_finishes() {
        let exports = VideoExports::default();
        let (status, cancel) = exports.reserve(options(1)).unwrap();
        exports.update(&status.id, |job| job.status.state = VideoState::Encoding);
        exports.cancel(&status.id).unwrap();
        assert!(cancel.load(Ordering::Acquire));
        assert!(
            exports.reserve(options(1)).is_err(),
            "取消请求不能冒充编码线程已退出"
        );
        exports.finish(&status.id, VideoState::Cancelled, None, None);
        assert!(exports.reserve(options(1)).is_ok());
    }

    #[test]
    fn a_ticket_is_single_use_and_shutdown_drops_it() {
        let exports = VideoExports::default();
        let picked = exports
            .remember_target(PathBuf::from("/tmp/report.mp4"))
            .unwrap();
        assert_eq!(picked.name, "report.mp4");
        assert!(exports.claim_target(&picked.ticket).is_ok());
        assert!(
            exports.claim_target(&picked.ticket).is_err(),
            "ticket 只能用一次"
        );
        let picked = exports
            .remember_target(PathBuf::from("/tmp/report.mp4"))
            .unwrap();
        exports.begin_shutdown();
        assert!(exports.claim_target(&picked.ticket).is_err());
        assert!(exports
            .remember_target(PathBuf::from("/tmp/report.mp4"))
            .is_err());
    }

    #[test]
    fn shutdown_waits_for_the_worker_and_refuses_new_jobs() {
        let exports = VideoExports::default();
        let (status, cancel) = exports.reserve(options(60)).unwrap();
        exports.update(&status.id, |job| job.status.state = VideoState::Encoding);
        exports.begin_shutdown();
        assert!(
            cancel.load(Ordering::Acquire),
            "退出必须先取消正在编码的任务"
        );
        assert!(exports.reserve(options(1)).is_err());
    }

    #[test]
    fn staging_files_are_unique_and_live_next_to_the_destination() {
        let directory = std::env::temp_dir().join(format!("lapower-video-stage-{}", now_nanos()));
        std::fs::create_dir_all(&directory).unwrap();
        let target = directory.join("report.mp4");
        let first = stage_path(&target).unwrap();
        let second = stage_path(&target).unwrap();
        assert_ne!(first, second);
        assert_eq!(first.parent().unwrap(), directory.as_path());
        assert!(first
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(".report.mp4"));
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn an_unavailable_combination_explains_itself() {
        // An unknown resolution never reaches the probe: validation rejects it before the cache,
        // so the answer cannot depend on what this host happens to support.
        let mut bad = options(1);
        bad.width = 1024;
        assert!(bad.validate().is_err());
        // A legal combination produces a row that either works or carries the reason it does not.
        let capability = capability_cached(options(1));
        assert_eq!(capability.width, 1280);
        if !capability.available {
            assert!(capability.reason.is_some());
            assert!(capability.encoder.is_none());
        }
    }
}
