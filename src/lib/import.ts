import { open } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";
import * as ipc from "@/lib/ipc";
import { useEditor } from "@/state/projectStore";
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS, type MediaItem } from "@/types/project";

const isVideo = (name: string) =>
  VIDEO_EXTENSIONS.includes(name.split(".").pop()?.toLowerCase() ?? "");

export const isAudioFile = (name: string) =>
  AUDIO_EXTENSIONS.includes(name.split(".").pop()?.toLowerCase() ?? "");

export async function pickVideoFiles(): Promise<string[]> {
  const selected = await open({
    multiple: true,
    filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
  });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

/** Pick a folder and return every video file directly inside it. */
export async function pickVideoFolder(): Promise<string[]> {
  const dir = await open({ directory: true, multiple: false });
  if (!dir || Array.isArray(dir)) return [];
  const entries = await readDir(dir);
  const sep = dir.endsWith("\\") || dir.endsWith("/") ? "" : "\\";
  return entries
    .filter((e) => e.isFile && isVideo(e.name))
    .map((e) => `${dir}${sep}${e.name}`);
}

export async function pickAudioFile(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
  });
  return typeof selected === "string" ? selected : null;
}

/**
 * Probe every path, add what worked to the media bin, and report what did not.
 * One unreadable file must never abort a whole-card import.
 */
export async function importPaths(paths: string[]): Promise<void> {
  const store = useEditor.getState();
  const videoPaths = paths.filter((p) => isVideo(p));
  if (videoPaths.length === 0) {
    if (paths.length > 0) store.showToast("error", "No supported video files in that selection.");
    return;
  }

  store.setBusy(`Reading ${videoPaths.length} file${videoPaths.length === 1 ? "" : "s"}…`);

  const good: MediaItem[] = [];
  const bad: string[] = [];

  const results = await Promise.allSettled(videoPaths.map((p) => ipc.probeMedia(p)));
  results.forEach((r, i) => {
    if (r.status === "fulfilled") good.push(r.value);
    else bad.push(videoPaths[i].split(/[\\/]/).pop() ?? videoPaths[i]);
  });

  store.setBusy(null);

  if (good.length > 0) {
    useEditor.getState().addMedia(good);
    void buildProxies(good);
  }

  if (bad.length > 0) {
    const list = bad.slice(0, 3).join(", ");
    const more = bad.length > 3 ? ` and ${bad.length - 3} more` : "";
    useEditor.getState().showToast("error", `Could not read ${list}${more}.`);
  }
}

/**
 * Kick off proxy generation. Rust bounds the real concurrency with a semaphore,
 * so firing all of these at once is safe and keeps the queue saturated.
 */
export async function buildProxies(items: MediaItem[]): Promise<void> {
  const store = useEditor.getState();

  await Promise.allSettled(
    items.map(async (m) => {
      // A project reloaded from disk may already have valid cached artifacts.
      if (m.proxyPath && m.thumbnailPath) {
        useEditor.getState().setProxyStatus(m.id, "done");
        return;
      }
      useEditor.getState().setProxyStatus(m.id, "working");
      try {
        const res = await ipc.generateProxy(m.id, m.path, m.duration);
        useEditor.getState().setProxy(res.mediaId, res.proxyPath, res.thumbnailPath);
        useEditor.getState().setProxyStatus(m.id, "done");
      } catch (e) {
        useEditor.getState().setProxyStatus(m.id, "error");
        console.error("proxy failed", m.fileName, e);
      }
    })
  );

  const failed = Object.entries(useEditor.getState().proxyStatus).filter(
    ([, v]) => v === "error"
  ).length;
  if (failed > 0) {
    store.showToast("error", `${failed} clip${failed === 1 ? "" : "s"} could not be prepared.`);
  }
}
