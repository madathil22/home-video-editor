use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use super::caps::Capabilities;
use crate::project::{MusicTrack, Project, ResolvedTimeline};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    pub output_path: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// `"h264"` or `"hevc"`.
    pub codec: String,
    /// NVENC constant-quality target; lower is better quality.
    pub quality: u32,
    pub bitrate_mbps: u32,
    pub audio_bitrate_kbps: u32,
    /// Decode with NVDEC. Frames still round-trip to system memory for the CPU
    /// `xfade`, so this is a measured win rather than an assumed one.
    pub use_nvdec: bool,
}

impl Default for ExportSettings {
    fn default() -> Self {
        Self {
            output_path: String::new(),
            width: 3840,
            height: 2160,
            fps: 30.0,
            codec: "h264".into(),
            quality: 19,
            bitrate_mbps: 45,
            audio_bitrate_kbps: 384,
            use_nvdec: false,
        }
    }
}

pub struct BuiltCommand {
    pub args: Vec<String>,
    pub total_duration: f64,
}

impl BuiltCommand {
    /// Move the filtergraph out of the argument vector and into a file.
    ///
    /// Windows caps an entire command line at 32,767 characters, and the graph
    /// for a timeline of more than a few dozen clips blows past that on its own
    /// — `CreateProcess` then fails with "The filename or extension is too
    /// long." `-/filter_complex` makes ffmpeg read the graph from `path`
    /// instead, which takes the timeline length out of the command line budget
    /// entirely.
    ///
    /// Returns the graph text, which the caller must write to `path` before
    /// spawning ffmpeg. The graph never contains file paths (inputs are
    /// referenced by index), so it needs no escaping.
    pub fn use_filter_script(&mut self, path: &str) -> Option<String> {
        let idx = self.args.iter().position(|a| a == "-filter_complex")?;
        let graph = self.args.get(idx + 1)?.clone();
        self.args[idx] = "-/filter_complex".into();
        self.args[idx + 1] = path.to_string();
        Some(graph)
    }
}

pub(crate) const SAMPLE_RATE: u32 = 48000;

/// Format a float for a filtergraph without scientific notation or a long tail
/// of float noise, which ffmpeg's parser rejects or misreads.
pub(crate) fn fmt(v: f64) -> String {
    let s = format!("{:.6}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-" {
        "0".to_string()
    } else {
        s.to_string()
    }
}

/// The video encoder flags, shared by the single-pass export and by every
/// segment of a segmented export.
///
/// Segments are concatenated with `-c:v copy`, which requires every segment to
/// carry identical codec parameters — so this must be the only place these
/// flags are decided.
pub fn video_encoder_args(caps: &Capabilities, settings: &ExportSettings, fps: f64) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let prefer_hevc = settings.codec.eq_ignore_ascii_case("hevc");
    let encoder = caps.video_encoder(prefer_hevc);
    args.push("-c:v".into());
    args.push(encoder.into());

    if caps.uses_hardware(prefer_hevc) {
        // NVIDIA's latency-tolerant high-quality template.
        args.extend(
            [
                "-preset",
                "p6",
                "-tune",
                "hq",
                "-rc",
                "vbr",
                "-profile:v",
                "high",
            ]
            .iter()
            .map(|s| s.to_string()),
        );
        args.push("-cq".into());
        args.push(settings.quality.to_string());
        args.push("-b:v".into());
        args.push(format!("{}M", settings.bitrate_mbps));
        args.push("-maxrate".into());
        args.push(format!("{}M", (settings.bitrate_mbps as f64 * 1.5) as u32));
        args.push("-bufsize".into());
        args.push(format!("{}M", settings.bitrate_mbps * 3));
        args.push("-bf".into());
        args.push("3".into());
        if caps.b_ref_mode {
            args.push("-b_ref_mode".into());
            args.push("middle".into());
        }
        args.extend(
            [
                "-rc-lookahead",
                "20",
                "-spatial-aq",
                "1",
                "-aq-strength",
                "8",
                "-temporal-aq",
                "1",
            ]
            .iter()
            .map(|s| s.to_string()),
        );
    } else {
        // Software fallback keeps the export working without a usable NVENC.
        args.push("-preset".into());
        args.push("medium".into());
        args.push("-crf".into());
        args.push(settings.quality.to_string());
    }

    args.push("-g".into());
    args.push(((fps * 4.0).round() as u32).to_string());
    args.push("-pix_fmt".into());
    args.push("yuv420p".into());
    args
}

/// The music chain and the `amix` that folds it under the clip audio.
///
/// `music_label` is the already-normalized clip audio to mix into, and the
/// result is left on `[aout]`.
pub fn music_filter_chain(music: &MusicTrack, music_input: usize, total: f64) -> Vec<String> {
    let fade_out_start = (total - music.fade_out).max(0.0);
    let mut chain = format!(
        "[{music_input}:a:0]atrim=start={},asetpts=PTS-STARTPTS,\
aformat=sample_fmts=fltp:sample_rates={SAMPLE_RATE}:channel_layouts=stereo,\
volume={}",
        fmt(music.start_offset),
        fmt(music.volume)
    );
    if music.fade_in > 0.0 {
        chain.push_str(&format!(",afade=t=in:st=0:d={}", fmt(music.fade_in)));
    }
    if music.fade_out > 0.0 {
        chain.push_str(&format!(
            ",afade=t=out:st={}:d={}",
            fmt(fade_out_start),
            fmt(music.fade_out)
        ));
    }
    // Pad with silence then hard-trim so a short music file still covers the
    // whole timeline and a long one is cut to length.
    chain.push_str(&format!(",apad,atrim=start=0:end={}[music]", fmt(total)));
    vec![chain]
}

/// Build the full ffmpeg argument vector for an export.
///
/// The graph is assembled pairwise from the resolved timeline: every boundary is
/// either an `xfade`/`acrossfade` pair or a `concat`, so hard cuts and
/// transitions can be freely interleaved.
pub fn build_export_args(
    project: &Project,
    resolved: &ResolvedTimeline,
    caps: &Capabilities,
    settings: &ExportSettings,
) -> Result<BuiltCommand> {
    if project.timeline.is_empty() {
        return Err(anyhow!("The timeline is empty - add some clips first."));
    }

    let has_any_transition = resolved.boundaries.iter().any(|b| b.transition.is_some());

    // `xfade` refuses 4:2:0 entirely; its pixel formats are 444/GBRP/GRAY only.
    // Normalising to yuv444p is therefore mandatory whenever a transition
    // exists, but pointless cost when every boundary is a hard cut.
    let work_format = if has_any_transition {
        "yuv444p"
    } else {
        "yuv420p"
    };

    let w = settings.width;
    let h = settings.height;
    let fps = settings.fps;

    let mut args: Vec<String> = vec!["-hide_banner".into(), "-y".into()];

    // ---- inputs -----------------------------------------------------------
    // One input per clip, even when two clips share a source file; duplicate
    // inputs are cheaper to reason about than `split` filters.
    let mut input_index: usize = 0;
    let mut clip_inputs: Vec<usize> = Vec::new();
    // Parallel list of extra silent inputs for clips that are muted or have no
    // audio stream, keeping the audio chain the same length as the video chain.
    let mut silent_inputs: Vec<Option<usize>> = Vec::new();

    for clip in &project.timeline {
        let media = project
            .media_for(&clip.media_id)
            .ok_or_else(|| anyhow!("Clip references media that is no longer in the project."))?;

        // `-hwaccel` is an input option, so it must be repeated before each -i.
        if settings.use_nvdec {
            args.push("-hwaccel".into());
            args.push("cuda".into());
        }
        args.push("-i".into());
        args.push(media.path.clone());
        clip_inputs.push(input_index);
        input_index += 1;
    }

    for clip in &project.timeline {
        let media = project.media_for(&clip.media_id).unwrap();
        if media.has_audio && !clip.muted {
            silent_inputs.push(None);
        } else {
            args.push("-f".into());
            args.push("lavfi".into());
            args.push("-i".into());
            args.push(format!(
                "anullsrc=channel_layout=stereo:sample_rate={SAMPLE_RATE}"
            ));
            silent_inputs.push(Some(input_index));
            input_index += 1;
        }
    }

    let music_input = project.music.as_ref().map(|m| {
        if m.loop_to_fit {
            args.push("-stream_loop".into());
            args.push("-1".into());
        }
        args.push("-i".into());
        args.push(m.path.clone());
        let idx = input_index;
        input_index += 1;
        idx
    });

    // ---- per-clip normalisation ------------------------------------------
    let mut graph: Vec<String> = Vec::new();

    for (i, clip) in project.timeline.iter().enumerate() {
        let src = clip_inputs[i];
        // scale+pad rather than a bare scale so mixed aspect ratios letterbox
        // instead of stretching. setsar/settb/fps satisfy xfade's requirement
        // that both inputs share size, SAR, timebase and a constant frame rate.
        graph.push(format!(
            "[{src}:v:0]trim=start={}:end={},setpts=PTS-STARTPTS,fps={},\
scale={w}:{h}:force_original_aspect_ratio=decrease,\
pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format={work_format},settb=AVTB[v{i}]",
            fmt(clip.in_point),
            fmt(clip.out_point),
            fmt(fps),
        ));

        let dur = clip.duration();
        match silent_inputs[i] {
            Some(silent) => graph.push(format!(
                "[{silent}:a:0]atrim=start=0:end={},asetpts=PTS-STARTPTS,\
aformat=sample_fmts=fltp:sample_rates={SAMPLE_RATE}:channel_layouts=stereo[a{i}]",
                fmt(dur)
            )),
            None => graph.push(format!(
                "[{src}:a:0]atrim=start={}:end={},asetpts=PTS-STARTPTS,\
aformat=sample_fmts=fltp:sample_rates={SAMPLE_RATE}:channel_layouts=stereo,\
apad,atrim=start=0:end={}[a{i}]",
                fmt(clip.in_point),
                fmt(clip.out_point),
                fmt(dur)
            )),
        }
    }

    // ---- chain clips together --------------------------------------------
    let mut v_label = "v0".to_string();
    let mut a_label = "a0".to_string();
    // Running length of the accumulated output, which is what `xfade`'s offset
    // is measured against.
    let mut acc = project.timeline[0].duration();

    for (i, boundary) in resolved.boundaries.iter().enumerate() {
        let next_dur = project.timeline[i + 1].duration();
        let out_v = format!("vx{i}");
        let out_a = format!("ax{i}");

        match &boundary.transition {
            Some(t) => {
                // offset_k = (accumulated output length so far) - transition
                let offset = (acc - t.duration).max(0.0);
                graph.push(format!(
                    "[{v_label}][v{}]xfade=transition={}:duration={}:offset={}[{out_v}]",
                    i + 1,
                    t.kind,
                    fmt(t.duration),
                    fmt(offset)
                ));
                // acrossfade has no offset; it always splices at the end of its
                // first input, which lines up because each audio segment is
                // exactly as long as its video segment.
                graph.push(format!(
                    "[{a_label}][a{}]acrossfade=d={}:c1=tri:c2=tri[{out_a}]",
                    i + 1,
                    fmt(t.duration)
                ));
                acc += next_dur - t.duration;
            }
            None => {
                graph.push(format!(
                    "[{v_label}][v{}]concat=n=2:v=1:a=0[{out_v}]",
                    i + 1
                ));
                graph.push(format!(
                    "[{a_label}][a{}]concat=n=2:v=0:a=1[{out_a}]",
                    i + 1
                ));
                acc += next_dur;
            }
        }

        v_label = out_v;
        a_label = out_a;
    }

    let total = acc;

    // ---- music ------------------------------------------------------------
    if let (Some(midx), Some(music)) = (music_input, project.music.as_ref()) {
        graph.extend(music_filter_chain(music, midx, total));

        // normalize=0 keeps amix from halving the clip audio when music joins.
        graph.push(format!(
            "[{a_label}][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]"
        ));
        a_label = "aout".to_string();
    }

    // ---- output -----------------------------------------------------------
    args.push("-filter_complex".into());
    args.push(graph.join(";"));
    args.push("-map".into());
    args.push(format!("[{v_label}]"));
    args.push("-map".into());
    args.push(format!("[{a_label}]"));

    args.extend(video_encoder_args(caps, settings, fps));

    args.push("-c:a".into());
    args.push("aac".into());
    args.push("-b:a".into());
    args.push(format!("{}k", settings.audio_bitrate_kbps));
    args.push("-ar".into());
    args.push(SAMPLE_RATE.to_string());
    args.push("-movflags".into());
    args.push("+faststart".into());
    args.push("-progress".into());
    args.push("pipe:1".into());
    args.push("-nostats".into());
    args.push(settings.output_path.clone());

    Ok(BuiltCommand {
        args,
        total_duration: total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{
        resolve_timeline, Clip, MediaItem, MusicTrack, TransitionOverride, TransitionSpec,
    };

    fn media(id: &str, has_audio: bool) -> MediaItem {
        MediaItem {
            id: id.into(),
            path: format!("C:\\video\\{id}.mp4"),
            file_name: format!("{id}.mp4"),
            proxy_path: None,
            thumbnail_path: None,
            duration: 60.0,
            width: 3840,
            height: 2160,
            fps: 30.0,
            has_audio,
            rotation: 0,
            video_codec: "hevc".into(),
            creation_time: None,
        }
    }

    fn clip(id: &str, media_id: &str, dur: f64) -> Clip {
        Clip {
            id: id.into(),
            media_id: media_id.into(),
            in_point: 0.0,
            out_point: dur,
            muted: false,
        }
    }

    fn hw_caps() -> Capabilities {
        Capabilities {
            nvenc_h264: true,
            nvenc_hevc: true,
            b_ref_mode: true,
            ..Default::default()
        }
    }

    fn project_of(n: usize, dur: f64, transition: TransitionSpec) -> Project {
        let mut p = Project {
            default_transition: transition,
            ..Default::default()
        };
        for i in 0..n {
            let mid = format!("m{i}");
            p.media.push(media(&mid, true));
            p.timeline.push(clip(&format!("c{i}"), &mid, dur));
        }
        p
    }

    fn graph_of(args: &[String]) -> String {
        let idx = args.iter().position(|a| a == "-filter_complex").unwrap();
        args[idx + 1].clone()
    }

    #[test]
    fn rejects_an_empty_timeline() {
        let p = Project::default();
        let r = resolve_timeline(&p);
        let err = build_export_args(&p, &r, &hw_caps(), &ExportSettings::default())
            .err()
            .expect("an empty timeline must be rejected");
        assert!(err.to_string().contains("empty"));
    }

    #[test]
    fn moves_the_graph_into_a_script_file() {
        let p = project_of(3, 5.0, TransitionSpec::default());
        let r = resolve_timeline(&p);
        let mut built = build_export_args(&p, &r, &hw_caps(), &ExportSettings::default()).unwrap();
        let inline = graph_of(&built.args);

        let graph = built
            .use_filter_script("C:\\tmp\\g.txt")
            .expect("the graph must be extractable");

        assert_eq!(graph, inline);
        assert!(!built.args.iter().any(|a| a == "-filter_complex"));
        let idx = built
            .args
            .iter()
            .position(|a| a == "-/filter_complex")
            .expect("the script flag must be present");
        assert_eq!(built.args[idx + 1], "C:\\tmp\\g.txt");
        // the graph itself must be gone from the command line, which is the
        // whole point of the exercise
        assert!(!built.args.iter().any(|a| a.contains("xfade")));
    }

    #[test]
    fn a_long_timeline_fits_in_a_windows_command_line() {
        // Windows' CreateProcess limit. A 120-clip timeline exceeds it on the
        // filtergraph alone, which is the bug this guards against.
        const WINDOWS_LIMIT: usize = 32_767;

        let p = project_of(120, 8.0, TransitionSpec::default());
        let r = resolve_timeline(&p);
        let mut built = build_export_args(&p, &r, &hw_caps(), &ExportSettings::default()).unwrap();

        let inline_len: usize = built.args.iter().map(|a| a.len() + 3).sum();
        assert!(
            inline_len > WINDOWS_LIMIT,
            "expected the inline form to overflow, got {inline_len}"
        );

        built.use_filter_script("C:\\tmp\\g.txt").unwrap();
        let script_len: usize = built.args.iter().map(|a| a.len() + 3).sum();
        assert!(
            script_len < WINDOWS_LIMIT,
            "the script form must fit, got {script_len}"
        );
    }

    #[test]
    fn xfade_offsets_accumulate_across_the_chain() {
        let p = project_of(
            3,
            5.0,
            TransitionSpec {
                kind: "fade".into(),
                duration: 1.0,
                enabled: true,
            },
        );
        let r = resolve_timeline(&p);
        let built = build_export_args(&p, &r, &hw_caps(), &ExportSettings::default()).unwrap();
        let g = graph_of(&built.args);

        // First boundary: 5 - 1 = 4. Second: (5 + 5 - 1) - 1 = 8.
        assert!(
            g.contains("xfade=transition=fade:duration=1:offset=4"),
            "{g}"
        );
        assert!(
            g.contains("xfade=transition=fade:duration=1:offset=8"),
            "{g}"
        );
        assert!((built.total_duration - 13.0).abs() < 1e-9);
    }

    #[test]
    fn total_duration_matches_the_resolver() {
        let p = project_of(
            4,
            7.0,
            TransitionSpec {
                kind: "dissolve".into(),
                duration: 1.5,
                enabled: true,
            },
        );
        let r = resolve_timeline(&p);
        let built = build_export_args(&p, &r, &hw_caps(), &ExportSettings::default()).unwrap();
        // The export and the timeline must never disagree about length.
        assert!((built.total_duration - r.total_duration).abs() < 1e-9);
    }

    #[test]
    fn uses_yuv444p_only_when_a_transition_exists() {
        let with = project_of(2, 5.0, TransitionSpec::default());
        let r = resolve_timeline(&with);
        let g = graph_of(
            &build_export_args(&with, &r, &hw_caps(), &ExportSettings::default())
                .unwrap()
                .args,
        );
        // xfade cannot negotiate 4:2:0 at all.
        assert!(g.contains("format=yuv444p"), "{g}");

        let without = project_of(
            2,
            5.0,
            TransitionSpec {
                kind: "fade".into(),
                duration: 1.0,
                enabled: false,
            },
        );
        let r2 = resolve_timeline(&without);
        let g2 = graph_of(
            &build_export_args(&without, &r2, &hw_caps(), &ExportSettings::default())
                .unwrap()
                .args,
        );
        assert!(g2.contains("format=yuv420p"), "{g2}");
        assert!(!g2.contains("xfade"));
        assert!(g2.contains("concat=n=2:v=1:a=0"), "{g2}");
    }

    #[test]
    fn interleaves_hard_cuts_and_transitions() {
        let mut p = project_of(
            3,
            5.0,
            TransitionSpec {
                kind: "fade".into(),
                duration: 1.0,
                enabled: true,
            },
        );
        // Force a hard cut at the first boundary only.
        p.transition_overrides.push(TransitionOverride {
            after_clip_id: "c0".into(),
            kind: None,
            duration: None,
            enabled: Some(false),
        });
        let r = resolve_timeline(&p);
        let built = build_export_args(&p, &r, &hw_caps(), &ExportSettings::default()).unwrap();
        let g = graph_of(&built.args);

        assert!(g.contains("concat=n=2:v=1:a=0"), "{g}");
        // The surviving transition's offset accounts for the un-shortened cut:
        // 5 + 5 - 1 = 9.
        assert!(g.contains("offset=9"), "{g}");
        assert!((built.total_duration - 14.0).abs() < 1e-9);
    }

    #[test]
    fn silent_input_is_added_for_clips_without_audio() {
        let mut p = project_of(2, 5.0, TransitionSpec::default());
        p.media[1].has_audio = false;
        let r = resolve_timeline(&p);
        let built = build_export_args(&p, &r, &hw_caps(), &ExportSettings::default()).unwrap();
        let joined = built.args.join(" ");
        assert!(
            joined.contains("anullsrc=channel_layout=stereo"),
            "{joined}"
        );
    }

    #[test]
    fn muted_clip_uses_silence_instead_of_its_own_audio() {
        let mut p = project_of(2, 5.0, TransitionSpec::default());
        p.timeline[0].muted = true;
        let r = resolve_timeline(&p);
        let built = build_export_args(&p, &r, &hw_caps(), &ExportSettings::default()).unwrap();
        assert!(built.args.join(" ").contains("anullsrc"));
    }

    #[test]
    fn music_is_mixed_without_normalisation_and_trimmed_to_length() {
        let mut p = project_of(
            2,
            5.0,
            TransitionSpec {
                kind: "fade".into(),
                duration: 1.0,
                enabled: true,
            },
        );
        p.music = Some(MusicTrack {
            path: "C:\\music\\bed.mp3".into(),
            file_name: "bed.mp3".into(),
            volume: 0.18,
            fade_in: 2.0,
            fade_out: 3.0,
            start_offset: 0.0,
            duration: 200.0,
            loop_to_fit: false,
        });
        let r = resolve_timeline(&p);
        let built = build_export_args(&p, &r, &hw_caps(), &ExportSettings::default()).unwrap();
        let g = graph_of(&built.args);

        // normalize=0 stops amix halving the clip audio.
        assert!(
            g.contains("amix=inputs=2:duration=first:dropout_transition=0:normalize=0"),
            "{g}"
        );
        assert!(g.contains("volume=0.18"), "{g}");
        // Timeline is 9s, so the fade-out starts at 9 - 3 = 6.
        assert!(g.contains("afade=t=out:st=6:d=3"), "{g}");
        assert!(g.contains("atrim=start=0:end=9[music]"), "{g}");
        assert!(built.args.iter().any(|a| a == "[aout]"));
    }

    #[test]
    fn looping_music_adds_stream_loop_before_its_input() {
        let mut p = project_of(2, 5.0, TransitionSpec::default());
        p.music = Some(MusicTrack {
            path: "C:\\music\\short.mp3".into(),
            file_name: "short.mp3".into(),
            volume: 0.2,
            fade_in: 0.0,
            fade_out: 0.0,
            start_offset: 0.0,
            duration: 3.0,
            loop_to_fit: true,
        });
        let r = resolve_timeline(&p);
        let built = build_export_args(&p, &r, &hw_caps(), &ExportSettings::default()).unwrap();
        let pos = built.args.iter().position(|a| a == "-stream_loop").unwrap();
        assert_eq!(built.args[pos + 1], "-1");
        assert_eq!(built.args[pos + 2], "-i");
        assert_eq!(built.args[pos + 3], "C:\\music\\short.mp3");
    }

    #[test]
    fn single_clip_produces_no_transition_filters() {
        let p = project_of(1, 12.0, TransitionSpec::default());
        let r = resolve_timeline(&p);
        let built = build_export_args(&p, &r, &hw_caps(), &ExportSettings::default()).unwrap();
        let g = graph_of(&built.args);
        assert!(!g.contains("xfade"));
        assert!(!g.contains("concat"));
        assert!(built.args.contains(&"[v0]".to_string()));
        assert!((built.total_duration - 12.0).abs() < 1e-9);
    }

    #[test]
    fn drops_b_ref_mode_when_the_encoder_rejects_it() {
        let caps = Capabilities {
            nvenc_h264: true,
            b_ref_mode: false,
            ..Default::default()
        };
        let p = project_of(2, 5.0, TransitionSpec::default());
        let r = resolve_timeline(&p);
        let built = build_export_args(&p, &r, &caps, &ExportSettings::default()).unwrap();
        assert!(!built.args.iter().any(|a| a == "-b_ref_mode"));
        assert!(built.args.iter().any(|a| a == "h264_nvenc"));
    }

    #[test]
    fn falls_back_to_libx264_without_nvenc() {
        let caps = Capabilities::default();
        let p = project_of(2, 5.0, TransitionSpec::default());
        let r = resolve_timeline(&p);
        let built = build_export_args(&p, &r, &caps, &ExportSettings::default()).unwrap();
        assert!(built.args.iter().any(|a| a == "libx264"));
        assert!(built.args.iter().any(|a| a == "-crf"));
        assert!(!built.args.iter().any(|a| a == "-cq"));
    }

    #[test]
    fn repeats_hwaccel_before_every_input() {
        let p = project_of(3, 5.0, TransitionSpec::default());
        let r = resolve_timeline(&p);
        let settings = ExportSettings {
            use_nvdec: true,
            ..Default::default()
        };
        let built = build_export_args(&p, &r, &hw_caps(), &settings).unwrap();
        // -hwaccel is an input option, so one per clip input.
        assert_eq!(built.args.iter().filter(|a| *a == "-hwaccel").count(), 3);
    }

    #[test]
    fn always_requests_machine_readable_progress() {
        let p = project_of(2, 5.0, TransitionSpec::default());
        let r = resolve_timeline(&p);
        let built = build_export_args(&p, &r, &hw_caps(), &ExportSettings::default()).unwrap();
        let pos = built.args.iter().position(|a| a == "-progress").unwrap();
        assert_eq!(built.args[pos + 1], "pipe:1");
    }

    #[test]
    fn formats_floats_without_scientific_notation() {
        assert_eq!(fmt(4.0), "4");
        assert_eq!(fmt(1.5), "1.5");
        assert_eq!(fmt(0.0), "0");
        assert_eq!(fmt(29.97), "29.97");
        assert_eq!(fmt(0.0000001), "0");
    }

    #[test]
    fn clamped_boundaries_reach_the_filtergraph() {
        // A 1.5s clip forces the global 1.0s transition down to 0.75s.
        let mut p = project_of(
            3,
            10.0,
            TransitionSpec {
                kind: "fade".into(),
                duration: 1.0,
                enabled: true,
            },
        );
        p.timeline[1].out_point = 1.5;
        let r = resolve_timeline(&p);
        let built = build_export_args(&p, &r, &hw_caps(), &ExportSettings::default()).unwrap();
        let g = graph_of(&built.args);
        assert!(g.contains("duration=0.75"), "{g}");
        assert!(g.contains("acrossfade=d=0.75"), "{g}");
    }
}
