import { create } from "zustand";
import * as ipc from "@/lib/ipc";
import {
  emptyProject,
  type Capabilities,
  type Clip,
  type MediaItem,
  type MusicTrack,
  type Project,
  type ResolvedTimeline,
} from "@/types/project";

export type ProxyStatus = "pending" | "working" | "done" | "error";

const EMPTY_RESOLVED: ResolvedTimeline = {
  clips: [],
  boundaries: [],
  totalDuration: 0,
  clampedCount: 0,
};

interface EditorState {
  project: Project;
  /** Computed in Rust; the single source of truth for layout and durations. */
  resolved: ResolvedTimeline;
  caps: Capabilities | null;

  selectedClipIds: string[];
  selectedBoundary: number | null;
  /** Media bin selection; transient, never saved. */
  selectedMediaIds: string[];
  /** Active drag from the media bin to the timeline; transient, never saved. */
  mediaDrag: { mediaIds: string[]; x: number; y: number } | null;
  playhead: number;
  isPlaying: boolean;
  /** Timeline zoom, in pixels per second. */
  zoom: number;

  proxyStatus: Record<string, ProxyStatus>;
  projectPath: string | null;
  dirty: boolean;
  busy: string | null;
  toast: { kind: "info" | "error"; message: string } | null;

  past: Project[];
  future: Project[];

  setCaps: (caps: Capabilities) => void;
  setBusy: (busy: string | null) => void;
  showToast: (kind: "info" | "error", message: string) => void;
  dismissToast: () => void;

  commit: (next: Project, options?: { silent?: boolean }) => void;
  /** Snapshot the current project so a drag gesture becomes one undo step. */
  pushHistory: () => void;
  refreshResolved: () => Promise<void>;
  undo: () => void;
  redo: () => void;

  addMedia: (items: MediaItem[]) => void;
  setProxy: (mediaId: string, proxyPath: string, thumbnailPath: string) => void;
  setProxyStatus: (mediaId: string, status: ProxyStatus) => void;
  removeMedia: (mediaId: string) => void;

  addToTimeline: (mediaIds: string[], atIndex?: number) => void;
  deleteSelectedClips: () => void;
  moveClip: (clipId: string, toIndex: number) => void;
  trimClip: (clipId: string, inPoint: number, outPoint: number, silent?: boolean) => void;
  toggleClipMute: (clipId: string) => void;

  selectClip: (clipId: string, additive: boolean) => void;
  selectAllClips: () => void;
  clearSelection: () => void;
  selectBoundary: (index: number | null) => void;

  selectMedia: (id: string, mode: "single" | "toggle" | "range") => void;
  clearMediaSelection: () => void;
  beginMediaDrag: (mediaIds: string[], x: number, y: number) => void;
  updateMediaDrag: (x: number, y: number) => void;
  endMediaDrag: () => void;
  applyTransitionToAll: (kind: string, duration: number) => void;
  setTransitionsEnabled: (enabled: boolean) => void;
  setBoundaryOverride: (
    afterClipId: string,
    patch: { kind?: string | null; duration?: number | null; enabled?: boolean | null }
  ) => void;
  clearBoundaryOverride: (afterClipId: string) => void;
  clearAllOverrides: () => void;

  setMusic: (music: MusicTrack | null) => void;
  updateMusic: (patch: Partial<MusicTrack>) => void;

  setPlayhead: (t: number) => void;
  setPlaying: (playing: boolean) => void;
  setZoom: (zoom: number) => void;

  loadProject: (project: Project, path: string | null) => void;
  markSaved: (path: string) => void;
}

/**
 * Resolution happens in Rust. Requests are tagged so a slower earlier response
 * can never overwrite a newer one during rapid edits like trim dragging.
 */
let resolveToken = 0;

export const useEditor = create<EditorState>((set, get) => ({
  project: emptyProject(),
  resolved: EMPTY_RESOLVED,
  caps: null,

  selectedClipIds: [],
  selectedBoundary: null,
  selectedMediaIds: [],
  mediaDrag: null,
  playhead: 0,
  isPlaying: false,
  zoom: 40,

  proxyStatus: {},
  projectPath: null,
  dirty: false,
  busy: null,
  toast: null,

  past: [],
  future: [],

  setCaps: (caps) => set({ caps }),
  setBusy: (busy) => set({ busy }),
  showToast: (kind, message) => set({ toast: { kind, message } }),
  dismissToast: () => set({ toast: null }),

  commit: (next, options) => {
    const { project, past } = get();
    set({
      project: next,
      past: options?.silent ? past : [...past.slice(-49), project],
      future: options?.silent ? get().future : [],
      dirty: true,
    });
    void get().refreshResolved();
  },

  pushHistory: () => {
    const { project, past } = get();
    set({ past: [...past.slice(-49), project], future: [] });
  },

  refreshResolved: async () => {
    const token = ++resolveToken;
    const project = get().project;
    try {
      const resolved = await ipc.resolveProject(project);
      if (token === resolveToken) set({ resolved });
    } catch (e) {
      if (token === resolveToken) {
        set({ toast: { kind: "error", message: String(e) } });
      }
    }
  },

  undo: () => {
    const { past, project, future } = get();
    if (past.length === 0) return;
    const previous = past[past.length - 1];
    set({
      project: previous,
      past: past.slice(0, -1),
      future: [project, ...future].slice(0, 50),
      dirty: true,
    });
    void get().refreshResolved();
  },

  redo: () => {
    const { future, project, past } = get();
    if (future.length === 0) return;
    const next = future[0];
    set({
      project: next,
      future: future.slice(1),
      past: [...past, project],
      dirty: true,
    });
    void get().refreshResolved();
  },

  addMedia: (items) => {
    const { project } = get();
    // Dedupe by path so re-dropping the same folder is harmless.
    const existing = new Set(project.media.map((m) => m.path.toLowerCase()));
    const fresh = items.filter((m) => !existing.has(m.path.toLowerCase()));
    if (fresh.length === 0) return;

    const media = [...project.media, ...fresh].sort(sortByShootingOrder);

    // The first import defines the project format, the way an NLE adopts the
    // settings of the first clip you drop in.
    const settings =
      project.media.length === 0
        ? {
            width: fresh[0].width || project.settings.width,
            height: fresh[0].height || project.settings.height,
            fps: pickProjectFps(fresh[0].fps, project.settings.fps),
          }
        : project.settings;

    get().commit({ ...project, media, settings });

    set((s) => ({
      proxyStatus: {
        ...s.proxyStatus,
        ...Object.fromEntries(fresh.map((m) => [m.id, "pending" as ProxyStatus])),
      },
    }));
  },

  setProxy: (mediaId, proxyPath, thumbnailPath) => {
    const { project } = get();
    const media = project.media.map((m) =>
      m.id === mediaId ? { ...m, proxyPath, thumbnailPath } : m
    );
    // Proxy paths are derived cache data, not an editing action, so they must
    // not create an undo step.
    set({ project: { ...project, media } });
  },

  setProxyStatus: (mediaId, status) =>
    set((s) => ({ proxyStatus: { ...s.proxyStatus, [mediaId]: status } })),

  removeMedia: (mediaId) => {
    const { project } = get();
    const timeline = project.timeline.filter((c) => c.mediaId !== mediaId);
    get().commit({
      ...project,
      media: project.media.filter((m) => m.id !== mediaId),
      timeline,
      transitionOverrides: pruneOverrides(project.transitionOverrides, timeline),
    });
    set((s) => ({ selectedMediaIds: s.selectedMediaIds.filter((id) => id !== mediaId) }));
  },

  addToTimeline: (mediaIds, atIndex) => {
    const { project } = get();
    const additions: Clip[] = [];
    for (const id of mediaIds) {
      const media = project.media.find((m) => m.id === id);
      if (!media) continue;
      additions.push({
        id: crypto.randomUUID(),
        mediaId: media.id,
        inPoint: 0,
        outPoint: media.duration,
        muted: false,
      });
    }
    if (additions.length === 0) return;
    const at =
      atIndex === undefined
        ? project.timeline.length
        : Math.max(0, Math.min(project.timeline.length, atIndex));
    const timeline = [...project.timeline];
    timeline.splice(at, 0, ...additions);
    get().commit({ ...project, timeline });
  },

  deleteSelectedClips: () => {
    const { project, selectedClipIds } = get();
    if (selectedClipIds.length === 0) return;
    const remove = new Set(selectedClipIds);
    const timeline = project.timeline.filter((c) => !remove.has(c.id));
    get().commit({
      ...project,
      timeline,
      // Overrides are keyed by the clip before the boundary, so deleting a clip
      // must drop its override or it would silently apply to a new neighbour.
      transitionOverrides: pruneOverrides(project.transitionOverrides, timeline),
    });
    set({ selectedClipIds: [], selectedBoundary: null });
  },

  moveClip: (clipId, toIndex) => {
    const { project } = get();
    const from = project.timeline.findIndex((c) => c.id === clipId);
    if (from < 0) return;
    const target = Math.max(0, Math.min(project.timeline.length - 1, toIndex));
    if (from === target) return;
    const timeline = [...project.timeline];
    const [moved] = timeline.splice(from, 1);
    timeline.splice(target, 0, moved);
    get().commit({ ...project, timeline });
  },

  trimClip: (clipId, inPoint, outPoint, silent) => {
    const { project } = get();
    const clip = project.timeline.find((c) => c.id === clipId);
    if (!clip) return;
    const media = project.media.find((m) => m.id === clip.mediaId);
    if (!media) return;

    // A clip must stay inside its source and keep at least a few frames.
    const minLength = 0.1;
    const lo = Math.max(0, Math.min(inPoint, media.duration - minLength));
    const hi = Math.min(media.duration, Math.max(outPoint, lo + minLength));

    const timeline = project.timeline.map((c) =>
      c.id === clipId ? { ...c, inPoint: lo, outPoint: hi } : c
    );
    get().commit({ ...project, timeline }, { silent });
  },

  toggleClipMute: (clipId) => {
    const { project } = get();
    const timeline = project.timeline.map((c) =>
      c.id === clipId ? { ...c, muted: !c.muted } : c
    );
    get().commit({ ...project, timeline });
  },

  selectClip: (clipId, additive) =>
    set((s) => ({
      selectedClipIds: additive
        ? s.selectedClipIds.includes(clipId)
          ? s.selectedClipIds.filter((id) => id !== clipId)
          : [...s.selectedClipIds, clipId]
        : [clipId],
      selectedBoundary: null,
    })),

  selectAllClips: () => set((s) => ({ selectedClipIds: s.project.timeline.map((c) => c.id) })),
  clearSelection: () => set({ selectedClipIds: [], selectedBoundary: null }),
  selectBoundary: (index) => set({ selectedBoundary: index, selectedClipIds: [] }),

  selectMedia: (id, mode) =>
    set((s) => {
      if (mode === "toggle") {
        return {
          selectedMediaIds: s.selectedMediaIds.includes(id)
            ? s.selectedMediaIds.filter((x) => x !== id)
            : [...s.selectedMediaIds, id],
        };
      }
      if (mode === "range" && s.selectedMediaIds.length > 0) {
        const order = s.project.media.map((m) => m.id);
        const a = order.indexOf(s.selectedMediaIds[s.selectedMediaIds.length - 1]);
        const b = order.indexOf(id);
        if (a >= 0 && b >= 0) {
          return { selectedMediaIds: order.slice(Math.min(a, b), Math.max(a, b) + 1) };
        }
      }
      return { selectedMediaIds: [id] };
    }),
  clearMediaSelection: () => set({ selectedMediaIds: [] }),

  beginMediaDrag: (mediaIds, x, y) => set({ mediaDrag: { mediaIds, x, y } }),
  updateMediaDrag: (x, y) =>
    set((s) => (s.mediaDrag ? { mediaDrag: { ...s.mediaDrag, x, y } } : {})),
  endMediaDrag: () => set({ mediaDrag: null }),

  /** The headline action: one transition across every boundary at once. */
  applyTransitionToAll: (kind, duration) => {
    const { project } = get();
    get().commit({
      ...project,
      defaultTransition: { kind, duration, enabled: true },
      // Applying to all means all -- stale per-boundary overrides would make
      // the result look like the button half-worked.
      transitionOverrides: [],
    });
  },

  setTransitionsEnabled: (enabled) => {
    const { project } = get();
    get().commit({
      ...project,
      defaultTransition: { ...project.defaultTransition, enabled },
    });
  },

  setBoundaryOverride: (afterClipId, patch) => {
    const { project } = get();
    const existing = project.transitionOverrides.find((o) => o.afterClipId === afterClipId);
    const merged = {
      afterClipId,
      kind: patch.kind !== undefined ? patch.kind : existing?.kind ?? null,
      duration: patch.duration !== undefined ? patch.duration : existing?.duration ?? null,
      enabled: patch.enabled !== undefined ? patch.enabled : existing?.enabled ?? null,
    };
    const transitionOverrides = existing
      ? project.transitionOverrides.map((o) => (o.afterClipId === afterClipId ? merged : o))
      : [...project.transitionOverrides, merged];
    get().commit({ ...project, transitionOverrides });
  },

  clearBoundaryOverride: (afterClipId) => {
    const { project } = get();
    get().commit({
      ...project,
      transitionOverrides: project.transitionOverrides.filter(
        (o) => o.afterClipId !== afterClipId
      ),
    });
  },

  clearAllOverrides: () => {
    const { project } = get();
    get().commit({ ...project, transitionOverrides: [] });
  },

  setMusic: (music) => {
    const { project } = get();
    get().commit({ ...project, music });
  },

  updateMusic: (patch) => {
    const { project } = get();
    if (!project.music) return;
    get().commit({ ...project, music: { ...project.music, ...patch } });
  },

  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (isPlaying) => set({ isPlaying }),
  setZoom: (zoom) => set({ zoom: Math.max(4, Math.min(400, zoom)) }),

  loadProject: (project, path) => {
    set({
      project,
      projectPath: path,
      dirty: false,
      past: [],
      future: [],
      selectedClipIds: [],
      selectedBoundary: null,
      selectedMediaIds: [],
      mediaDrag: null,
      playhead: 0,
      proxyStatus: Object.fromEntries(
        project.media.map((m) => [m.id, m.proxyPath ? "done" : "pending"])
      ) as Record<string, ProxyStatus>,
    });
    void get().refreshResolved();
  },

  markSaved: (path) => set({ projectPath: path, dirty: false }),
}));

/**
 * Action cams name files sequentially per session but reset across cards, so
 * recording time is the reliable ordering. Fall back to filename when a clip
 * carries no timestamp.
 */
function sortByShootingOrder(a: MediaItem, b: MediaItem): number {
  if (a.creationTime && b.creationTime) {
    const cmp = a.creationTime.localeCompare(b.creationTime);
    if (cmp !== 0) return cmp;
  } else if (a.creationTime) {
    return -1;
  } else if (b.creationTime) {
    return 1;
  }
  return a.fileName.localeCompare(b.fileName, undefined, { numeric: true });
}

function pruneOverrides<T extends { afterClipId: string }>(overrides: T[], timeline: Clip[]): T[] {
  const live = new Set(timeline.map((c) => c.id));
  return overrides.filter((o) => live.has(o.afterClipId));
}

/** Snap a probed frame rate to the nearest sane delivery rate. */
function pickProjectFps(sourceFps: number, fallback: number): number {
  if (!Number.isFinite(sourceFps) || sourceFps <= 0) return fallback;
  const common = [24, 25, 30, 50, 60, 120];
  return common.reduce((best, c) =>
    Math.abs(c - sourceFps) < Math.abs(best - sourceFps) ? c : best
  );
}
