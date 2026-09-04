import { invoke } from "@tauri-apps/api/core";
import type {
  AudioInfo,
  CacheStats,
  Capabilities,
  ExportPlan,
  ExportSettings,
  MediaItem,
  Project,
  ProxyResult,
  ResolvedTimeline,
} from "@/types/project";

export const detectCapabilities = () => invoke<Capabilities>("detect_capabilities");

export const probeMedia = (path: string) => invoke<MediaItem>("probe_media", { path });

export const probeMusic = (path: string) => invoke<AudioInfo>("probe_music", { path });

export const generateProxy = (mediaId: string, path: string, duration: number) =>
  invoke<ProxyResult>("generate_proxy", { mediaId, path, duration });

/**
 * Rust owns timeline resolution so the UI and the export filtergraph can never
 * disagree about clip positions, clamped transitions, or total duration.
 */
export const resolveProject = (project: Project) =>
  invoke<ResolvedTimeline>("resolve_project", { project });

export const planExport = (project: Project, settings: ExportSettings) =>
  invoke<ExportPlan>("plan_export", { project, settings });

export const startExport = (project: Project, settings: ExportSettings) =>
  invoke<void>("start_export", { project, settings });

export const cancelExport = () => invoke<void>("cancel_export");

export const saveProjectFile = (path: string, project: Project) =>
  invoke<void>("save_project", { path, project });

export const loadProjectFile = (path: string) => invoke<Project>("load_project", { path });

export const proxyCacheStats = () => invoke<CacheStats>("proxy_cache_stats");

export const clearProxyCache = () => invoke<void>("clear_proxy_cache");

export const missingMedia = (project: Project) => invoke<string[]>("missing_media", { project });
