use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProgressSnapshot {
    /// Position in the output timeline, in seconds.
    pub out_time: f64,
    pub frame: u64,
    pub fps: f64,
    /// Encoding rate relative to realtime, e.g. 1.54 for "1.54x".
    pub speed: f64,
    pub total_size: u64,
    pub done: bool,
}

/// Incremental parser for ffmpeg's `-progress pipe:1` stream.
///
/// The stream is `key=value` lines, terminated per block by
/// `progress=continue` or `progress=end`.
#[derive(Default)]
pub struct ProgressParser {
    current: ProgressSnapshot,
}

impl ProgressParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one line. Returns a snapshot only when a block completes, i.e. when
    /// the `progress` key arrives.
    pub fn push_line(&mut self, line: &str) -> Option<ProgressSnapshot> {
        let (key, value) = line.trim().split_once('=')?;
        let key = key.trim();
        let value = value.trim();

        match key {
            // NOTE: ffmpeg emits `out_time_ms` in MICROSECONDS despite the name
            // -- it carries the identical value to `out_time_us`. Using
            // `out_time_us` avoids the 1000x error that name invites.
            "out_time_us" => {
                if let Ok(us) = value.parse::<i64>() {
                    if us >= 0 {
                        self.current.out_time = us as f64 / 1_000_000.0;
                    }
                }
            }
            "frame" => {
                if let Ok(f) = value.parse::<u64>() {
                    self.current.frame = f;
                }
            }
            "fps" => {
                if let Ok(f) = value.parse::<f64>() {
                    self.current.fps = f;
                }
            }
            // Carries a trailing `x` and may be padded or `N/A`.
            "speed" => {
                let cleaned = value.trim_end_matches('x').trim();
                if let Ok(s) = cleaned.parse::<f64>() {
                    self.current.speed = s;
                }
            }
            "total_size" => {
                if let Ok(s) = value.parse::<u64>() {
                    self.current.total_size = s;
                }
            }
            "progress" => {
                self.current.done = value == "end";
                return Some(self.current.clone());
            }
            _ => {}
        }

        None
    }
}

/// Fraction complete in 0.0..=1.0, or `None` when total duration is unknown.
pub fn fraction(snapshot: &ProgressSnapshot, total_duration: f64) -> Option<f64> {
    if total_duration <= 0.0 {
        return None;
    }
    Some((snapshot.out_time / total_duration).clamp(0.0, 1.0))
}

/// Seconds remaining, estimated from the current encoding speed.
pub fn eta_secs(snapshot: &ProgressSnapshot, total_duration: f64) -> Option<f64> {
    if snapshot.speed <= 0.0 || total_duration <= 0.0 {
        return None;
    }
    let remaining = (total_duration - snapshot.out_time).max(0.0);
    Some(remaining / snapshot.speed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_a_snapshot_only_on_the_progress_key() {
        let mut p = ProgressParser::new();
        assert!(p.push_line("frame=120").is_none());
        assert!(p.push_line("fps=47.0").is_none());
        assert!(p.push_line("out_time_us=4000000").is_none());
        let snap = p.push_line("progress=continue").expect("block should complete");
        assert_eq!(snap.frame, 120);
        assert!((snap.out_time - 4.0).abs() < 1e-9);
        assert!(!snap.done);
    }

    #[test]
    fn treats_out_time_us_as_microseconds() {
        let mut p = ProgressParser::new();
        p.push_line("out_time_us=90000000");
        let snap = p.push_line("progress=continue").unwrap();
        assert!((snap.out_time - 90.0).abs() < 1e-9);
    }

    #[test]
    fn ignores_the_misnamed_out_time_ms_key() {
        // out_time_ms is also microseconds; trusting it as milliseconds would
        // report a 1000x overshoot. The parser must not read it at all.
        let mut p = ProgressParser::new();
        p.push_line("out_time_ms=5000000");
        let snap = p.push_line("progress=continue").unwrap();
        assert!((snap.out_time - 0.0).abs() < 1e-9);
    }

    #[test]
    fn strips_the_trailing_x_from_speed() {
        let mut p = ProgressParser::new();
        p.push_line("speed=1.54x");
        let snap = p.push_line("progress=continue").unwrap();
        assert!((snap.speed - 1.54).abs() < 1e-9);
    }

    #[test]
    fn tolerates_na_and_padded_values() {
        let mut p = ProgressParser::new();
        p.push_line("speed=N/A");
        p.push_line("fps=N/A");
        p.push_line("out_time_us=N/A");
        let snap = p.push_line("progress=continue").unwrap();
        assert_eq!(snap.speed, 0.0);
        assert_eq!(snap.fps, 0.0);
    }

    #[test]
    fn marks_done_on_progress_end() {
        let mut p = ProgressParser::new();
        let snap = p.push_line("progress=end").unwrap();
        assert!(snap.done);
    }

    #[test]
    fn ignores_malformed_lines() {
        let mut p = ProgressParser::new();
        assert!(p.push_line("no-equals-sign").is_none());
        assert!(p.push_line("").is_none());
    }

    #[test]
    fn computes_fraction_and_eta() {
        let snap = ProgressSnapshot {
            out_time: 30.0,
            speed: 2.0,
            ..Default::default()
        };
        assert!((fraction(&snap, 120.0).unwrap() - 0.25).abs() < 1e-9);
        // 90s of material left at 2x realtime.
        assert!((eta_secs(&snap, 120.0).unwrap() - 45.0).abs() < 1e-9);
        assert!(fraction(&snap, 0.0).is_none());
    }

    #[test]
    fn fraction_never_exceeds_one() {
        let snap = ProgressSnapshot {
            out_time: 200.0,
            ..Default::default()
        };
        assert!((fraction(&snap, 120.0).unwrap() - 1.0).abs() < 1e-9);
    }
}
