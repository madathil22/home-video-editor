# Changelog

## 0.2.0

**Export now works on real projects.** 0.1.0 could not export anything past a
handful of clips; both failures are fixed.

### Fixed

- **`could not start ffmpeg: The filename or extension is too long`.** Windows
  caps a command line at 32,767 characters and the filtergraph alone exceeded it
  — 28,640 characters at 60 clips, 38,138 at 80. The graph is now written to a
  file and passed as `-/filter_complex <path>`.
- **`Cannot allocate memory` (-12) partway through an export.** Rendering the
  whole timeline as one filtergraph made ffmpeg decode every clip at once and
  buffer frames for clips whose crossfade was not ready yet, so memory grew with
  the length of the timeline. It failed at **16 clips at 4K** and **80 clips at
  720p** — well short of a normal holiday video.

### Changed

- Export is now **segmented**: the timeline is cut into clip bodies and
  transition overlaps, each rendered by its own short ffmpeg job, then joined
  with the concat demuxer in a single pass that copies the video through
  untouched and lays the background music over the top. No job opens more than
  two clips, so peak memory is flat no matter how long the project is.
- Segments are rendered to Matroska with PCM audio. AAC carries a per-file
  encoder delay that would click at every join.
- Export can be cancelled between jobs, not just during one.
- Clip rotation is honoured when working out display dimensions, so portrait
  footage is no longer letterboxed as if it were landscape.

### Known limitations

- A 15-minute 4K export takes roughly 20–25 minutes on a GTX 1660. The
  measurements and the plan to cut that by ~30% are in the README under
  "Export speed".
- Start/end slides, a visible undo history, and in-app updates are not built yet.
- Tested against synthetic 4K footage; not yet validated against real DJI Action
  cam files (variable frame rate and mixed frame rates are handled in code and
  unit tests only).

## 0.1.0

First release: import, timeline, trimming, transitions, background music, and
GPU-accelerated 4K export.
