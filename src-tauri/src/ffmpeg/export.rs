use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

use super::progress::ProgressParser;
use super::{command, tail, FFMPEG};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgressEvent {
    pub fraction: f64,
    pub out_time: f64,
    pub total_duration: f64,
    pub speed: f64,
    pub fps: f64,
    pub eta_secs: Option<f64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportDoneEvent {
    pub output_path: String,
    pub cancelled: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportErrorEvent {
    pub message: String,
}

/// Holds the running export so it can be cancelled from the UI.
#[derive(Default)]
pub struct ExportState {
    child: Mutex<Option<CommandChild>>,
    cancelled: Mutex<bool>,
    /// A segmented export runs many ffmpeg processes back to back, so between
    /// jobs there is no child to point at. This keeps the export visible as
    /// running for the whole sequence.
    active: Mutex<bool>,
}

impl ExportState {
    pub fn is_running(&self) -> bool {
        *self.active.lock() || self.child.lock().is_some()
    }

    pub fn cancel(&self) -> Result<()> {
        if !self.is_running() {
            return Err(anyhow!("no export is running"));
        }
        *self.cancelled.lock() = true;
        if let Some(child) = self.child.lock().take() {
            child
                .kill()
                .map_err(|e| anyhow!("could not stop the export: {e}"))?;
        }
        Ok(())
    }

    fn is_cancelled(&self) -> bool {
        *self.cancelled.lock()
    }
}

/// Removes the scratch directory a segmented export renders into, however the
/// export ends.
struct WorkDir(std::path::PathBuf);

impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// One rendered piece of the timeline.
pub struct SegmentJob {
    pub args: Vec<String>,
    /// Output length, used to weight this job's share of the progress bar.
    pub duration: f64,
}

/// Outcome of a single ffmpeg invocation.
struct JobOutcome {
    ok: bool,
    stderr_tail: Vec<String>,
    exit_code: Option<i32>,
}

/// Run one ffmpeg process to completion, reporting its `-progress` output
/// through `on_progress` as a number of seconds produced so far.
async fn run_job(
    app: &AppHandle,
    state: &ExportState,
    args: Vec<String>,
    mut on_progress: impl FnMut(f64, f64, f64),
) -> Result<JobOutcome> {
    let (mut rx, child) = command(app, FFMPEG)?
        .args(args)
        .spawn()
        .map_err(|e| anyhow!("could not start ffmpeg: {e}"))?;

    *state.child.lock() = Some(child);

    let mut parser = ProgressParser::new();
    let mut stderr_tail: Vec<String> = Vec::new();
    let mut finished_cleanly = false;
    let mut exit_code: Option<i32> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes).to_string();
                for raw in line.lines() {
                    if let Some(snapshot) = parser.push_line(raw) {
                        if snapshot.done {
                            finished_cleanly = true;
                        }
                        on_progress(snapshot.out_time, snapshot.speed, snapshot.fps);
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                let text = String::from_utf8_lossy(&bytes).to_string();
                for raw in text.lines() {
                    if !raw.trim().is_empty() {
                        stderr_tail.push(raw.to_string());
                        if stderr_tail.len() > 40 {
                            stderr_tail.remove(0);
                        }
                    }
                }
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
            }
            _ => {}
        }
    }

    *state.child.lock() = None;

    Ok(JobOutcome {
        ok: finished_cleanly && exit_code.unwrap_or(0) == 0,
        stderr_tail,
        exit_code,
    })
}

/// Render the timeline as a sequence of small jobs, then stitch them.
///
/// See [`super::segmented`] for why the export is split up at all.
#[allow(clippy::too_many_arguments)]
pub async fn run_segmented_export(
    app: &AppHandle,
    state: &ExportState,
    jobs: Vec<SegmentJob>,
    concat: Vec<String>,
    total_duration: f64,
    output_path: String,
    workdir: std::path::PathBuf,
) -> Result<()> {
    if state.is_running() {
        return Err(anyhow!("An export is already running."));
    }

    *state.cancelled.lock() = false;
    *state.active.lock() = true;
    let _cleanup = WorkDir(workdir);

    // Rendering the segments is the bulk of the work; the concat pass only
    // copies video and re-encodes one audio track, so it gets the last slice.
    const RENDER_SHARE: f64 = 0.92;

    let mut done_secs = 0.0f64;
    let mut failure: Option<String> = None;

    for job in jobs {
        if state.is_cancelled() {
            break;
        }
        let job_len = job.duration;
        let base = done_secs;
        let outcome = run_job(app, state, job.args, |out_time, speed, fps| {
            let produced = (base + out_time.min(job_len)).min(total_duration);
            let fraction = if total_duration > 0.0 {
                (produced / total_duration) * RENDER_SHARE
            } else {
                0.0
            };
            let remaining = (total_duration - produced).max(0.0);
            let _ = app.emit(
                "export:progress",
                ExportProgressEvent {
                    fraction,
                    out_time: produced,
                    total_duration,
                    speed,
                    fps,
                    eta_secs: if speed > 0.01 {
                        Some(remaining / speed)
                    } else {
                        None
                    },
                },
            );
        })
        .await?;

        if state.is_cancelled() {
            break;
        }
        if !outcome.ok {
            failure = Some(if outcome.stderr_tail.is_empty() {
                format!("ffmpeg exited with code {:?}", outcome.exit_code)
            } else {
                tail(&outcome.stderr_tail.join("\n"), 8)
            });
            break;
        }
        done_secs += job_len;
    }

    // Stitch, unless something already went wrong.
    if failure.is_none() && !state.is_cancelled() {
        let outcome = run_job(app, state, concat, |out_time, speed, fps| {
            let fraction = if total_duration > 0.0 {
                RENDER_SHARE + (out_time / total_duration) * (1.0 - RENDER_SHARE)
            } else {
                RENDER_SHARE
            };
            let _ = app.emit(
                "export:progress",
                ExportProgressEvent {
                    fraction: fraction.min(1.0),
                    out_time: total_duration,
                    total_duration,
                    speed,
                    fps,
                    eta_secs: None,
                },
            );
        })
        .await?;

        if !outcome.ok {
            failure = Some(if outcome.stderr_tail.is_empty() {
                format!("ffmpeg exited with code {:?}", outcome.exit_code)
            } else {
                tail(&outcome.stderr_tail.join("\n"), 8)
            });
        }
    }

    *state.active.lock() = false;
    let cancelled = state.is_cancelled();

    if cancelled {
        let _ = std::fs::remove_file(&output_path);
        let _ = app.emit(
            "export:done",
            ExportDoneEvent {
                output_path,
                cancelled: true,
            },
        );
        return Ok(());
    }

    match failure {
        None => {
            let _ = app.emit(
                "export:done",
                ExportDoneEvent {
                    output_path,
                    cancelled: false,
                },
            );
            Ok(())
        }
        Some(message) => {
            // Remove the truncated file so a failed export never looks like a
            // successful one in Explorer.
            let _ = std::fs::remove_file(&output_path);
            let _ = app.emit("export:error", ExportErrorEvent { message: message.clone() });
            Err(anyhow!(message))
        }
    }
}

