import { useMemo, useState } from "react";
import { useEditor } from "@/state/projectStore";
import { CURATED_TRANSITIONS } from "@/types/project";

export default function TransitionBar() {
  const project = useEditor((s) => s.project);
  const resolved = useEditor((s) => s.resolved);
  const caps = useEditor((s) => s.caps);
  const applyToAll = useEditor((s) => s.applyTransitionToAll);
  const setEnabled = useEditor((s) => s.setTransitionsEnabled);
  const clearAllOverrides = useEditor((s) => s.clearAllOverrides);
  const showToast = useEditor((s) => s.showToast);

  const [kind, setKind] = useState(project.defaultTransition.kind);
  const [duration, setDuration] = useState(project.defaultTransition.duration);
  const [showAll, setShowAll] = useState(false);

  const boundaryCount = Math.max(0, project.timeline.length - 1);
  const overrideCount = project.transitionOverrides.length;
  const clampedCount = resolved.clampedCount;
  const cutCount = resolved.boundaries.filter((b) => b.demotedToCut).length;

  // The curated list first, then anything else the bundled ffmpeg reports.
  const options = useMemo(() => {
    const all = caps?.transitions ?? [];
    const curated = CURATED_TRANSITIONS.filter((t) => all.length === 0 || all.includes(t));
    if (!showAll) return curated;
    const rest = all.filter((t) => !curated.includes(t as never)).sort();
    return [...curated, ...rest];
  }, [caps, showAll]);

  const disabled = boundaryCount === 0;

  return (
    <div className="flex items-center gap-3 px-3 py-2 border-b border-edge bg-panel shrink-0">
      <span className="text-[11px] uppercase tracking-wide text-neutral-400 shrink-0">
        Transitions
      </span>

      <select
        className="field w-40 text-xs py-1"
        value={kind}
        disabled={disabled}
        onChange={(e) => setKind(e.target.value)}
      >
        {options.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>

      <label className="flex items-center gap-1 text-[11px] text-neutral-500 shrink-0">
        <input
          type="checkbox"
          checked={showAll}
          onChange={(e) => setShowAll(e.target.checked)}
        />
        all {caps?.transitions.length ? `(${caps.transitions.length})` : ""}
      </label>

      <div className="flex items-center gap-2 shrink-0">
        <input
          type="range"
          min={0.2}
          max={3}
          step={0.1}
          value={duration}
          disabled={disabled}
          onChange={(e) => setDuration(Number(e.target.value))}
          className="w-32"
        />
        <span className="text-xs text-neutral-400 tabular-nums w-10">{duration.toFixed(1)}s</span>
      </div>

      <button
        className="btn-primary text-xs shrink-0"
        disabled={disabled}
        onClick={() => {
          applyToAll(kind, duration);
          showToast(
            "info",
            `Applied ${kind} to ${boundaryCount} transition${boundaryCount === 1 ? "" : "s"}.`
          );
        }}
        title={
          overrideCount > 0
            ? `Applies to all ${boundaryCount} boundaries and clears ${overrideCount} custom override${
                overrideCount === 1 ? "" : "s"
              }`
            : `Applies to all ${boundaryCount} boundaries`
        }
      >
        Apply to all
      </button>

      <button
        className="btn text-xs shrink-0"
        disabled={disabled}
        onClick={() => setEnabled(!project.defaultTransition.enabled)}
        title="Switch every boundary between transitions and hard cuts"
      >
        {project.defaultTransition.enabled ? "Use hard cuts" : "Use transitions"}
      </button>

      {overrideCount > 0 && (
        <button
          className="btn text-xs shrink-0"
          onClick={clearAllOverrides}
          title="Remove per-boundary customisations and go back to a single uniform transition"
        >
          Reset {overrideCount} custom
        </button>
      )}

      <div className="flex-1" />

      {/* Clamping is expected with short clips, so it is reported quietly here
          rather than blocking the bulk action with a dialog. */}
      {clampedCount > 0 && (
        <span
          className="text-[11px] text-amber-500 shrink-0"
          title={`${clampedCount} transition${
            clampedCount === 1 ? " was" : "s were"
          } shortened to fit between short clips.${
            cutCount > 0 ? ` ${cutCount} became a hard cut.` : ""
          }`}
        >
          {clampedCount} shortened
          {cutCount > 0 && `, ${cutCount} cut`}
        </span>
      )}
    </div>
  );
}
