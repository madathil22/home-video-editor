pub mod caps;
pub mod export;
pub mod filtergraph;
pub mod probe;
pub mod progress;
pub mod proxy;
pub mod segmented;

use anyhow::{anyhow, Result};
use tauri::AppHandle;
use tauri_plugin_shell::process::Command;
use tauri_plugin_shell::ShellExt;

/// Sidecar names as declared in `tauri.conf.json` -> `bundle.externalBin`.
/// Note these are the bare file names; the on-disk files carry the
/// `-x86_64-pc-windows-msvc` target-triple suffix.
pub const FFMPEG: &str = "ffmpeg";
pub const FFPROBE: &str = "ffprobe";

pub fn command(app: &AppHandle, bin: &str) -> Result<Command> {
    app.shell()
        .sidecar(bin)
        .map_err(|e| anyhow!("could not resolve sidecar `{bin}`: {e}"))
}

pub struct Captured {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

/// Run a sidecar to completion and capture its output. Used for short-lived
/// calls such as ffprobe and capability queries; long jobs use `spawn` so they
/// can stream progress.
pub async fn capture(app: &AppHandle, bin: &str, args: Vec<String>) -> Result<Captured> {
    let out = command(app, bin)?
        .args(args)
        .output()
        .await
        .map_err(|e| anyhow!("failed to run `{bin}`: {e}"))?;

    Ok(Captured {
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
        success: out.status.success(),
    })
}

/// Run a sidecar and require success, returning stdout.
pub async fn capture_ok(app: &AppHandle, bin: &str, args: Vec<String>) -> Result<String> {
    let c = capture(app, bin, args).await?;
    if !c.success {
        return Err(anyhow!("{bin} failed: {}", tail(&c.stderr, 12)));
    }
    Ok(c.stdout)
}

/// ffmpeg's real error is almost always in the last few stderr lines; the rest
/// is banner noise. Surface only the useful tail to the UI.
pub fn tail(s: &str, lines: usize) -> String {
    let all: Vec<&str> = s.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = all.len().saturating_sub(lines);
    all[start..].join("\n")
}
