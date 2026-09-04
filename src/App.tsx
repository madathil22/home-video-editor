import { useCallback, useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import * as ipc from "@/lib/ipc";
import { useEditor } from "@/state/projectStore";
import { buildProxies, importPaths, isAudioFile } from "@/lib/import";
import MediaBin from "@/components/MediaBin";
import TransitionBar from "@/components/TransitionBar";
import Timeline from "@/components/Timeline/Timeline";
import PreviewPlayer from "@/components/Preview/PreviewPlayer";
import Inspector from "@/components/Inspector/Inspector";
import ExportDialog from "@/components/ExportDialog";

export default function App() {
  const store = useEditor;
  const dirty = useEditor((s) => s.dirty);
  const busy = useEditor((s) => s.busy);
  const toast = useEditor((s) => s.toast);
  const projectPath = useEditor((s) => s.projectPath);
  const dismissToast = useEditor((s) => s.dismissToast);
  const [dropping, setDropping] = useState(false);
  const [showExport, setShowExport] = useState(false);

  // --- startup -------------------------------------------------------------
  useEffect(() => {
    void store.getState().refreshResolved();
    ipc
      .detectCapabilities()
      .then((caps) => {
        store.getState().setCaps(caps);
        if (!caps.nvencH264 && caps.nvencError) {
          store
            .getState()
            .showToast("info", "GPU encoding is unavailable — exports will use the CPU.");
        }
      })
      .catch((e) =>
        store.getState().showToast("error", `Could not start the media engine: ${e}`)
      );
  }, [store]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(dismissToast, 6000);
    return () => clearTimeout(id);
  }, [toast, dismissToast]);

  // --- project persistence -------------------------------------------------
  const saveProject = useCallback(
    async (forcePrompt: boolean) => {
      const s = store.getState();
      let path = s.projectPath;
      if (!path || forcePrompt) {
        path = await save({
          defaultPath: path ?? "home-video.hveproj",
          filters: [{ name: "Home Video project", extensions: ["hveproj"] }],
        });
      }
      if (!path) return;
      try {
        await ipc.saveProjectFile(path, s.project);
        store.getState().markSaved(path);
        store.getState().showToast("info", "Project saved.");
      } catch (e) {
        store.getState().showToast("error", `Could not save: ${e}`);
      }
    },
    [store]
  );

  const openProject = useCallback(async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: "Home Video project", extensions: ["hveproj"] }],
    });
    if (typeof path !== "string") return;
    try {
      const project = await ipc.loadProjectFile(path);
      store.getState().loadProject(project, path);

      const missing = await ipc.missingMedia(project);
      if (missing.length > 0) {
        store
          .getState()
          .showToast("error", `${missing.length} source file(s) could not be found.`);
      }
      // Cached proxies make this instant; anything missing gets rebuilt.
      void buildProxies(project.media);
    } catch (e) {
      store.getState().showToast("error", `Could not open that project: ${e}`);
    }
  }, [store]);

  // --- drag and drop -------------------------------------------------------
  useEffect(() => {
    const promise = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over") {
        setDropping(true);
      } else if (event.payload.type === "drop") {
        setDropping(false);
        const paths = event.payload.paths ?? [];
        const audio = paths.filter((p) => isAudioFile(p));
        const rest = paths.filter((p) => !isAudioFile(p));
        if (rest.length > 0) void importPaths(rest);
        if (audio.length > 0 && rest.length === 0) {
          void ipc
            .probeMusic(audio[0])
            .then((info) =>
              store.getState().setMusic({
                path: info.path,
                fileName: info.fileName,
                duration: info.duration,
                volume: 0.18,
                fadeIn: 2,
                fadeOut: 3,
                startOffset: 0,
                loopToFit: false,
              })
            )
            .catch((e) => store.getState().showToast("error", String(e)));
        }
      } else {
        setDropping(false);
      }
    });
    return () => {
      void promise.then((unlisten) => unlisten());
    };
  }, [store]);

  // --- keyboard ------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Never steal keys from a field the user is typing into.
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }

      const s = store.getState();
      const frame = 1 / Math.max(1, s.project.settings.fps);
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveProject(e.shiftKey);
        return;
      }
      if (ctrl && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openProject();
        return;
      }
      if (ctrl && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setShowExport(true);
        return;
      }
      if (ctrl && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? s.redo() : s.undo();
        return;
      }
      if (ctrl && e.key.toLowerCase() === "y") {
        e.preventDefault();
        s.redo();
        return;
      }
      if (ctrl && e.key.toLowerCase() === "a") {
        e.preventDefault();
        s.selectAllClips();
        return;
      }

      switch (e.key) {
        case " ":
          e.preventDefault();
          s.setPlaying(!s.isPlaying);
          break;
        case "Delete":
        case "Backspace":
          if (s.selectedClipIds.length > 0) {
            e.preventDefault();
            s.deleteSelectedClips();
          }
          break;
        case "ArrowLeft":
          e.preventDefault();
          s.setPlayhead(s.playhead - (e.shiftKey ? 1 : frame));
          break;
        case "ArrowRight":
          e.preventDefault();
          s.setPlayhead(
            Math.min(s.resolved.totalDuration, s.playhead + (e.shiftKey ? 1 : frame))
          );
          break;
        case "Home":
          e.preventDefault();
          s.setPlayhead(0);
          break;
        case "End":
          e.preventDefault();
          s.setPlayhead(s.resolved.totalDuration);
          break;
        case "Escape":
          s.clearSelection();
          break;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store, saveProject, openProject]);

  const fileName = projectPath?.split(/[\\/]/).pop() ?? "Untitled project";

  return (
    <div className="h-screen flex flex-col bg-[#0c0e11] text-neutral-200 select-none">
      <header className="shrink-0 h-11 px-3 flex items-center gap-3 border-b border-edge bg-panel">
        <span className="text-sm font-medium text-neutral-100">Home Video Editor</span>
        <span className="text-xs text-neutral-500 truncate max-w-[240px]" title={projectPath ?? ""}>
          {fileName}
          {dirty && <span className="text-neutral-600"> •</span>}
        </span>

        <div className="flex-1" />

        {busy && <span className="text-xs text-neutral-400 animate-pulse">{busy}</span>}

        <button
          className="px-2.5 py-1 rounded text-xs text-neutral-300 hover:bg-white/10"
          onClick={() => void openProject()}
        >
          Open
        </button>
        <button
          className="px-2.5 py-1 rounded text-xs text-neutral-300 hover:bg-white/10"
          onClick={() => void saveProject(false)}
        >
          Save
        </button>
        <button
          className="px-3 py-1 rounded bg-accent hover:brightness-110 text-xs text-white"
          onClick={() => setShowExport(true)}
        >
          Export
        </button>
      </header>

      <div className="flex-1 flex min-h-0">
        <div className="w-60 shrink-0 border-r border-edge">
          <MediaBin />
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 min-h-0">
            <PreviewPlayer />
          </div>
          <TransitionBar />
          <div className="h-[248px] shrink-0 border-t border-edge">
            <Timeline />
          </div>
        </div>

        <div className="w-72 shrink-0 border-l border-edge">
          <Inspector />
        </div>
      </div>

      {dropping && (
        <div className="fixed inset-0 z-40 pointer-events-none border-4 border-accent
                        bg-accent/10 grid place-items-center">
          <span className="px-4 py-2 rounded bg-panel text-sm text-neutral-100 shadow-lg">
            Drop clips to import
          </span>
        </div>
      )}

      {toast && (
        <div
          className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded shadow-lg
                      text-xs cursor-pointer ${
                        toast.kind === "error"
                          ? "bg-red-950 border border-red-800 text-red-200"
                          : "bg-panel border border-edge text-neutral-200"
                      }`}
          onClick={dismissToast}
        >
          {toast.message}
        </div>
      )}

      {showExport && <ExportDialog onClose={() => setShowExport(false)} />}
    </div>
  );
}
