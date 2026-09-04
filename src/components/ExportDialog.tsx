import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import * as ipc from "@/lib/ipc";
import { useEditor } from "@/state/projectStore";
import { formatEta, formatTime } from "@/lib/format";
import type {
  ExportDoneEvent,
  ExportPlan,
  ExportProgressEvent,
  ExportSettings,
} from "@/types/project";

const RESOLUTIONS = [
  { label: "4K UHD — 3840×2160", width: 3840, height: 2160, bitrate: 45 },
  { label: "1440p — 2560×1440", width: 2560, height: 1440, bitrate: 24 },
  { label: "1080p — 1920×1080", width: 1920, height: 1080, bitrate: 14 },
];

type Phase = "idle" | "running" | "done" | "error";

export default function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project);
  const resolved = useEditor((s) => s.resolved);
  const caps = useEditor((s) => s.caps);
  const showToast = useEditor((s) => s.showToast);

  const [settings, setSettings] = useState<ExportSettings>(() => ({
    outputPath: "",
    width: project.settings.width,
    height: project.settings.height,
    fps: project.settings.fps,
    codec: "h264",
    quality: 19,
    bitrateMbps: 45,
    audioBitrateKbps: 384,
    useNvdec: false,
  }));

  const [plan, setPlan] = useState<ExportPlan | null>(null);
  const [showCommand, setShowCommand] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<ExportProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finishedPath, setFinishedPath] = useState<string | null>(null);
  const startedAt = useRef<number>(0);

  const patch = (p: Partial<ExportSettings>) => setSettings((s) => ({ ...s, ...p }));

  useEffect(() => {
    const unlisten = [
      listen<ExportProgressEvent>("export:progress", (e) => setProgress(e.payload)),
      listen<ExportDoneEvent>("export:done", (e) => {
        if (e.payload.cancelled) {
          setPhase("idle");
          setProgress(null);
          showToast("info", "Export cancelled.");
        } else {
          setPhase("done");
          setFinishedPath(e.payload.outputPath);
        }
      }),
      listen<{ message: string }>("export:error", (e) => {
        setPhase("error");
        setError(e.payload.message);
      }),
    ];
    return () => {
      void Promise.all(unlisten).then((fns) => fns.forEach((f) => f()));
    };
  }, [showToast]);

  // Keep the command preview honest about the settings currently on screen.
  useEffect(() => {
    let cancelled = false;
    ipc
      .planExport(project, settings)
      .then((p) => {
        if (!cancelled) setPlan(p);
      })
      .catch((e) => {
        if (!cancelled) {
          setPlan(null);
          setError(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project, settings]);

  const chooseOutput = async () => {
    const suggested = `${project.timeline.length ? "home-video" : "video"}.mp4`;
    const path = await save({
      defaultPath: suggested,
      filters: [{ name: "MP4 video", extensions: ["mp4"] }],
    });
    if (path) patch({ outputPath: path });
  };

  const start = async () => {
    if (!settings.outputPath) {
      await chooseOutput();
      return;
    }
    setError(null);
    setProgress(null);
    setPhase("running");
    startedAt.current = Date.now();
    try {
      await ipc.startExport(project, settings);
    } catch (e) {
      setPhase("error");
      setError(String(e));
    }
  };

  const cancel = async () => {
    try {
      await ipc.cancelExport();
    } catch (e) {
      showToast("error", String(e));
    }
  };

  const elapsed = phase === "running" ? (Date.now() - startedAt.current) / 1000 : 0;
  const pct = Math.round((progress?.fraction ?? 0) * 100);

  const blockers = useMemo(() => {
    const list: string[] = [];
    if (resolved.clips.length === 0) list.push("Add at least one clip to the timeline.");
    if (!settings.outputPath) list.push("Choose where to save the file.");
    return list;
  }, [resolved.clips.length, settings.outputPath]);

  const busy = phase === "running";

  return (
    <div className="fixed inset-0 z-50 bg-black/60 grid place-items-center p-6">
      <div className="w-[560px] max-h-full overflow-y-auto bg-panel border border-edge rounded-lg shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
          <h2 className="text-sm text-neutral-100">Export video</h2>
          <button
            className="text-neutral-500 hover:text-neutral-200 text-sm"
            onClick={onClose}
            disabled={busy}
            title={busy ? "Cancel the export first" : "Close"}
          >
            ✕
          </button>
        </div>

        <div className="px-4 py-4 space-y-4">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-neutral-500 mb-1.5">
              Save to
            </div>
            <div className="flex gap-2">
              <input
                readOnly
                value={settings.outputPath}
                placeholder="Choose a location…"
                className="flex-1 bg-panelAlt border border-edge rounded px-2 py-1 text-xs
                           text-neutral-300 truncate"
              />
              <button
                className="px-3 py-1 rounded bg-white/10 hover:bg-white/20 text-xs text-neutral-200
                           disabled:opacity-40"
                onClick={() => void chooseOutput()}
                disabled={busy}
              >
                Browse…
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="text-[11px] text-neutral-500">
              Resolution
              <select
                className="mt-1 w-full bg-panelAlt border border-edge rounded px-2 py-1 text-xs
                           text-neutral-200 disabled:opacity-40"
                value={`${settings.width}x${settings.height}`}
                disabled={busy}
                onChange={(e) => {
                  const r = RESOLUTIONS.find(
                    (x) => `${x.width}x${x.height}` === e.target.value
                  );
                  if (r) patch({ width: r.width, height: r.height, bitrateMbps: r.bitrate });
                }}
              >
                {RESOLUTIONS.map((r) => (
                  <option key={r.label} value={`${r.width}x${r.height}`}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-[11px] text-neutral-500">
              Frame rate
              <select
                className="mt-1 w-full bg-panelAlt border border-edge rounded px-2 py-1 text-xs
                           text-neutral-200 disabled:opacity-40"
                value={settings.fps}
                disabled={busy}
                onChange={(e) => patch({ fps: Number(e.target.value) })}
              >
                {[24, 25, 30, 50, 60].map((f) => (
                  <option key={f} value={f}>
                    {f} fps
                  </option>
                ))}
              </select>
            </label>

            <label className="text-[11px] text-neutral-500">
              Codec
              <select
                className="mt-1 w-full bg-panelAlt border border-edge rounded px-2 py-1 text-xs
                           text-neutral-200 disabled:opacity-40"
                value={settings.codec}
                disabled={busy}
                onChange={(e) => patch({ codec: e.target.value as "h264" | "hevc" })}
              >
                <option value="h264">H.264 — plays everywhere</option>
                <option value="hevc" disabled={caps ? !caps.nvencHevc : false}>
                  HEVC — smaller file
                </option>
              </select>
            </label>

            <label className="text-[11px] text-neutral-500">
              Target bitrate
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="range"
                  min={8}
                  max={80}
                  step={1}
                  value={settings.bitrateMbps}
                  disabled={busy}
                  onChange={(e) => patch({ bitrateMbps: Number(e.target.value) })}
                  className="flex-1"
                />
                <span className="text-xs text-neutral-300 tabular-nums w-14 text-right">
                  {settings.bitrateMbps} Mb/s
                </span>
              </div>
            </label>
          </div>

          <label className="flex items-center gap-2 text-[11px] text-neutral-500">
            <input
              type="checkbox"
              checked={settings.useNvdec}
              disabled={busy}
              onChange={(e) => patch({ useNvdec: e.target.checked })}
              className="accent-accent"
            />
            Decode on the GPU too (faster on some systems, slower on others — try both)
          </label>

          <div className="rounded bg-panelAlt border border-edge px-3 py-2 text-[11px] space-y-1">
            <div className="flex justify-between text-neutral-400">
              <span>Length</span>
              <span className="tabular-nums">{formatTime(resolved.totalDuration)}</span>
            </div>
            <div className="flex justify-between text-neutral-400">
              <span>Encoder</span>
              <span className={plan?.hardware ? "text-emerald-400/90" : "text-amber-400/90"}>
                {plan ? `${plan.encoder}${plan.hardware ? " (GPU)" : " (CPU)"}` : "…"}
              </span>
            </div>
            {plan && (
              <button
                className="text-accent hover:underline"
                onClick={() => setShowCommand((v) => !v)}
              >
                {showCommand ? "Hide" : "Show"} ffmpeg command
              </button>
            )}
            {showCommand && plan && (
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all
                              text-[10px] text-neutral-500 leading-relaxed">
                {plan.commandPreview}
              </pre>
            )}
          </div>

          {phase === "running" && (
            <div className="space-y-1.5">
              <div className="h-2 rounded bg-panelAlt overflow-hidden">
                <div
                  className="h-full bg-accent transition-[width] duration-200"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="flex justify-between text-[11px] text-neutral-500 tabular-nums">
                <span>
                  {pct}% · {formatTime(progress?.outTime ?? 0)} of{" "}
                  {formatTime(resolved.totalDuration)}
                </span>
                <span>
                  {progress?.speed ? `${progress.speed.toFixed(2)}x · ` : ""}
                  {progress?.etaSecs != null
                    ? `${formatEta(progress.etaSecs)} left`
                    : `${formatEta(elapsed)} elapsed`}
                </span>
              </div>
            </div>
          )}

          {phase === "done" && (
            <div className="rounded bg-emerald-900/30 border border-emerald-700/50 px-3 py-2
                            text-xs text-emerald-200 flex items-center justify-between gap-3">
              <span className="truncate">Export finished.</span>
              <button
                className="shrink-0 text-emerald-300 hover:underline"
                onClick={() => finishedPath && void revealItemInDir(finishedPath)}
              >
                Show in Explorer
              </button>
            </div>
          )}

          {phase === "error" && error && (
            <div className="rounded bg-red-950/50 border border-red-800/60 px-3 py-2">
              <div className="text-xs text-red-300 mb-1">Export failed</div>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all text-[10px]
                              text-red-200/80 leading-relaxed">
                {error}
              </pre>
            </div>
          )}

          {phase === "idle" && blockers.length > 0 && (
            <ul className="text-[11px] text-amber-400/90 space-y-0.5">
              {blockers.map((b) => (
                <li key={b}>• {b}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-edge">
          {busy ? (
            <button
              className="px-4 py-1.5 rounded bg-red-900/50 hover:bg-red-900/80 text-xs text-red-200"
              onClick={() => void cancel()}
            >
              Cancel export
            </button>
          ) : (
            <>
              <button
                className="px-4 py-1.5 rounded bg-white/5 hover:bg-white/10 text-xs text-neutral-300"
                onClick={onClose}
              >
                Close
              </button>
              <button
                className="px-4 py-1.5 rounded bg-accent hover:brightness-110 text-xs text-white
                           disabled:opacity-40 disabled:hover:brightness-100"
                onClick={() => void start()}
                disabled={resolved.clips.length === 0}
              >
                {phase === "done" ? "Export again" : "Start export"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
