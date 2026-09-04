use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::{capture, capture_ok, tail, FFMPEG};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub ffmpeg_version: String,
    /// True only after an actual trial encode succeeded, not merely because the
    /// encoder is compiled in. A build can list `h264_nvenc` and still fail to
    /// open it when the installed driver is older than the NVENC API the build
    /// was compiled against.
    pub nvenc_h264: bool,
    pub nvenc_hevc: bool,
    /// `-b_ref_mode middle` requires Turing-generation NVENC or newer.
    pub b_ref_mode: bool,
    /// Populated when NVENC is unavailable, so the UI can explain why instead of
    /// silently producing slow CPU exports.
    pub nvenc_error: Option<String>,
    pub transitions: Vec<String>,
}

impl Capabilities {
    /// The encoder to actually use for a given codec preference.
    pub fn video_encoder(&self, prefer_hevc: bool) -> &'static str {
        if prefer_hevc {
            if self.nvenc_hevc {
                "hevc_nvenc"
            } else {
                "libx265"
            }
        } else if self.nvenc_h264 {
            "h264_nvenc"
        } else {
            "libx264"
        }
    }

    pub fn uses_hardware(&self, prefer_hevc: bool) -> bool {
        if prefer_hevc {
            self.nvenc_hevc
        } else {
            self.nvenc_h264
        }
    }
}

/// Encode a single tiny frame to null to prove the encoder actually opens on
/// this machine's driver.
async fn trial_encode(app: &AppHandle, encoder: &str, extra: &[&str]) -> Result<(), String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-v".into(),
        "error".into(),
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        "testsrc2=size=256x256:rate=30:duration=0.1".into(),
        "-c:v".into(),
        encoder.into(),
    ];
    args.extend(extra.iter().map(|s| s.to_string()));
    args.extend(["-f".into(), "null".into(), "-".into()]);

    match capture(app, FFMPEG, args).await {
        Ok(c) if c.success => Ok(()),
        Ok(c) => Err(tail(&c.stderr, 2)),
        Err(e) => Err(e.to_string()),
    }
}

/// Parse the transition names out of `ffmpeg -h filter=xfade`, which lists them
/// as enum values of the `transition` option. Enumerating at runtime keeps the
/// UI honest across ffmpeg versions instead of hardcoding a list that drifts.
fn parse_transitions(help: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_transition_block = false;

    for line in help.lines() {
        let trimmed = line.trim();

        if trimmed.starts_with("transition ") {
            in_transition_block = true;
            continue;
        }

        if in_transition_block {
            // Enum values are indented further than the option they belong to;
            // a new option line ends the block.
            let indent = line.len() - line.trim_start().len();
            if trimmed.is_empty() {
                continue;
            }
            if indent < 5 {
                break;
            }
            if let Some(name) = trimmed.split_whitespace().next() {
                // Skip the option's own description line and the `custom` entry,
                // which needs an expression rather than being usable directly.
                if name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                    && name != "custom"
                {
                    out.push(name.to_string());
                }
            }
        }
    }

    out.sort();
    out.dedup();
    out
}

pub async fn detect(app: &AppHandle) -> Capabilities {
    let mut caps = Capabilities::default();

    caps.ffmpeg_version = capture_ok(app, FFMPEG, vec!["-hide_banner".into(), "-version".into()])
        .await
        .ok()
        .and_then(|s| s.lines().next().map(|l| l.to_string()))
        .unwrap_or_else(|| "unknown".into());

    match trial_encode(app, "h264_nvenc", &[]).await {
        Ok(()) => caps.nvenc_h264 = true,
        Err(e) => caps.nvenc_error = Some(e),
    }

    caps.nvenc_hevc = trial_encode(app, "hevc_nvenc", &[]).await.is_ok();

    if caps.nvenc_h264 {
        caps.b_ref_mode = trial_encode(app, "h264_nvenc", &["-bf", "3", "-b_ref_mode", "middle"])
            .await
            .is_ok();
    }

    if let Ok(help) = capture_ok(
        app,
        FFMPEG,
        vec!["-hide_banner".into(), "-h".into(), "filter=xfade".into()],
    )
    .await
    {
        caps.transitions = parse_transitions(&help);
    }

    caps
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shape of real `ffmpeg -h filter=xfade` output.
    const HELP: &str = r#"
Filter xfade
  Cross fade one video with another video.
xfade AVOptions:
   transition        <int>        ..FV..... set cross fade transition (from -1 to 57) (default fade)
     custom          -1           ..FV..... custom transition
     fade            0            ..FV..... fade transition
     wipeleft        1            ..FV..... wipe left transition
     wiperight       2            ..FV..... wipe right transition
     dissolve        26           ..FV..... dissolve transition
   duration          <duration>   ..FV..... set cross fade duration (default 1)
   offset            <duration>   ..FV..... set cross fade start relative to first input stream
"#;

    #[test]
    fn extracts_transition_names() {
        let t = parse_transitions(HELP);
        assert!(t.contains(&"fade".to_string()));
        assert!(t.contains(&"wipeleft".to_string()));
        assert!(t.contains(&"dissolve".to_string()));
    }

    #[test]
    fn excludes_custom_and_stops_at_next_option() {
        let t = parse_transitions(HELP);
        // `custom` needs an expression, so it is not offered in the picker.
        assert!(!t.contains(&"custom".to_string()));
        // Parsing must not run past `transition` into `duration`/`offset`.
        assert!(!t.contains(&"duration".to_string()));
        assert!(!t.contains(&"offset".to_string()));
    }

    #[test]
    fn falls_back_to_software_encoders() {
        let caps = Capabilities::default();
        assert_eq!(caps.video_encoder(false), "libx264");
        assert_eq!(caps.video_encoder(true), "libx265");
        assert!(!caps.uses_hardware(false));
    }

    #[test]
    fn prefers_hardware_when_available() {
        let caps = Capabilities {
            nvenc_h264: true,
            nvenc_hevc: true,
            ..Default::default()
        };
        assert_eq!(caps.video_encoder(false), "h264_nvenc");
        assert_eq!(caps.video_encoder(true), "hevc_nvenc");
        assert!(caps.uses_hardware(false));
    }
}
