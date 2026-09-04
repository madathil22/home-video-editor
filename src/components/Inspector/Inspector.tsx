import { useEditor } from "@/state/projectStore";
import { formatTime } from "@/lib/format";
import ClipInspector from "./ClipInspector";
import TransitionInspector from "./TransitionInspector";
import MusicInspector from "./MusicInspector";
import { Section } from "./fields";

export default function Inspector() {
  const caps = useEditor((s) => s.caps);
  const settings = useEditor((s) => s.project.settings);
  const resolved = useEditor((s) => s.resolved);
  const hasSelection = useEditor(
    (s) => s.selectedClipIds.length > 0 || s.selectedBoundary !== null
  );

  return (
    <div className="h-full overflow-y-auto bg-panel">
      <ClipInspector />
      <TransitionInspector />

      {!hasSelection && (
        <Section title="Nothing selected">
          <p className="text-[11px] text-neutral-600 leading-snug">
            Click a clip to trim it, or click a boundary between two clips to change just that
            transition.
          </p>
        </Section>
      )}

      <MusicInspector />

      <Section title="Project">
        <div className="text-[11px] text-neutral-500 space-y-1">
          <div>
            {settings.width}×{settings.height} · {settings.fps} fps
          </div>
          <div>
            {resolved.clips.length} clips · {formatTime(resolved.totalDuration)}
          </div>
          <div className={caps?.nvencH264 ? "text-emerald-400/80" : "text-amber-400/80"}>
            {caps
              ? caps.nvencH264
                ? "GPU encoding available (NVENC)"
                : "CPU encoding (libx264) — exports will be slower"
              : "Checking encoder…"}
          </div>
          {caps?.nvencError && (
            <div className="text-[10px] text-neutral-600 leading-snug">{caps.nvencError}</div>
          )}
        </div>
      </Section>
    </div>
  );
}
