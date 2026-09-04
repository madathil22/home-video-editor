use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Semaphore;

use super::caps::Capabilities;
use super::{capture, tail, FFMPEG};

/// Proxy height. 720p keeps scrubbing instant while staying sharp enough to
/// judge framing and pick trim points.
const PROXY_HEIGHT: u32 = 720;
const THUMB_HEIGHT: u32 = 180;

/// Two concurrent transcodes keeps the GPU/CPU busy without starving the UI or
/// exhausting NVENC session slots.
pub static PROXY_CONCURRENCY: usize = 2;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProxyResult {
    pub media_id: String,
    pub proxy_path: String,
    pub thumbnail_path: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProxyProgress {
    pub media_id: String,
    pub stage: String,
    pub error: Option<String>,
}

pub struct ProxyQueue {
    pub semaphore: Semaphore,
}

impl Default for ProxyQueue {
    fn default() -> Self {
        Self {
            semaphore: Semaphore::new(PROXY_CONCURRENCY),
        }
    }
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| anyhow!("no cache directory available: {e}"))?
        .join("proxies");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Key the cache on path + size + mtime so re-importing the same card is
/// instant, but an edited or replaced file regenerates.
fn cache_key(path: &str) -> Result<String> {
    let meta = std::fs::metadata(path).map_err(|e| anyhow!("cannot read {path}: {e}"))?;
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    meta.len().hash(&mut hasher);
    if let Ok(modified) = meta.modified() {
        if let Ok(d) = modified.duration_since(std::time::UNIX_EPOCH) {
            d.as_secs().hash(&mut hasher);
        }
    }
    Ok(format!("{:016x}", hasher.finish()))
}

/// Build the proxy and thumbnail for one source file, reusing cached artifacts
/// when they already exist.
pub async fn ensure_proxy(
    app: &AppHandle,
    media_id: &str,
    source: &str,
    duration: f64,
    caps: &Capabilities,
) -> Result<ProxyResult> {
    let dir = cache_dir(app)?;
    let key = cache_key(source)?;
    let proxy = dir.join(format!("{key}.mp4"));
    let thumb = dir.join(format!("{key}.jpg"));

    let emit = |stage: &str| {
        let _ = app.emit(
            "proxy:progress",
            ProxyProgress {
                media_id: media_id.to_string(),
                stage: stage.to_string(),
                error: None,
            },
        );
    };

    if !thumb.exists() {
        emit("thumbnail");
        // Sample 10% in; the first frame of an action-cam clip is often a blur
        // or a lens cap.
        let seek = (duration * 0.1).clamp(0.0, duration.max(0.0));
        let out = capture(
            app,
            FFMPEG,
            vec![
                "-hide_banner".into(),
                "-v".into(),
                "error".into(),
                "-y".into(),
                "-ss".into(),
                format!("{seek:.3}"),
                "-i".into(),
                source.to_string(),
                "-frames:v".into(),
                "1".into(),
                "-vf".into(),
                format!("scale=-2:{THUMB_HEIGHT}"),
                "-q:v".into(),
                "4".into(),
                thumb.to_string_lossy().to_string(),
            ],
        )
        .await?;
        if !out.success {
            return Err(anyhow!("thumbnail failed: {}", tail(&out.stderr, 3)));
        }
    }

    if !proxy.exists() {
        emit("proxy");
        let mut args: Vec<String> = vec![
            "-hide_banner".into(),
            "-v".into(),
            "error".into(),
            "-y".into(),
            "-i".into(),
            source.to_string(),
            "-vf".into(),
            // -2 keeps the width even and preserves aspect for portrait clips.
            format!("scale=-2:{PROXY_HEIGHT}"),
        ];

        // Proxies are throwaway, so favour speed over quality.
        if caps.nvenc_h264 {
            args.extend(
                [
                    "-c:v",
                    "h264_nvenc",
                    "-preset",
                    "p1",
                    "-rc",
                    "vbr",
                    "-cq",
                    "30",
                ]
                .iter()
                .map(|s| s.to_string()),
            );
        } else {
            args.extend(
                ["-c:v", "libx264", "-preset", "veryfast", "-crf", "28"]
                    .iter()
                    .map(|s| s.to_string()),
            );
        }

        args.extend(
            [
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
            ]
            .iter()
            .map(|s| s.to_string()),
        );
        args.push(proxy.to_string_lossy().to_string());

        let out = capture(app, FFMPEG, args).await?;
        if !out.success {
            let _ = std::fs::remove_file(&proxy);
            return Err(anyhow!("proxy failed: {}", tail(&out.stderr, 3)));
        }
    }

    emit("done");

    Ok(ProxyResult {
        media_id: media_id.to_string(),
        proxy_path: proxy.to_string_lossy().to_string(),
        thumbnail_path: thumb.to_string_lossy().to_string(),
    })
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub file_count: usize,
    pub bytes: u64,
}

pub fn cache_stats(app: &AppHandle) -> Result<CacheStats> {
    let dir = cache_dir(app)?;
    let mut stats = CacheStats {
        file_count: 0,
        bytes: 0,
    };
    for entry in std::fs::read_dir(dir)?.flatten() {
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                stats.file_count += 1;
                stats.bytes += meta.len();
            }
        }
    }
    Ok(stats)
}

pub fn clear_cache(app: &AppHandle) -> Result<()> {
    let dir = cache_dir(app)?;
    for entry in std::fs::read_dir(dir)?.flatten() {
        if entry.metadata().map(|m| m.is_file()).unwrap_or(false) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}
