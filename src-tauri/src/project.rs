use serde::{Deserialize, Serialize};

/// Shortest transition we are willing to render. Below this an `acrossfade`
/// becomes degenerate and an `xfade` is visually indistinguishable from a cut,
/// so the boundary is demoted to a hard cut instead.
pub const MIN_TRANSITION_SECS: f64 = 0.2;

pub const PROJECT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self {
            width: 3840,
            height: 2160,
            fps: 30.0,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: String,
    pub path: String,
    pub file_name: String,
    #[serde(default)]
    pub proxy_path: Option<String>,
    #[serde(default)]
    pub thumbnail_path: Option<String>,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_audio: bool,
    /// Display-matrix rotation in degrees, as reported by ffprobe. Action cams
    /// commonly write 180 here when the unit is mounted upside down.
    #[serde(default)]
    pub rotation: i32,
    #[serde(default)]
    pub video_codec: String,
    /// Recording timestamp, used to sort the media bin into shooting order.
    #[serde(default)]
    pub creation_time: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    pub media_id: String,
    pub in_point: f64,
    pub out_point: f64,
    #[serde(default)]
    pub muted: bool,
}

impl Clip {
    pub fn duration(&self) -> f64 {
        (self.out_point - self.in_point).max(0.0)
    }
}

/// The transition applied to *every* boundary via "Apply to all".
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransitionSpec {
    /// An ffmpeg `xfade` transition name, e.g. `fade`, `wipeleft`, `dissolve`.
    pub kind: String,
    pub duration: f64,
    pub enabled: bool,
}

impl Default for TransitionSpec {
    fn default() -> Self {
        Self {
            kind: "fade".into(),
            duration: 1.0,
            enabled: true,
        }
    }
}

/// Sparse deviation from `default_transition` at a single boundary. Keyed by the
/// clip *before* the boundary so reordering and deletion cannot orphan it.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransitionOverride {
    pub after_clip_id: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub duration: Option<f64>,
    /// `Some(false)` forces a hard cut at this boundary.
    #[serde(default)]
    pub enabled: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MusicTrack {
    pub path: String,
    pub file_name: String,
    pub volume: f64,
    pub fade_in: f64,
    pub fade_out: f64,
    /// Offset into the music file where playback begins.
    pub start_offset: f64,
    pub duration: f64,
    #[serde(default)]
    pub loop_to_fit: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub version: u32,
    pub settings: ProjectSettings,
    pub media: Vec<MediaItem>,
    pub timeline: Vec<Clip>,
    pub default_transition: TransitionSpec,
    #[serde(default)]
    pub transition_overrides: Vec<TransitionOverride>,
    #[serde(default)]
    pub music: Option<MusicTrack>,
}

impl Default for Project {
    fn default() -> Self {
        Self {
            version: PROJECT_VERSION,
            settings: ProjectSettings::default(),
            media: Vec::new(),
            timeline: Vec::new(),
            default_transition: TransitionSpec::default(),
            transition_overrides: Vec::new(),
            music: None,
        }
    }
}

impl Project {
    pub fn media_for(&self, media_id: &str) -> Option<&MediaItem> {
        self.media.iter().find(|m| m.id == media_id)
    }
}

// ---------------------------------------------------------------------------
// Resolver
//
// This is the single source of truth for "what does the timeline actually look
// like". The UI calls `resolve_timeline` over IPC on every project mutation and
// the export filtergraph builder uses the same output, so preview and export can
// never disagree about durations, clip positions, or transition placement.
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTransition {
    pub kind: String,
    pub duration: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedBoundary {
    /// Index of the clip preceding this boundary.
    pub index: usize,
    pub after_clip_id: String,
    /// `None` means a hard cut.
    pub transition: Option<ResolvedTransition>,
    /// Duration asked for before clamping, so the UI can explain itself.
    pub requested_duration: f64,
    /// True when the requested duration did not fit between these two clips.
    pub clamped: bool,
    /// True when clamping pushed the duration below `MIN_TRANSITION_SECS` and
    /// the boundary was demoted to a hard cut.
    pub demoted_to_cut: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedClip {
    pub clip_id: String,
    pub media_id: String,
    /// Position on the output timeline, accounting for transition overlaps.
    pub start: f64,
    pub end: f64,
    /// Trimmed source duration (out - in), before overlap is subtracted.
    pub duration: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTimeline {
    pub clips: Vec<ResolvedClip>,
    pub boundaries: Vec<ResolvedBoundary>,
    pub total_duration: f64,
    /// Number of boundaries whose duration had to be reduced.
    pub clamped_count: usize,
}

/// Resolve `default_transition` + overrides into a concrete per-boundary answer,
/// clamping each boundary independently so a single global "Apply to all"
/// duration can never produce an invalid filtergraph.
pub fn resolve_timeline(project: &Project) -> ResolvedTimeline {
    let clips = &project.timeline;
    let mut boundaries: Vec<ResolvedBoundary> = Vec::new();

    for index in 0..clips.len().saturating_sub(1) {
        let a = &clips[index];
        let b = &clips[index + 1];

        let ov = project
            .transition_overrides
            .iter()
            .find(|o| o.after_clip_id == a.id);

        let enabled = ov
            .and_then(|o| o.enabled)
            .unwrap_or(project.default_transition.enabled);

        let kind = ov
            .and_then(|o| o.kind.clone())
            .unwrap_or_else(|| project.default_transition.kind.clone());

        let requested = ov
            .and_then(|o| o.duration)
            .unwrap_or(project.default_transition.duration);

        if !enabled {
            boundaries.push(ResolvedBoundary {
                index,
                after_clip_id: a.id.clone(),
                transition: None,
                requested_duration: requested,
                clamped: false,
                demoted_to_cut: false,
            });
            continue;
        }

        // `acrossfade` degenerates when a clip is shorter than twice the fade,
        // so the hard ceiling at any boundary is half the shorter neighbour.
        let ceiling = a.duration().min(b.duration()) / 2.0;
        let duration = requested.min(ceiling).max(0.0);
        let clamped = duration < requested - 1e-6;

        if duration < MIN_TRANSITION_SECS {
            boundaries.push(ResolvedBoundary {
                index,
                after_clip_id: a.id.clone(),
                transition: None,
                requested_duration: requested,
                clamped,
                demoted_to_cut: true,
            });
        } else {
            boundaries.push(ResolvedBoundary {
                index,
                after_clip_id: a.id.clone(),
                transition: Some(ResolvedTransition { kind, duration }),
                requested_duration: requested,
                clamped,
                demoted_to_cut: false,
            });
        }
    }

    // Lay clips out on the output timeline. Each transition pulls the following
    // clip backwards by its duration, which is what makes
    // total = Σ durations − Σ transitions.
    let mut resolved_clips: Vec<ResolvedClip> = Vec::with_capacity(clips.len());
    let mut cursor = 0.0f64;

    for (i, clip) in clips.iter().enumerate() {
        if i > 0 {
            if let Some(t) = boundaries[i - 1].transition.as_ref() {
                cursor -= t.duration;
            }
        }
        let duration = clip.duration();
        resolved_clips.push(ResolvedClip {
            clip_id: clip.id.clone(),
            media_id: clip.media_id.clone(),
            start: cursor,
            end: cursor + duration,
            duration,
        });
        cursor += duration;
    }

    let clamped_count = boundaries.iter().filter(|b| b.clamped).count();

    ResolvedTimeline {
        total_duration: cursor.max(0.0),
        clips: resolved_clips,
        boundaries,
        clamped_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(id: &str, dur: f64) -> Clip {
        Clip {
            id: id.into(),
            media_id: format!("m-{id}"),
            in_point: 0.0,
            out_point: dur,
            muted: false,
        }
    }

    fn project_with(clips: Vec<Clip>, default_transition: TransitionSpec) -> Project {
        Project {
            timeline: clips,
            default_transition,
            ..Default::default()
        }
    }

    #[test]
    fn total_duration_subtracts_every_transition() {
        let p = project_with(
            vec![clip("a", 5.0), clip("b", 5.0), clip("c", 5.0)],
            TransitionSpec {
                kind: "fade".into(),
                duration: 1.0,
                enabled: true,
            },
        );
        let r = resolve_timeline(&p);
        // 5 + 5 + 5 - 1 - 1
        assert!((r.total_duration - 13.0).abs() < 1e-9);
        assert!((r.clips[1].start - 4.0).abs() < 1e-9);
        assert!((r.clips[2].start - 8.0).abs() < 1e-9);
    }

    #[test]
    fn short_clip_clamps_only_its_own_boundaries() {
        // A 1.5s clip cannot host a 1.0s transition: ceiling is 0.75s.
        let p = project_with(
            vec![clip("a", 10.0), clip("b", 1.5), clip("c", 10.0)],
            TransitionSpec {
                kind: "fade".into(),
                duration: 1.0,
                enabled: true,
            },
        );
        let r = resolve_timeline(&p);
        assert!(r.boundaries[0].clamped);
        assert!(r.boundaries[1].clamped);
        assert!((r.boundaries[0].transition.as_ref().unwrap().duration - 0.75).abs() < 1e-9);
        assert_eq!(r.clamped_count, 2);
    }

    #[test]
    fn very_short_clip_demotes_to_hard_cut() {
        let p = project_with(
            vec![clip("a", 10.0), clip("b", 0.3), clip("c", 10.0)],
            TransitionSpec {
                kind: "fade".into(),
                duration: 1.0,
                enabled: true,
            },
        );
        let r = resolve_timeline(&p);
        // ceiling = 0.15 < MIN_TRANSITION_SECS
        assert!(r.boundaries[0].demoted_to_cut);
        assert!(r.boundaries[0].transition.is_none());
        // Hard cuts do not shorten the timeline.
        assert!((r.total_duration - 20.3).abs() < 1e-9);
    }

    #[test]
    fn override_can_force_a_hard_cut() {
        let mut p = project_with(
            vec![clip("a", 5.0), clip("b", 5.0)],
            TransitionSpec {
                kind: "fade".into(),
                duration: 1.0,
                enabled: true,
            },
        );
        p.transition_overrides.push(TransitionOverride {
            after_clip_id: "a".into(),
            kind: None,
            duration: None,
            enabled: Some(false),
        });
        let r = resolve_timeline(&p);
        assert!(r.boundaries[0].transition.is_none());
        assert!(!r.boundaries[0].demoted_to_cut);
        assert!((r.total_duration - 10.0).abs() < 1e-9);
    }

    #[test]
    fn disabling_default_makes_every_boundary_a_cut() {
        let p = project_with(
            vec![clip("a", 5.0), clip("b", 5.0), clip("c", 5.0)],
            TransitionSpec {
                kind: "fade".into(),
                duration: 1.0,
                enabled: false,
            },
        );
        let r = resolve_timeline(&p);
        assert!(r.boundaries.iter().all(|b| b.transition.is_none()));
        assert!((r.total_duration - 15.0).abs() < 1e-9);
    }

    #[test]
    fn single_clip_has_no_boundaries() {
        let p = project_with(vec![clip("a", 7.5)], TransitionSpec::default());
        let r = resolve_timeline(&p);
        assert!(r.boundaries.is_empty());
        assert!((r.total_duration - 7.5).abs() < 1e-9);
    }

    #[test]
    fn empty_timeline_is_zero_length() {
        let p = project_with(vec![], TransitionSpec::default());
        let r = resolve_timeline(&p);
        assert_eq!(r.clips.len(), 0);
        assert!((r.total_duration - 0.0).abs() < 1e-9);
    }
}
