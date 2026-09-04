import type { ResolvedBoundary, ResolvedClip } from "@/types/project";

/**
 * Drawn over the region where two clips genuinely overlap on the output
 * timeline, so the picture matches what the export actually renders. Boundaries
 * that resolved to a hard cut get a thin seam marker instead.
 */
export default function TransitionMarker({
  boundary,
  next,
  zoom,
  selected,
  onSelect,
}: {
  boundary: ResolvedBoundary;
  next: ResolvedClip;
  zoom: number;
  selected: boolean;
  onSelect: () => void;
}) {
  if (!boundary.transition) {
    return (
      <div
        className={`absolute top-0 h-full w-1 -ml-0.5 cursor-pointer z-30 ${
          selected ? "bg-accent" : "bg-neutral-600 hover:bg-neutral-400"
        }`}
        style={{ left: next.start * zoom }}
        onMouseDown={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        title={
          boundary.demotedToCut
            ? "Hard cut - these clips are too short for a transition"
            : "Hard cut - click to add a transition here"
        }
      />
    );
  }

  const width = Math.max(4, boundary.transition.duration * zoom);
  const narrow = width < 54;

  return (
    <div
      className={`absolute top-0 h-full cursor-pointer z-30 border-x
                  bg-[repeating-linear-gradient(45deg,rgba(79,140,255,0.34)_0_6px,rgba(79,140,255,0.13)_6px_12px)]
                  ${selected ? "border-accent ring-1 ring-accent" : "border-accent/50 hover:border-accent"}`}
      style={{ left: next.start * zoom, width }}
      onMouseDown={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      title={`${boundary.transition.kind} · ${boundary.transition.duration.toFixed(2)}s${
        boundary.clamped
          ? `\nShortened from ${boundary.requestedDuration.toFixed(1)}s to fit these clips`
          : ""
      }`}
    >
      {!narrow && (
        <div className="absolute inset-0 grid place-items-center">
          <span className="text-[9px] text-blue-100 drop-shadow px-1 truncate">
            {boundary.transition.kind}
          </span>
        </div>
      )}
      {boundary.clamped && (
        <div
          className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-amber-400"
          title="Shortened to fit"
        />
      )}
    </div>
  );
}
