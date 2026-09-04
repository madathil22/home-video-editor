# Home Video Editor

A small Windows video editor for stitching action-cam clips into a single 4K
YouTube upload. It does six things and nothing else: import, timeline, trim,
transitions, background music, and a GPU-accelerated 4K export.

## The workflow it is built around

```
1. Import all clips     → drop the whole card in at once
2. Trim or delete       → cut clips down, drop the ones that don't make it
3. Apply transitions    → ONE click applies a transition to every boundary
4. Add background music → pick a track, set the level
                        → Export 4K
```

Step 3 is the point. You never place transitions one at a time: pick a
transition and a duration, press **Apply to all**, and every cut gets it. Any
single boundary can then be overridden or turned back into a hard cut.

## How it works

- **Tauri v2** shell — React + TypeScript UI, Rust backend.
- **ffmpeg is the entire media engine**, bundled as a sidecar binary. No native
  decoding code.
- **720p proxies** are generated on import and cached, so scrubbing and preview
  are instant and 4K HEVC never has to play inside the WebView.
- **The project is a JSON document** (`.hveproj`). Nothing is rendered until you
  export.
- **The timeline resolver lives in Rust** and is called over IPC on every edit,
  so the preview and the export filtergraph can never disagree about clip
  positions, clamped transition lengths, or total duration.

### Transitions

Rather than storing a record per boundary, the project holds one
`defaultTransition` plus a sparse list of `transitionOverrides` keyed by the
clip *before* the boundary. "Apply to all" is therefore a single idempotent
field write that survives reordering and deletion without orphaning anything.

Each boundary independently clamps its transition to
`min(clipA, clipB) / 2`, and degrades to a hard cut below 0.2s. A global 1.0s
transition next to a 1.5s clip is silently shortened and visibly marked, rather
than failing.

## Installing

Download the latest `Home Video Editor_<version>_x64-setup.exe` from the
[Releases page](../../releases/latest) and run it. ffmpeg and ffprobe are
bundled, so there is nothing else to install.

To build it yourself, see [Development](#development).

See [CHANGELOG.md](CHANGELOG.md) for what changed between versions.

## Requirements

- Windows 10/11 x64
- Node 18+ and the Rust toolchain (MSVC), plus VS 2022 C++ Build Tools
- An NVIDIA GPU for hardware encoding (optional — falls back to `libx264`)

The ffmpeg and ffprobe sidecars are **not committed** — they are ~138 MB each,
past GitHub's 100 MB file limit. `tools/fetch-ffmpeg.ps1` downloads them into
`src-tauri/binaries/`.

They are **pinned to ffmpeg 8.1.2**. Do not upgrade them without re-running the
NVENC trial encode: ffmpeg 9.0 and master require NVENC API 13.1 (driver
≥ 610.00), and will fail to open `h264_nvenc` on older drivers.

## Development

```powershell
npm install
.\tools\fetch-ffmpeg.ps1   # once, to populate src-tauri\binaries
npm run tauri dev      # run the app
npm run typecheck      # TypeScript
cargo test --manifest-path src-tauri\Cargo.toml
npm run tauri build    # produce an installer
```

Release builds **must** go through `npm run tauri build`; a plain
`cargo build --release` bakes in the localhost dev URL and the app will come up
blank.

### Inspecting a generated export command

`src-tauri/examples/export_args.rs` prints the exact ffmpeg argument vector a
project would export with, so the filtergraph can be validated against the real
binary without launching the app:

```powershell
cd src-tauri
cargo run --example export_args -- ..\path\to\project.hveproj D:\out.mp4 | Set-Content args.txt
.\binaries\ffmpeg-x86_64-pc-windows-msvc.exe @(Get-Content args.txt)
```

The human-readable timeline duration goes to stderr, so redirecting only stdout
keeps `args.txt` clean enough to splat straight back into ffmpeg.

## Export speed

Export renders the timeline as many small ffmpeg jobs and stitches them with
the concat demuxer. This is a **correctness** requirement, not an optimisation:
a single filtergraph over the whole timeline runs out of memory well before a
realistic project. See `src-tauri/src/ffmpeg/segmented.rs`.

Two separate bugs killed the original single-graph exporter, both only visible
at realistic scale:

1. **`could not start ffmpeg: The filename or extension is too long`.** Windows
   caps a command line at 32,767 characters and the filtergraph alone blows
   past it — 28,640 characters at 60 clips, 38,138 at 80. Fixed by writing the
   graph to a file and passing `-/filter_complex <path>`.
2. **`Cannot allocate memory` (-12).** One input per clip with every clip's PTS
   reset to zero makes ffmpeg decode them all concurrently and buffer frames
   for clips whose `xfade` is not ready yet. Confirmed failing at **16 clips at
   4K** and **80 clips at 720p**.

An earlier benchmark here concluded segmented export was not worth building. It
used three clips, never reached either failure, and was wrong.

### Measured on a GTX 1660, 16 clips at 4K30, 65 s of output

| Approach | Wall clock | Peak RAM | Notes |
|---|---|---|---|
| Segmented, one job per segment (current) | 98 s | low | 31 jobs + concat |
| Same, 4 segments batched per ffmpeg process | 98 s | low | no gain at all |
| Same, 8 segments batched per process | — | — | fails with -12 |
| Two segment jobs in parallel | ~75 s | low | 8 segments: 23.7 s → 17.6 s |
| One graph, whole timeline, concat filter | 66 s | 9.2 GB | writes the MP4 directly |
| One graph, one input per clip + `split` | 54 s | 9.5 GB | fewest decodes |
| **Chunked graph, 4 clips per chunk** | **71 s** | **4.3 GB** | 4 jobs + concat |
| Chunked graph, 8 clips per chunk | 67 s | 6.1 GB | 2 jobs + concat |

What this says:

- **Batching several segments into one process is worthless.** The fixed cost
  per segment is the NVENC session, not the process, so sharing a process saves
  nothing — and eight 4K outputs at once runs the GPU out of memory. Tried,
  measured, removed.
- **Memory scales with the number of pieces in a graph**, roughly 300–400 MB per
  piece at 4K. That is why a whole-timeline graph cannot work, and why a graph
  over a handful of clips can.
- **Encoder flags cost more than anything else.** For a 4-second 4K body:
  1.0 s decode, 0.8 s NVENC, and **1.2 s for `-preset p6 -tune hq` plus
  lookahead, spatial/temporal AQ and B-frame refs**. Dropping to `-preset p4`
  is ~40% faster at the same output size.

### Next step (not yet built)

Render each contiguous run of ~4 clips as one graph — bodies and `xfade`
overlaps joined by the `concat` filter into a single NVENC encode — and keep
the existing concat demuxer pass to stitch the chunks and lay the music over
the top. That is ~30% faster than today at bounded memory, and it collapses 31
processes into 4. Prototypes that produced the table above are in
`tools/prototypes/`: `mkconcat.cjs` (whole timeline), `mkconcat2.cjs` (one input
per clip), `mkchunk.cjs` (chunked; the one to port to Rust).

Beyond that: running two chunk jobs concurrently was worth ~27% on segments and
should compose with chunking, and an export speed/quality control could expose
the `p4`/`p6` tradeoff instead of always paying for `p6`.
## Keyboard

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `←` `→` | Step one frame (hold `Shift` for one second) |
| `Home` / `End` | Jump to start / end |
| `Del` | Delete the selected clips and close the gap |
| `Ctrl+A` | Select all clips |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `Ctrl+S` / `Ctrl+Shift+S` | Save / save as |
| `Ctrl+O` | Open a project |
| `Ctrl+E` | Export |
| `Ctrl` + scroll | Zoom the timeline |

## Not in this version

Titles and text, colour grading, speed ramping, multiple video tracks,
keyframed effects, and audio ducking. The architecture leaves room for all of
them.

## Licence

Application code is MIT — see [LICENSE](LICENSE). The bundled ffmpeg and
ffprobe binaries are redistributed under the GPL; see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the exact build and what
that entails.
