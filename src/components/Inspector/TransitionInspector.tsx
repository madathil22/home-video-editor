import { useEditor } from "@/state/projectStore";
import { CURATED_TRANSITIONS } from "@/types/project";
import { NumberField, Row, Section, Toggle } from "./fields";

export default function TransitionInspector() {
  const project = useEditor((s) => s.project);
  const resolved = useEditor((s) => s.resolved);
  const caps = useEditor((s) => s.caps);
  const index = useEditor((s) => s.selectedBoundary);
  const setBoundaryOverride = useEditor((s) => s.setBoundaryOverride);
  const clearBoundaryOverride = useEditor((s) => s.clearBoundaryOverride);

  if (index === null) return null;
  const boundary = resolved.boundaries[index];
  if (!boundary) return null;

  const override = project.transitionOverrides.find((o) => o.afterClipId === boundary.afterClipId);
  const def = project.defaultTransition;

  const kind = override?.kind ?? def.kind;
  const duration = override?.duration ?? def.duration;
  const enabled = override?.enabled ?? def.enabled;

  const all = caps?.transitions?.length ? caps.transitions : [...CURATED_TRANSITIONS];
  const options = [
    ...CURATED_TRANSITIONS.filter((t) => all.includes(t)),
    ...all.filter((t) => !CURATED_TRANSITIONS.includes(t as never)).sort(),
  ];

  return (
    <Section
      title={`Boundary ${index + 1}`}
      action={
        override ? (
          <button
            className="text-[11px] text-accent hover:underline"
            onClick={() => clearBoundaryOverride(boundary.afterClipId)}
          >
            Use default
          </button>
        ) : (
          <span className="text-[11px] text-neutral-600">using default</span>
        )
      }
    >
      <Toggle
        checked={!enabled}
        onChange={(v) => setBoundaryOverride(boundary.afterClipId, { enabled: !v })}
        label="Hard cut here"
      />

      {enabled && (
        <>
          <Row label="Transition">
            <select
              className="flex-1 bg-panelAlt border border-edge rounded px-1.5 py-0.5 text-xs
                         text-neutral-200 focus:outline-none focus:border-accent"
              value={kind}
              onChange={(e) => setBoundaryOverride(boundary.afterClipId, { kind: e.target.value })}
            >
              {options.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Row>

          <Row label="Duration">
            <NumberField
              value={duration}
              min={0.2}
              max={4}
              step={0.1}
              suffix="s"
              onChange={(v) => setBoundaryOverride(boundary.afterClipId, { duration: v })}
            />
          </Row>
        </>
      )}

      {boundary.demotedToCut && (
        <p className="text-[11px] text-amber-400/90 leading-snug">
          These clips are too short for a transition, so this boundary exports as a hard cut.
        </p>
      )}
      {boundary.clamped && !boundary.demotedToCut && (
        <p className="text-[11px] text-amber-400/90 leading-snug">
          Shortened to {boundary.transition?.duration.toFixed(2)}s so it fits between these clips.
        </p>
      )}
    </Section>
  );
}
