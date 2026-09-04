use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use super::{capture, FFPROBE};
use crate::project::MediaItem;

/// Parse an ffmpeg rational like `30000/1001` into frames per second.
fn parse_rational(s: &str) -> Option<f64> {
    let (n, d) = s.split_once('/')?;
    let n: f64 = n.trim().parse().ok()?;
    let d: f64 = d.trim().parse().ok()?;
    if d == 0.0 || n == 0.0 {
        return None;
    }
    Some(n / d)
}

/// ffprobe reports rotation either as stream side data or as a legacy
/// `tags.rotate` string. Action cams use both depending on model.
fn extract_rotation(stream: &Value) -> i32 {
    if let Some(list) = stream.get("side_data_list").and_then(|v| v.as_array()) {
        for sd in list {
            if let Some(r) = sd.get("rotation").and_then(|v| v.as_f64()) {
                return normalize_rotation(r as i32);
            }
        }
    }
    if let Some(r) = stream
        .get("tags")
        .and_then(|t| t.get("rotate"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<i32>().ok())
    {
        return normalize_rotation(r);
    }
    0
}

fn normalize_rotation(r: i32) -> i32 {
    let mut r = r % 360;
    if r < 0 {
        r += 360;
    }
    r
}

/// ffprobe reports the *stored* dimensions. ffmpeg auto-rotates on decode
/// (`-autorotate` defaults to on), so a quarter-turn clip reaches the
/// filtergraph with its axes swapped. Report display dimensions so a portrait
/// clip doesn't set up a landscape project.
fn display_dimensions(width: u32, height: u32, rotation: i32) -> (u32, u32) {
    if rotation == 90 || rotation == 270 {
        (height, width)
    } else {
        (width, height)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    pub path: String,
    pub file_name: String,
    pub duration: f64,
}

fn file_name_of(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

async fn probe_json(app: &AppHandle, path: &str) -> Result<Value> {
    let out = capture(
        app,
        FFPROBE,
        vec![
            "-v".into(),
            "quiet".into(),
            "-print_format".into(),
            "json".into(),
            "-show_format".into(),
            "-show_streams".into(),
            path.to_string(),
        ],
    )
    .await?;

    if !out.success {
        return Err(anyhow!("ffprobe could not read this file"));
    }
    serde_json::from_str(&out.stdout).map_err(|e| anyhow!("unreadable ffprobe output: {e}"))
}

/// Probe a video file into a `MediaItem`. Returns an error for files with no
/// decodable video stream so the media bin can flag them without aborting a
/// whole-folder import.
pub async fn probe_video(app: &AppHandle, path: &str) -> Result<MediaItem> {
    let v = probe_json(app, path).await?;

    let streams = v
        .get("streams")
        .and_then(|s| s.as_array())
        .ok_or_else(|| anyhow!("no streams found"))?;

    let video = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(|c| c.as_str()) == Some("video"))
        .ok_or_else(|| anyhow!("no video stream in this file"))?;

    let has_audio = streams
        .iter()
        .any(|s| s.get("codec_type").and_then(|c| c.as_str()) == Some("audio"));

    let format = v.get("format").cloned().unwrap_or(Value::Null);

    // Prefer the container duration; fall back to the stream's own.
    let duration = format
        .get("duration")
        .and_then(|d| d.as_str())
        .and_then(|d| d.parse::<f64>().ok())
        .or_else(|| {
            video
                .get("duration")
                .and_then(|d| d.as_str())
                .and_then(|d| d.parse::<f64>().ok())
        })
        .ok_or_else(|| anyhow!("could not determine duration"))?;

    if duration <= 0.0 {
        return Err(anyhow!("file reports a zero duration"));
    }

    let width = video.get("width").and_then(|w| w.as_u64()).unwrap_or(0) as u32;
    let height = video.get("height").and_then(|h| h.as_u64()).unwrap_or(0) as u32;
    if width == 0 || height == 0 {
        return Err(anyhow!("could not determine video dimensions"));
    }

    // `avg_frame_rate` reflects reality for variable-frame-rate action-cam
    // footage better than `r_frame_rate`, which reports the container's
    // theoretical maximum.
    let fps = video
        .get("avg_frame_rate")
        .and_then(|f| f.as_str())
        .and_then(parse_rational)
        .or_else(|| {
            video
                .get("r_frame_rate")
                .and_then(|f| f.as_str())
                .and_then(parse_rational)
        })
        .unwrap_or(30.0);

    let rotation = extract_rotation(video);
    let (width, height) = display_dimensions(width, height, rotation);

    let creation_time = format
        .get("tags")
        .and_then(|t| t.get("creation_time"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            video
                .get("tags")
                .and_then(|t| t.get("creation_time"))
                .and_then(|c| c.as_str())
                .map(|s| s.to_string())
        });

    let video_codec = video
        .get("codec_name")
        .and_then(|c| c.as_str())
        .unwrap_or("unknown")
        .to_string();

    Ok(MediaItem {
        id: uuid::Uuid::new_v4().to_string(),
        path: path.to_string(),
        file_name: file_name_of(path),
        proxy_path: None,
        thumbnail_path: None,
        duration,
        width,
        height,
        fps,
        has_audio,
        rotation,
        video_codec,
        creation_time,
    })
}

pub async fn probe_audio(app: &AppHandle, path: &str) -> Result<AudioInfo> {
    let v = probe_json(app, path).await?;

    let has_audio = v
        .get("streams")
        .and_then(|s| s.as_array())
        .map(|streams| {
            streams
                .iter()
                .any(|s| s.get("codec_type").and_then(|c| c.as_str()) == Some("audio"))
        })
        .unwrap_or(false);

    if !has_audio {
        return Err(anyhow!("no audio stream in this file"));
    }

    let duration = v
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
        .and_then(|d| d.parse::<f64>().ok())
        .ok_or_else(|| anyhow!("could not determine audio duration"))?;

    Ok(AudioInfo {
        path: path.to_string(),
        file_name: file_name_of(path),
        duration,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ntsc_frame_rates() {
        assert!((parse_rational("30000/1001").unwrap() - 29.97002997).abs() < 1e-6);
        assert!((parse_rational("30/1").unwrap() - 30.0).abs() < 1e-9);
    }

    #[test]
    fn rejects_degenerate_frame_rates() {
        // ffprobe writes 0/0 for streams it cannot characterise.
        assert!(parse_rational("0/0").is_none());
        assert!(parse_rational("30").is_none());
    }

    #[test]
    fn normalizes_rotation_into_0_360() {
        assert_eq!(normalize_rotation(-90), 270);
        assert_eq!(normalize_rotation(450), 90);
        assert_eq!(normalize_rotation(180), 180);
    }

    #[test]
    fn reads_rotation_from_side_data_and_tags() {
        let side = serde_json::json!({ "side_data_list": [{ "rotation": -90.0 }] });
        assert_eq!(extract_rotation(&side), 270);

        let tagged = serde_json::json!({ "tags": { "rotate": "180" } });
        assert_eq!(extract_rotation(&tagged), 180);

        let none = serde_json::json!({});
        assert_eq!(extract_rotation(&none), 0);
    }

    #[test]
    fn swaps_dimensions_only_for_quarter_turns() {
        assert_eq!(display_dimensions(3840, 2160, 0), (3840, 2160));
        assert_eq!(display_dimensions(3840, 2160, 180), (3840, 2160));
        assert_eq!(display_dimensions(3840, 2160, 90), (2160, 3840));
        assert_eq!(display_dimensions(3840, 2160, 270), (2160, 3840));
    }
}
