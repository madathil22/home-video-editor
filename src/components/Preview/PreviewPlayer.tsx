import { useCallback, useEffect, useMemo, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useEditor } from "@/state/projectStore";
import TransportControls from "./TransportControls";

/** How far a video may drift from the timeline clock before we re-seek it. */
const DRIFT_TOLERANCE = 0.25;
/** Start loading the following clip this many seconds before it is needed. */
const PRELOAD_LEAD = 3;

interface Slot {
  clipIndex: number;
  opacity: number;
  /** Source time to show, in the media's own timebase. */
  mediaTime: number;
  src: string;
  muted: boolean;
}

export default function PreviewPlayer() {
  const project = useEditor((s) => s.project);
  const resolved = useEditor((s) => s.resolved);
  const playhead = useEditor((s) => s.playhead);
  const isPlaying = useEditor((s) => s.isPlaying);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const setPlaying = useEditor((s) => s.setPlaying);

  const videoA = useRef<HTMLVideoElement>(null);
  const videoB = useRef<HTMLVideoElement>(null);
  const musicRef = useRef<HTMLAudioElement>(null);
  const loadedSrc = useRef<[string, string]>(["", ""]);

  const mediaById = useMemo(
    () => Object.fromEntries(project.media.map((m) => [m.id, m])),
    [project.media]
  );

  const sourceFor = useCallback(
    (mediaId: string): string | null => {
      const m = mediaById[mediaId];
      if (!m) return null;
      // Proxies are the whole point of the preview path; only fall back to the
      // 4K original while the proxy is still being built.
      return convertFileSrc(m.proxyPath ?? m.path);
    },
    [mediaById]
  );

  /**
   * Work out what each of the two video elements should be showing right now.
   * Clips alternate between the elements by index parity, so a hard cut is a
   * handoff to an element that already has the right file loaded.
   */
  const planSlots = useCallback(
    (t: number): Slot[] => {
      const slots: Slot[] = [];
      resolved.clips.forEach((layout, i) => {
        if (t < layout.start || t >= layout.end) return;
        const clip = project.timeline[i];
        if (!clip) return;
        const src = sourceFor(clip.mediaId);
        if (!src) return;

        // Inside an overlap the incoming clip fades up over the outgoing one.
        const boundary = resolved.boundaries[i - 1];
        let opacity = 1;
        if (boundary?.transition) {
          const p = (t - layout.start) / boundary.transition.duration;
          if (p < 1) opacity = Math.max(0, Math.min(1, p));
        }

        slots.push({
          clipIndex: i,
          opacity,
          mediaTime: clip.inPoint + (t - layout.start),
          src,
          muted: clip.muted,
        });
      });
      return slots;
    },
    [resolved, project.timeline, sourceFor]
  );

  const sync = useCallback(
    (t: number, playing: boolean) => {
      const els = [videoA.current, videoB.current];
      const slots = planSlots(t);

      const used = new Set<number>();
      for (const slot of slots) {
        const slotIdx = slot.clipIndex % 2;
        const el = els[slotIdx];
        if (!el) continue;
        used.add(slotIdx);

        if (loadedSrc.current[slotIdx] !== slot.src) {
          loadedSrc.current[slotIdx] = slot.src;
          el.src = slot.src;
        }

        el.style.opacity = String(slot.opacity);
        el.muted = slot.muted;
        el.volume = slot.opacity;

        if (playing) {
          if (Math.abs(el.currentTime - slot.mediaTime) > DRIFT_TOLERANCE) {
            el.currentTime = slot.mediaTime;
          }
          if (el.paused) void el.play().catch(() => {});
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - slot.mediaTime) > 0.02) {
            el.currentTime = slot.mediaTime;
          }
        }
      }

      // Whichever element is idle gets the next clip queued up, so a cut does
      // not stall on a fresh network/disk load.
      const nextIndex = resolved.clips.findIndex((c) => c.start > t);
      if (nextIndex >= 0 && resolved.clips[nextIndex].start - t < PRELOAD_LEAD) {
        const slotIdx = nextIndex % 2;
        if (!used.has(slotIdx)) {
          const clip = project.timeline[nextIndex];
          const src = clip ? sourceFor(clip.mediaId) : null;
          const el = els[slotIdx];
          if (el && src) {
            if (loadedSrc.current[slotIdx] !== src) {
              loadedSrc.current[slotIdx] = src;
              el.src = src;
              el.currentTime = clip.inPoint;
            }
            el.style.opacity = "0";
            if (!el.paused) el.pause();
          }
        }
      }

      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (!el || used.has(i)) continue;
        el.style.opacity = "0";
        if (!el.paused) el.pause();
      }

      syncMusic(t, playing);
    },
    [planSlots, resolved.clips, project.timeline, sourceFor]
  );

  const syncMusic = useCallback(
    (t: number, playing: boolean) => {
      const el = musicRef.current;
      const music = project.music;
      if (!el) return;
      if (!music) {
        if (!el.paused) el.pause();
        return;
      }

      const total = resolved.totalDuration;
      const fadeIn = music.fadeIn > 0 ? Math.min(1, t / music.fadeIn) : 1;
      const remaining = total - t;
      const fadeOut = music.fadeOut > 0 ? Math.min(1, Math.max(0, remaining / music.fadeOut)) : 1;
      el.volume = Math.max(0, Math.min(1, music.volume * fadeIn * fadeOut));

      const want = music.startOffset + t;
      const source = music.loopToFit ? want % Math.max(0.1, music.duration) : want;

      if (source >= music.duration) {
        if (!el.paused) el.pause();
        return;
      }

      if (playing) {
        if (Math.abs(el.currentTime - source) > DRIFT_TOLERANCE) el.currentTime = source;
        if (el.paused) void el.play().catch(() => {});
      } else {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - source) > 0.05) el.currentTime = source;
      }
    },
    [project.music, resolved.totalDuration]
  );

  // Playback clock. Driving the timeline from our own clock rather than from a
  // video element keeps the two elements, the music, and the playhead agreeing
  // through transitions where two clips are on screen at once.
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const next = useEditor.getState().playhead + dt;
      if (next >= resolved.totalDuration) {
        setPlayhead(resolved.totalDuration);
        setPlaying(false);
        return;
      }
      setPlayhead(next);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, resolved.totalDuration, setPlayhead, setPlaying]);

  useEffect(() => {
    sync(playhead, isPlaying);
  }, [playhead, isPlaying, sync]);

  // Pause everything when the timeline empties out.
  useEffect(() => {
    if (resolved.clips.length === 0 && isPlaying) setPlaying(false);
  }, [resolved.clips.length, isPlaying, setPlaying]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#0c0e11]">
      <div className="flex-1 min-h-0 p-3">
        {/* The stage fills the pane and the videos letterbox inside it. Sizing a
            box by aspect-ratio instead would overflow, because a percentage
            max-height has nothing definite to resolve against here. */}
        <div className="relative w-full h-full bg-black shadow-lg overflow-hidden">
          <video
            ref={videoA}
            className="absolute inset-0 w-full h-full object-contain transition-none"
            style={{ opacity: 0 }}
            preload="auto"
            playsInline
          />
          <video
            ref={videoB}
            className="absolute inset-0 w-full h-full object-contain transition-none"
            style={{ opacity: 0 }}
            preload="auto"
            playsInline
          />
          {resolved.clips.length === 0 && (
            <div className="absolute inset-0 grid place-items-center text-neutral-600 text-sm">
              Nothing on the timeline yet
            </div>
          )}
          <audio
            ref={musicRef}
            src={project.music ? convertFileSrc(project.music.path) : undefined}
            preload="auto"
          />
        </div>
      </div>
      <TransportControls />
    </div>
  );
}
