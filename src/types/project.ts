// Mirrors the serde structs in src-tauri/src/project.rs. The Rust side is
// annotated `#[serde(rename_all = "camelCase")]`, so field names match exactly.

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
}

export interface MediaItem {
  id: string;
  path: string;
  fileName: string;
  proxyPath: string | null;
  thumbnailPath: string | null;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  rotation: number;
  videoCodec: string;
  creationTime: string | null;
}

export interface Clip {
  id: string;
  mediaId: string;
  inPoint: number;
  outPoint: number;
  muted: boolean;
}

/** The transition applied to every boundary by "Apply to all". */
export interface TransitionSpec {
  kind: string;
  duration: number;
  enabled: boolean;
}

/** Sparse deviation at a single boundary, keyed by the clip before it. */
export interface TransitionOverride {
  afterClipId: string;
  kind: string | null;
  duration: number | null;
  enabled: boolean | null;
}

export interface MusicTrack {
  path: string;
  fileName: string;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  startOffset: number;
  duration: number;
  loopToFit: boolean;
}

export interface Project {
  version: number;
  settings: ProjectSettings;
  media: MediaItem[];
  timeline: Clip[];
  defaultTransition: TransitionSpec;
  transitionOverrides: TransitionOverride[];
  music: MusicTrack | null;
}

// --- resolver output (computed in Rust, cached in the store) ---------------

export interface ResolvedTransition {
  kind: string;
  duration: number;
}

export interface ResolvedBoundary {
  index: number;
  afterClipId: string;
  /** null means a hard cut. */
  transition: ResolvedTransition | null;
  requestedDuration: number;
  clamped: boolean;
  demotedToCut: boolean;
}

export interface ResolvedClip {
  clipId: string;
  mediaId: string;
  start: number;
  end: number;
  duration: number;
}

export interface ResolvedTimeline {
  clips: ResolvedClip[];
  boundaries: ResolvedBoundary[];
  totalDuration: number;
  clampedCount: number;
}

// --- capabilities & export -------------------------------------------------

export interface Capabilities {
  ffmpegVersion: string;
  nvencH264: boolean;
  nvencHevc: boolean;
  bRefMode: boolean;
  nvencError: string | null;
  transitions: string[];
}

export interface ExportSettings {
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  codec: "h264" | "hevc";
  quality: number;
  bitrateMbps: number;
  audioBitrateKbps: number;
  useNvdec: boolean;
}

export interface ExportPlan {
  totalDuration: number;
  encoder: string;
  hardware: boolean;
  commandPreview: string;
}

export interface ExportProgressEvent {
  fraction: number;
  outTime: number;
  totalDuration: number;
  speed: number;
  fps: number;
  etaSecs: number | null;
}

export interface ExportDoneEvent {
  outputPath: string;
  cancelled: boolean;
}

export interface ProxyResult {
  mediaId: string;
  proxyPath: string;
  thumbnailPath: string;
}

export interface AudioInfo {
  path: string;
  fileName: string;
  duration: number;
}

export interface CacheStats {
  fileCount: number;
  bytes: number;
}

export const emptyProject = (): Project => ({
  version: 1,
  settings: { width: 3840, height: 2160, fps: 30 },
  media: [],
  timeline: [],
  defaultTransition: { kind: "fade", duration: 1.0, enabled: true },
  transitionOverrides: [],
  music: null,
});

/**
 * Transitions surfaced first in the picker. The full runtime-enumerated list
 * from ffmpeg sits behind "more" -- these are the ones that actually suit
 * home video, in the order most people reach for them.
 */
export const CURATED_TRANSITIONS = [
  "fade",
  "fadeblack",
  "dissolve",
  "wipeleft",
  "wiperight",
  "slideleft",
  "slideright",
  "circleopen",
  "smoothleft",
  "smoothright",
] as const;

export const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "avi", "m4v", "mts", "m2ts", "webm"];
export const AUDIO_EXTENSIONS = ["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus"];
