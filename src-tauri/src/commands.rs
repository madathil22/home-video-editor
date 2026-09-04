use parking_lot::Mutex;
use tauri::{AppHandle, State};

use crate::ffmpeg::caps::Capabilities;
use crate::ffmpeg::export::{run_segmented_export, ExportState, SegmentJob};
use crate::ffmpeg::filtergraph::ExportSettings;
use crate::ffmpeg::segmented::{concat_args, concat_list, plan_segments, segment_args, SegmentKind};
use crate::ffmpeg::probe::{probe_audio, probe_video, AudioInfo};
use crate::ffmpeg::proxy::{cache_stats, clear_cache, ensure_proxy, CacheStats, ProxyQueue, ProxyResult};
use crate::ffmpeg::{caps as caps_mod, proxy};
use crate::project::{resolve_timeline, MediaItem, Project, ResolvedTimeline};

/// Tauri commands must return a serialisable error, and `anyhow::Error` is not.
/// Everything user-facing is funnelled through a plain string so the UI can show
/// ffmpeg's own words rather than a generic failure.
type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Default)]
pub struct CapsCache(pub Mutex<Option<Capabilities>>);

/// Capability probing runs trial encodes, so it is done once and reused.
///
/// The lock is deliberately taken and released inside its own scope: holding a
/// `parking_lot` guard across an `.await` would make the command future
/// non-`Send`, which Tauri rejects.
async fn caps_for(app: &AppHandle, cache: &CapsCache) -> Capabilities {
    let cached = cache.0.lock().clone();
    if let Some(c) = cached {
        return c;
    }
    let detected = caps_mod::detect(app).await;
    *cache.0.lock() = Some(detected.clone());
    detected
}

#[tauri::command]
pub async fn detect_capabilities(
    app: AppHandle,
    cache: State<'_, CapsCache>,
) -> CmdResult<Capabilities> {
    Ok(caps_for(&app, &cache).await)
}

#[tauri::command]
pub async fn probe_media(app: AppHandle, path: String) -> CmdResult<MediaItem> {
    probe_video(&app, &path).await.map_err(err)
}

#[tauri::command]
pub async fn probe_music(app: AppHandle, path: String) -> CmdResult<AudioInfo> {
    probe_audio(&app, &path).await.map_err(err)
}

#[tauri::command]
pub async fn generate_proxy(
    app: AppHandle,
    queue: State<'_, ProxyQueue>,
    cache: State<'_, CapsCache>,
    media_id: String,
    path: String,
    duration: f64,
) -> CmdResult<ProxyResult> {
    let caps = caps_for(&app, &cache).await;

    // Bound concurrency so a 40-clip import does not spawn 40 transcodes.
    let _permit = queue.semaphore.acquire().await.map_err(err)?;
    ensure_proxy(&app, &media_id, &path, duration, &caps)
        .await
        .map_err(err)
}

/// The single source of truth for timeline layout. The UI calls this on every
/// project mutation so preview and export can never drift apart.
#[tauri::command]
pub fn resolve_project(project: Project) -> ResolvedTimeline {
    resolve_timeline(&project)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlan {
    pub total_duration: f64,
    pub encoder: String,
    pub hardware: bool,
    pub command_preview: String,
}

/// Resolve what an export *would* do without running it, so the export dialog
/// can show the encoder, the true output length, and the exact command.
#[tauri::command]
pub async fn plan_export(
    app: AppHandle,
    cache: State<'_, CapsCache>,
    project: Project,
    settings: ExportSettings,
) -> CmdResult<ExportPlan> {
    let caps = caps_for(&app, &cache).await;

    let resolved = resolve_timeline(&project);
    let segments = plan_segments(&project, &resolved).map_err(err)?;
    let prefer_hevc = settings.codec.eq_ignore_ascii_case("hevc");

    let transitions = segments
        .iter()
        .filter(|s| matches!(s.kind, SegmentKind::Transition { .. }))
        .count();
    let first = segments
        .first()
        .map(|s| segment_args(&project, s, &caps, &settings, "segment00000.mkv"))
        .transpose()
        .map_err(err)?
        .unwrap_or_default();
    let concat = concat_args(&project, &settings, "segments.txt", resolved.total_duration);

    Ok(ExportPlan {
        total_duration: resolved.total_duration,
        encoder: caps.video_encoder(prefer_hevc).to_string(),
        hardware: caps.uses_hardware(prefer_hevc),
        command_preview: format!(
            "{} segments ({} transitions), then one concat pass.\n\n\
             # first segment\nffmpeg {}\n\n# stitch\nffmpeg {}",
            segments.len(),
            transitions,
            first.join(" "),
            concat.join(" ")
        ),
    })
}

#[tauri::command]
pub async fn start_export(
    app: AppHandle,
    state: State<'_, ExportState>,
    cache: State<'_, CapsCache>,
    project: Project,
    settings: ExportSettings,
) -> CmdResult<()> {
    let caps = caps_for(&app, &cache).await;

    let resolved = resolve_timeline(&project);
    let segments = plan_segments(&project, &resolved).map_err(err)?;

    // Each segment renders to its own file in a scratch directory that is
    // removed when the export ends.
    let workdir = std::env::temp_dir().join(format!("hve-export-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&workdir)
        .map_err(|e| format!("could not create the working directory: {e}"))?;

    let mut jobs = Vec::with_capacity(segments.len());
    let mut paths = Vec::with_capacity(segments.len());
    for (i, segment) in segments.iter().enumerate() {
        let path = workdir.join(format!("seg{i:05}.mkv"));
        let path_str = path.to_string_lossy().to_string();
        let args = segment_args(&project, segment, &caps, &settings, &path_str).map_err(err)?;
        jobs.push(SegmentJob {
            args,
            duration: segment.duration,
        });
        paths.push(path_str);
    }

    let list_path = workdir.join("segments.txt");
    std::fs::write(&list_path, concat_list(&paths))
        .map_err(|e| format!("could not write the segment list: {e}"))?;

    let concat = concat_args(
        &project,
        &settings,
        &list_path.to_string_lossy(),
        resolved.total_duration,
    );

    run_segmented_export(
        &app,
        &state,
        jobs,
        concat,
        resolved.total_duration,
        settings.output_path.clone(),
        workdir,
    )
    .await
    .map_err(err)
}

#[tauri::command]
pub fn cancel_export(state: State<'_, ExportState>) -> CmdResult<()> {
    state.cancel().map_err(err)
}

#[tauri::command]
pub fn save_project(path: String, project: Project) -> CmdResult<()> {
    let json = serde_json::to_string_pretty(&project).map_err(err)?;
    std::fs::write(&path, json).map_err(err)
}

#[tauri::command]
pub fn load_project(path: String) -> CmdResult<Project> {
    let text = std::fs::read_to_string(&path).map_err(err)?;
    serde_json::from_str(&text).map_err(|e| format!("This is not a valid project file: {e}"))
}

#[tauri::command]
pub fn proxy_cache_stats(app: AppHandle) -> CmdResult<CacheStats> {
    cache_stats(&app).map_err(err)
}

#[tauri::command]
pub fn clear_proxy_cache(app: AppHandle) -> CmdResult<()> {
    clear_cache(&app).map_err(err)
}

/// Report which referenced source files no longer exist, so the UI can offer a
/// relink flow instead of failing at export time.
#[tauri::command]
pub fn missing_media(project: Project) -> Vec<String> {
    project
        .media
        .iter()
        .filter(|m| !std::path::Path::new(&m.path).exists())
        .map(|m| m.id.clone())
        .collect()
}

#[tauri::command]
pub fn proxy_concurrency() -> usize {
    proxy::PROXY_CONCURRENCY
}
