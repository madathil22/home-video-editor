//! Segmented export: render the timeline as many small ffmpeg jobs and
//! concatenate them, instead of one graph that opens every clip at once.
//!
//! The single-graph exporter in [`super::filtergraph`] is correct but does not
//! scale. It opens one input per clip, and because every clip's PTS is reset to
//! zero, ffmpeg decodes all of them concurrently and buffers the ones whose
//! `xfade` is not ready yet. Memory grows with the clip count until it dies:
//! measured, 16 clips at 4K and 80 clips at 720p both exit with
//! `-12 (Cannot allocate memory)`. A 10-15 minute holiday video is well past
//! that, so the single-graph path is only usable for very short timelines.
//!
//! Here the timeline is cut into independent pieces instead:
//!
//! ```text
//!  clip0            clip1            clip2
//!  [--- body0 ---][X][-- body1 --][X][--- body2 ---]
//!                  ^                ^
//!                  transition segments (2 inputs each)
//! ```
//!
//! No job ever opens more than two inputs, so peak memory is flat no matter how
//! long the timeline is. Segments are written as Matroska with **PCM** audio:
//! AAC carries encoder delay per file, which would click at every join. The
//! final pass concatenates with `-c:v copy` — the video is never re-encoded —
//! and encodes audio to AAC once, mixing the music bed over the whole timeline.

use anyhow::{anyhow, Result};

use super::caps::Capabilities;
use super::filtergraph::{fmt, music_filter_chain, video_encoder_args, ExportSettings, SAMPLE_RATE};
use crate::project::{Project, ResolvedTimeline};

/// Bodies shorter than this are dropped rather than encoded; a segment of a
/// frame or two contributes nothing and risks a zero-length file.
const MIN_SEGMENT_SECS: f64 = 0.04;

#[derive(Debug, Clone, PartialEq)]
pub enum SegmentKind {
    /// The part of a clip not consumed by an adjacent transition.
    Body { clip_index: usize, src_start: f64 },
    /// The overlap between two clips.
    Transition {
        boundary_index: usize,
        kind: String,
        a_src_start: f64,
        b_src_start: f64,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub kind: SegmentKind,
    pub duration: f64,
}

/// Cut the resolved timeline into independently renderable pieces, in output
/// order.
///
/// Each transition eats `d` seconds from the end of the clip before it and `d`
/// from the start of the clip after it, so the bodies either side shrink and the
/// overlap becomes its own segment. Total length is unchanged:
/// `Σ body + Σ d == Σ clip_duration − Σ d`.
pub fn plan_segments(project: &Project, resolved: &ResolvedTimeline) -> Result<Vec<Segment>> {
    if project.timeline.is_empty() {
        return Err(anyhow!("The timeline is empty - add some clips first."));
    }

    let n = project.timeline.len();
    let mut segments = Vec::new();

    // The transition duration eating into each end of clip `i`. Boundary `i`
    // sits after clip `i`, so clip `i` is bounded by boundary `i-1` and `i`.
    let overlap_at = |boundary: usize| -> f64 {
        resolved
            .boundaries
            .get(boundary)
            .and_then(|b| b.transition.as_ref())
            .map(|t| t.duration)
            .unwrap_or(0.0)
    };

    for i in 0..n {
        let clip = &project.timeline[i];
        let head = if i > 0 { overlap_at(i - 1) } else { 0.0 };
        let tail = overlap_at(i);

        let body_len = clip.duration() - head - tail;
        if body_len > MIN_SEGMENT_SECS {
            segments.push(Segment {
                kind: SegmentKind::Body {
                    clip_index: i,
                    src_start: clip.in_point + head,
                },
                duration: body_len,
            });
        }

        if i + 1 < n {
            if let Some(t) = resolved.boundaries.get(i).and_then(|b| b.transition.as_ref()) {
                let next = &project.timeline[i + 1];
                segments.push(Segment {
                    kind: SegmentKind::Transition {
                        boundary_index: i,
                        kind: t.kind.clone(),
                        a_src_start: clip.out_point - t.duration,
                        b_src_start: next.in_point,
                    },
                    duration: t.duration,
                });
            }
        }
    }

    if segments.is_empty() {
        return Err(anyhow!("The timeline is too short to export."));
    }
    Ok(segments)
}

/// The normalisation chain that makes any source conform to the project format.
///
/// `xfade` hard-errors on mismatched size, SAR, timebase or frame rate and
/// rejects 4:2:0 outright, so transition segments work in yuv444p and convert
/// back afterwards.
fn normalise(input: usize, label: &str, len: f64, settings: &ExportSettings, format: &str) -> String {
    format!(
        "[{input}:v:0]fps={},scale={w}:{h}:force_original_aspect_ratio=decrease,\
pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS,\
trim=start=0:end={},setpts=PTS-STARTPTS,format={format},settb=AVTB[{label}]",
        fmt(settings.fps),
        fmt(len),
        w = settings.width,
        h = settings.height,
    )
}

fn normalise_audio(input: usize, label: &str, len: f64) -> String {
    format!(
        "[{input}:a:0]aformat=sample_fmts=fltp:sample_rates={SAMPLE_RATE}:channel_layouts=stereo,\
asetpts=PTS-STARTPTS,apad,atrim=start=0:end={},asetpts=PTS-STARTPTS[{label}]",
        fmt(len)
    )
}

/// Push `-i` for a clip, seeking on the *input* so a long source is not decoded
/// from the beginning just to reach a segment near its end.
fn push_source(args: &mut Vec<String>, path: &str, start: f64, len: f64, use_nvdec: bool) {
    if use_nvdec {
        args.push("-hwaccel".into());
        args.push("cuda".into());
    }
    args.push("-ss".into());
    args.push(fmt(start));
    args.push("-t".into());
    args.push(fmt(len));
    args.push("-i".into());
    args.push(path.to_string());
}

fn push_silence(args: &mut Vec<String>) {
    args.push("-f".into());
    args.push("lavfi".into());
    args.push("-i".into());
    args.push(format!(
        "anullsrc=channel_layout=stereo:sample_rate={SAMPLE_RATE}"
    ));
}

/// Append one segment's inputs, filters and output to a command being built.
fn push_segment(
    project: &Project,
    segment: &Segment,
    caps: &Capabilities,
    settings: &ExportSettings,
    output: &str,
    slot: usize,
    input_index: &mut usize,
    inputs: &mut Vec<String>,
    graph: &mut Vec<String>,
    outputs: &mut Vec<String>,
) -> Result<()> {
    let len = segment.duration;
    let v = format!("v{slot}");
    let a = format!("a{slot}");

    match &segment.kind {
        SegmentKind::Body {
            clip_index,
            src_start,
        } => {
            let clip = &project.timeline[*clip_index];
            let media = project
                .media_for(&clip.media_id)
                .ok_or_else(|| anyhow!("Clip references media that is no longer in the project."))?;

            let src = *input_index;
            push_source(inputs, &media.path, *src_start, len, settings.use_nvdec);
            *input_index += 1;
            graph.push(normalise(src, &v, len, settings, "yuv420p"));

            if media.has_audio && !clip.muted {
                graph.push(normalise_audio(src, &a, len));
            } else {
                push_silence(inputs);
                graph.push(normalise_audio(*input_index, &a, len));
                *input_index += 1;
            }
        }
        SegmentKind::Transition {
            boundary_index,
            kind,
            a_src_start,
            b_src_start,
        } => {
            let a_clip = &project.timeline[*boundary_index];
            let b_clip = &project.timeline[*boundary_index + 1];
            let a_media = project
                .media_for(&a_clip.media_id)
                .ok_or_else(|| anyhow!("Clip references media that is no longer in the project."))?;
            let b_media = project
                .media_for(&b_clip.media_id)
                .ok_or_else(|| anyhow!("Clip references media that is no longer in the project."))?;

            let a_src = *input_index;
            push_source(inputs, &a_media.path, *a_src_start, len, settings.use_nvdec);
            *input_index += 1;
            let b_src = *input_index;
            push_source(inputs, &b_media.path, *b_src_start, len, settings.use_nvdec);
            *input_index += 1;

            graph.push(normalise(a_src, &format!("{v}a"), len, settings, "yuv444p"));
            graph.push(normalise(b_src, &format!("{v}b"), len, settings, "yuv444p"));
            // Both inputs are exactly `len` long and start at zero, so the
            // crossfade covers the whole segment and offset is 0.
            graph.push(format!(
                "[{v}a][{v}b]xfade=transition={kind}:duration={0}:offset=0,format=yuv420p[{v}]",
                fmt(len)
            ));

            let a_audio = if a_media.has_audio && !a_clip.muted {
                a_src
            } else {
                push_silence(inputs);
                let i = *input_index;
                *input_index += 1;
                i
            };
            let b_audio = if b_media.has_audio && !b_clip.muted {
                b_src
            } else {
                push_silence(inputs);
                let i = *input_index;
                *input_index += 1;
                i
            };

            graph.push(normalise_audio(a_audio, &format!("{a}a"), len));
            graph.push(normalise_audio(b_audio, &format!("{a}b"), len));
            // acrossfade of two `len`-long inputs yields exactly `len`.
            graph.push(format!(
                "[{a}a][{a}b]acrossfade=d={}:c1=tri:c2=tri[{a}]",
                fmt(len)
            ));
        }
    }

    outputs.push("-map".into());
    outputs.push(format!("[{v}]"));
    outputs.push("-map".into());
    outputs.push(format!("[{a}]"));
    outputs.extend(video_encoder_args(caps, settings, settings.fps));
    // PCM, not AAC: AAC's per-file encoder delay would click at every join.
    outputs.push("-c:a".into());
    outputs.push("pcm_s16le".into());
    outputs.push("-ar".into());
    outputs.push(SAMPLE_RATE.to_string());
    outputs.push(output.to_string());
    Ok(())
}

/// Build the ffmpeg arguments that render one segment to `output`.
pub fn segment_args(
    project: &Project,
    segment: &Segment,
    caps: &Capabilities,
    settings: &ExportSettings,
    output: &str,
) -> Result<Vec<String>> {
    let mut inputs: Vec<String> = Vec::new();
    let mut graph: Vec<String> = Vec::new();
    let mut outputs: Vec<String> = Vec::new();
    let mut input_index = 0usize;

    push_segment(
        project,
        segment,
        caps,
        settings,
        output,
        0,
        &mut input_index,
        &mut inputs,
        &mut graph,
        &mut outputs,
    )?;

    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-y".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
    ];
    args.extend(inputs);
    args.push("-filter_complex".into());
    args.push(graph.join(";"));
    args.extend(outputs);
    Ok(args)
}

/// The body of a concat demuxer list file.
///
/// Single quotes are the demuxer's escape character, so a path containing one
/// has to close, escape and reopen the quoting.
pub fn concat_list(paths: &[String]) -> String {
    let mut out = String::new();
    for p in paths {
        out.push_str(&format!("file '{}'\n", p.replace('\'', "'\\''")));
    }
    out
}

/// Build the final pass: stitch the segments and lay the music over the top.
///
/// Video is copied straight through, so this pass costs a fraction of the
/// segment rendering and loses no quality.
pub fn concat_args(
    project: &Project,
    settings: &ExportSettings,
    list_path: &str,
    total: f64,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-y".into(),
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        list_path.to_string(),
    ];

    let music_input = project.music.as_ref().map(|m| {
        if m.loop_to_fit {
            args.push("-stream_loop".into());
            args.push("-1".into());
        }
        args.push("-i".into());
        args.push(m.path.clone());
        1usize
    });

    args.push("-map".into());
    args.push("0:v:0".into());

    match (music_input, project.music.as_ref()) {
        (Some(midx), Some(music)) => {
            let mut graph = music_filter_chain(music, midx, total);
            // normalize=0 keeps amix from halving the clip audio when music joins.
            graph.push(
                "[0:a:0][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]"
                    .to_string(),
            );
            args.push("-filter_complex".into());
            args.push(graph.join(";"));
            args.push("-map".into());
            args.push("[aout]".into());
        }
        _ => {
            args.push("-map".into());
            args.push("0:a:0".into());
        }
    }

    args.push("-c:v".into());
    args.push("copy".into());
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
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{resolve_timeline, Clip, MediaItem, TransitionSpec};

    fn media(id: &str, has_audio: bool) -> MediaItem {
        MediaItem {
            id: id.into(),
            path: format!("C:\\clips\\{id}.mp4"),
            file_name: format!("{id}.mp4"),
            proxy_path: None,
            thumbnail_path: None,
            duration: 30.0,
            width: 3840,
            height: 2160,
            fps: 30.0,
            has_audio,
            rotation: 0,
            video_codec: "h264".into(),
            creation_time: None,
        }
    }

    fn clip(id: &str, media_id: &str, in_point: f64, out_point: f64) -> Clip {
        Clip {
            id: id.into(),
            media_id: media_id.into(),
            in_point,
            out_point,
            muted: false,
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
            p.timeline.push(clip(&format!("c{i}"), &mid, 0.0, dur));
        }
        p
    }

    fn caps() -> Capabilities {
        Capabilities {
            nvenc_h264: true,
            nvenc_hevc: true,
            b_ref_mode: true,
            ..Default::default()
        }
    }

    #[test]
    fn segments_alternate_body_and_transition() {
        let p = project_of(3, 10.0, TransitionSpec::default());
        let r = resolve_timeline(&p);
        let s = plan_segments(&p, &r).unwrap();

        // body, trans, body, trans, body
        assert_eq!(s.len(), 5);
        assert!(matches!(s[0].kind, SegmentKind::Body { .. }));
        assert!(matches!(s[1].kind, SegmentKind::Transition { .. }));
        assert!(matches!(s[2].kind, SegmentKind::Body { .. }));
        assert!(matches!(s[3].kind, SegmentKind::Transition { .. }));
        assert!(matches!(s[4].kind, SegmentKind::Body { .. }));
    }

    #[test]
    fn segment_durations_sum_to_the_resolved_total() {
        for n in [2usize, 3, 7, 40] {
            let p = project_of(n, 6.0, TransitionSpec::default());
            let r = resolve_timeline(&p);
            let s = plan_segments(&p, &r).unwrap();
            let sum: f64 = s.iter().map(|x| x.duration).sum();
            assert!(
                (sum - r.total_duration).abs() < 1e-6,
                "n={n}: segments {sum} != resolved {}",
                r.total_duration
            );
        }
    }

    #[test]
    fn hard_cuts_produce_only_bodies() {
        let p = project_of(
            4,
            5.0,
            TransitionSpec {
                enabled: false,
                ..Default::default()
            },
        );
        let r = resolve_timeline(&p);
        let s = plan_segments(&p, &r).unwrap();
        assert_eq!(s.len(), 4);
        assert!(s.iter().all(|x| matches!(x.kind, SegmentKind::Body { .. })));
    }

    #[test]
    fn transition_segments_read_the_overlapping_source_ranges() {
        let p = project_of(2, 10.0, TransitionSpec::default());
        let r = resolve_timeline(&p);
        let s = plan_segments(&p, &r).unwrap();

        let t = s
            .iter()
            .find(|x| matches!(x.kind, SegmentKind::Transition { .. }))
            .unwrap();
        match &t.kind {
            SegmentKind::Transition {
                a_src_start,
                b_src_start,
                ..
            } => {
                // the tail of clip 0 and the head of clip 1
                assert!((a_src_start - 9.0).abs() < 1e-9);
                assert!((b_src_start - 0.0).abs() < 1e-9);
            }
            _ => unreachable!(),
        }
        assert!((t.duration - 1.0).abs() < 1e-9);
    }

    #[test]
    fn a_body_fully_eaten_by_transitions_is_dropped() {
        // A 2s clip between two 1s transitions has nothing left of its own.
        let mut p = project_of(3, 2.0, TransitionSpec::default());
        p.timeline[0].out_point = 10.0;
        p.timeline[2].out_point = 10.0;
        p.media[0].duration = 10.0;
        p.media[2].duration = 10.0;
        let r = resolve_timeline(&p);
        let s = plan_segments(&p, &r).unwrap();

        let bodies = s
            .iter()
            .filter(|x| matches!(x.kind, SegmentKind::Body { .. }))
            .count();
        assert_eq!(bodies, 2, "the middle clip has no body left");
        let sum: f64 = s.iter().map(|x| x.duration).sum();
        assert!((sum - r.total_duration).abs() < 1e-6);
    }

    #[test]
    fn no_segment_opens_more_than_two_sources() {
        // This is the entire point: peak memory must not grow with the timeline.
        let p = project_of(50, 6.0, TransitionSpec::default());
        let r = resolve_timeline(&p);
        let s = plan_segments(&p, &r).unwrap();
        for seg in &s {
            let args = segment_args(&p, seg, &caps(), &ExportSettings::default(), "o.mkv").unwrap();
            let inputs = args.iter().filter(|a| *a == "-i").count();
            assert!(inputs <= 3, "segment opened {inputs} inputs");
        }
    }

    #[test]
    fn every_segment_command_fits_in_a_windows_command_line() {
        let p = project_of(200, 6.0, TransitionSpec::default());
        let r = resolve_timeline(&p);
        let s = plan_segments(&p, &r).unwrap();
        for seg in &s {
            let args = segment_args(&p, seg, &caps(), &ExportSettings::default(), "o.mkv").unwrap();
            let len: usize = args.iter().map(|a| a.len() + 3).sum();
            assert!(len < 32_767, "segment command line was {len}");
        }
    }

    #[test]
    fn muted_and_silent_clips_get_a_generated_audio_track() {
        let mut p = project_of(2, 5.0, TransitionSpec::default());
        p.timeline[0].muted = true;
        p.media[1].has_audio = false;
        let r = resolve_timeline(&p);
        let s = plan_segments(&p, &r).unwrap();

        for seg in &s {
            let args = segment_args(&p, seg, &caps(), &ExportSettings::default(), "o.mkv").unwrap();
            assert!(
                args.iter().any(|a| a.contains("anullsrc")),
                "expected generated silence"
            );
            // the audio map must still be satisfied
            assert!(args.iter().any(|a| a == "[a0]"));
        }
    }

    #[test]
    fn segments_encode_pcm_so_joins_do_not_click() {
        let p = project_of(2, 5.0, TransitionSpec::default());
        let r = resolve_timeline(&p);
        let s = plan_segments(&p, &r).unwrap();
        let args = segment_args(&p, &s[0], &caps(), &ExportSettings::default(), "o.mkv").unwrap();
        let idx = args.iter().position(|a| a == "-c:a").unwrap();
        assert_eq!(args[idx + 1], "pcm_s16le");
    }

    #[test]
    fn transition_segments_work_in_yuv444_because_xfade_rejects_420() {
        let p = project_of(2, 5.0, TransitionSpec::default());
        let r = resolve_timeline(&p);
        let s = plan_segments(&p, &r).unwrap();
        let t = s
            .iter()
            .find(|x| matches!(x.kind, SegmentKind::Transition { .. }))
            .unwrap();
        let args = segment_args(&p, t, &caps(), &ExportSettings::default(), "o.mkv").unwrap();
        let graph = args
            .iter()
            .find(|a| a.contains("xfade"))
            .expect("a transition segment must contain an xfade");
        assert!(graph.contains("format=yuv444p"));
        // ...and must come back to 420 so every segment concatenates.
        assert!(graph.contains("format=yuv420p"));
    }

    #[test]
    fn bodies_seek_on_the_input_rather_than_decoding_from_zero() {
        let mut p = project_of(1, 30.0, TransitionSpec::default());
        p.timeline[0].in_point = 25.0;
        p.timeline[0].out_point = 30.0;
        let r = resolve_timeline(&p);
        let s = plan_segments(&p, &r).unwrap();
        let args = segment_args(&p, &s[0], &caps(), &ExportSettings::default(), "o.mkv").unwrap();

        let ss = args.iter().position(|a| a == "-ss").unwrap();
        let i = args.iter().position(|a| a == "-i").unwrap();
        assert!(ss < i, "-ss must precede -i to seek on the input");
        assert_eq!(args[ss + 1], "25");
    }

    #[test]
    fn the_concat_pass_copies_video_and_encodes_audio_once() {
        let p = project_of(3, 5.0, TransitionSpec::default());
        let args = concat_args(&p, &ExportSettings::default(), "list.txt", 13.0);
        let v = args.iter().position(|a| a == "-c:v").unwrap();
        assert_eq!(args[v + 1], "copy");
        let a = args.iter().position(|a| a == "-c:a").unwrap();
        assert_eq!(args[a + 1], "aac");
    }

    #[test]
    fn the_concat_pass_mixes_music_over_the_whole_timeline() {
        let mut p = project_of(3, 5.0, TransitionSpec::default());
        p.music = Some(crate::project::MusicTrack {
            path: "C:\\music.mp3".into(),
            file_name: "music.mp3".into(),
            duration: 200.0,
            volume: 0.18,
            fade_in: 2.0,
            fade_out: 3.0,
            start_offset: 0.0,
            loop_to_fit: false,
        });
        let args = concat_args(&p, &ExportSettings::default(), "list.txt", 13.0);
        let graph = args.iter().find(|a| a.contains("amix")).unwrap();
        assert!(graph.contains("normalize=0"));
        assert!(graph.contains("volume=0.18"));
        // faded out against the true total, not the music length
        assert!(graph.contains("afade=t=out:st=10"));
    }

    #[test]
    fn concat_list_escapes_quotes_in_paths() {
        let list = concat_list(&["C:\\a\\b.mkv".into(), "C:\\it's\\c.mkv".into()]);
        assert_eq!(
            list,
            "file 'C:\\a\\b.mkv'\nfile 'C:\\it'\\''s\\c.mkv'\n"
        );
    }
}
