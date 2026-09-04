//! Dev tool: print the ffmpeg commands a project would export with.
//!
//! Two modes:
//!
//! ```text
//! # the segmented plan the app actually runs
//! cargo run --example export_args -- project.json out.mp4 --segments <workdir>
//!
//! # the legacy single-graph command, for inspecting one whole filtergraph
//! cargo run --example export_args -- project.json out.mp4 [--script graph.txt]
//! ```
//!
//! Each argument is printed on its own line so a shell can feed them straight
//! back to ffmpeg without re-quoting the filtergraph.

use hve_lib::ffmpeg::caps::Capabilities;
use hve_lib::ffmpeg::filtergraph::{build_export_args, ExportSettings};
use hve_lib::ffmpeg::segmented::{concat_args, concat_list, plan_segments, segment_args};
use hve_lib::project::{resolve_timeline, Project};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let project_path = args
        .first()
        .expect("usage: export_args <project.json> <out.mp4>");
    let output = args.get(1).cloned().unwrap_or_else(|| "out.mp4".into());
    let cpu = args.iter().any(|a| a == "--cpu");
    let hevc = args.iter().any(|a| a == "--hevc");

    let json = std::fs::read_to_string(project_path).expect("could not read the project file");
    let project: Project = serde_json::from_str(&json).expect("project file is not valid JSON");

    let caps = Capabilities {
        ffmpeg_version: "dev".into(),
        nvenc_h264: !cpu,
        nvenc_hevc: !cpu,
        b_ref_mode: !cpu,
        nvenc_error: None,
        transitions: vec![],
    };

    let settings = ExportSettings {
        output_path: output,
        width: project.settings.width,
        height: project.settings.height,
        fps: project.settings.fps,
        codec: if hevc { "hevc".into() } else { "h264".into() },
        ..Default::default()
    };

    let resolved = resolve_timeline(&project);

    // Segmented mode: write one `.args` file per segment plus the concat pass,
    // so a shell can run the whole plan in order.
    if let Some(i) = args.iter().position(|a| a == "--segments") {
        let dir = args.get(i + 1).expect("--segments needs a directory");
        std::fs::create_dir_all(dir).expect("could not create the working directory");

        let segments = plan_segments(&project, &resolved).expect("could not plan the export");
        let mut paths = Vec::new();

        for (n, segment) in segments.iter().enumerate() {
            let seg_path = format!("{dir}\\seg{n:05}.mkv");
            let a = segment_args(&project, segment, &caps, &settings, &seg_path)
                .expect("could not build a segment");
            std::fs::write(format!("{dir}\\seg{n:05}.args"), a.join("\n"))
                .expect("could not write the segment args");
            paths.push(seg_path);
        }

        let list_path = format!("{dir}\\segments.txt");
        std::fs::write(&list_path, concat_list(&paths)).expect("could not write the list");

        let c = concat_args(&project, &settings, &list_path, resolved.total_duration);
        std::fs::write(format!("{dir}\\concat.args"), c.join("\n"))
            .expect("could not write the concat args");

        eprintln!(
            "total duration: {:.3}s, {} segments",
            resolved.total_duration,
            segments.len()
        );
        println!("{}", segments.len());
        return;
    }

    let mut built = build_export_args(&project, &resolved, &caps, &settings)
        .expect("could not build the export command");

    // `--script <path>` moves the filtergraph into a file, the way the app used
    // to before the export was split into segments.
    if let Some(i) = args.iter().position(|a| a == "--script") {
        let path = args.get(i + 1).expect("--script needs a path");
        let graph = built
            .use_filter_script(path)
            .expect("the graph must be extractable");
        std::fs::write(path, graph).expect("could not write the filtergraph");
    }

    eprintln!("total duration: {:.3}s", built.total_duration);
    for arg in built.args {
        println!("{arg}");
    }
}
