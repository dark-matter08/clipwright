// Render dialog — SRS §F-RND-3 + §8.5.1's [▶ Render] CTA.
//
// Triggers `clipwright render-final` which renders each segment (using
// per-segment cache when possible) and concats into `out/final.mp4`.
// Surfaces the path on success so users can reveal it in Finder.

import { useState } from "react";
import { Check, Info, X } from "lucide-react";
import { renderFinal, renderSegment } from "../lib/tauri";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";

/** Which slice of the video the user wants to render. "full" hits
 *  the per-segment caches inside `clipwright render-final` (only
 *  edited segments re-render, then concat). "segment" runs only
 *  `clipwright render-segment` for the currently-selected segment,
 *  skipping the concat — useful when iterating on one beat without
 *  paying the cost of rebuilding the final mp4. */
type RenderScope = "full" | "segment";

interface Props {
  onClose: () => void;
}

export function RenderDialog({ onClose }: Props) {
  const project = useApp((s) => s.project);
  const loadProject = useApp((s) => s.loadProject);
  const setError = useApp((s) => s.setError);
  const selectedId = useApp((s) => s.selectedSegmentId);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ path: string } | null>(null);
  const [force, setForce] = useState(false);
  const [scope, setScope] = useState<RenderScope>("full");

  if (!project || !project.video) return null;
  const video = project.video;
  const segs = video.segments;
  const selectedSeg = selectedId
    ? segs.find((s) => s.id === selectedId) ?? null
    : null;
  // Manhwa-recap templates render through Remotion as a single
  // monolithic pass — there's no per-segment cache to short-circuit
  // and no way to render just one panel's slice without re-running
  // the whole composition. Disable the segment-scoped option and
  // explain in the help text. Recording-flow projects support
  // selective render via `clipwright render-segment`.
  const isManhwaTemplate = (project.project.template_id ?? "").startsWith(
    "manhwa-recap",
  );
  const segmentScopeAvailable = !isManhwaTemplate && Boolean(selectedSeg);
  const effectiveScope: RenderScope =
    scope === "segment" && segmentScopeAvailable ? "segment" : "full";

  async function start() {
    setBusy(true);
    try {
      if (effectiveScope === "segment" && selectedSeg) {
        // Per-segment path — writes to out/segments/<vid>/<seg>.mp4,
        // bypasses concat. Final mp4 stays at its previous state;
        // the stale-final banner will surface in Preview so the
        // user knows to do a full render later.
        const state = await renderSegment(
          project!.project_dir,
          video.video_id,
          selectedSeg.id,
          force,
        );
        loadProject(state);
        useApp.getState().markFinalStale(video.video_id);
        setDone({
          path: `out/segments/${video.video_id}/${selectedSeg.id}.mp4`,
        });
        return;
      }
      const r = await renderFinal(project!.project_dir, video.video_id, force);
      loadProject(r.project);
      // Fresh final mp4 — any "stale, please re-render" banner that
      // was up dismisses itself now.
      useApp.getState().markFinalFresh(video.video_id);
      setDone({ path: r.final_path });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div className="w-full max-w-lg rounded-lg border border-border bg-bg shadow-2xl">
        <header className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
          <h2 className="text-base font-medium">Render</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded p-1 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg disabled:opacity-50"
            aria-label="Close"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </header>

        <div className="flex flex-col gap-3 px-5 py-4">
          {done ? (
            <div className="flex flex-col gap-2">
              <p className="flex items-center gap-1.5 text-sm text-ok">
                <Check size={14} strokeWidth={2.5} />
                Rendered to:
              </p>
              <code className="rounded bg-bg-inset px-2 py-1.5 font-mono text-[11px] text-fg">
                {done.path}
              </code>
              <p className="text-xs text-fg-muted">
                Reveal it in Finder, or run{" "}
                <code className="font-mono">clipwright render-final --project {project.project_dir}</code>{" "}
                from a terminal to reproduce.
              </p>
            </div>
          ) : (
            <>
              {/* Scope picker — radio-style toggle between "whole
               *  video" and "just the selected segment". Disabled
               *  for manhwa-recap projects because their Remotion
               *  composition renders monolithically; we explain why
               *  inline so the user isn't confused by the gray-out. */}
              <div className="flex flex-col gap-2">
                <span className="text-[10px] font-medium uppercase tracking-wider text-fg-muted">
                  Scope
                </span>
                <div className="grid grid-cols-2 gap-2">
                  <ScopeOption
                    active={effectiveScope === "full"}
                    onClick={() => setScope("full")}
                    title="Whole video"
                    desc={`Render all ${segs.length} segment${segs.length === 1 ? "" : "s"} + concat to out/final/${video.video_id}.mp4.`}
                  />
                  <ScopeOption
                    active={effectiveScope === "segment"}
                    onClick={() => segmentScopeAvailable && setScope("segment")}
                    disabled={!segmentScopeAvailable}
                    title={
                      selectedSeg ? `Just ${selectedSeg.id}` : "Just selected segment"
                    }
                    desc={
                      isManhwaTemplate
                        ? "Disabled: manhwa-recap renders as one Remotion pass."
                        : !selectedSeg
                          ? "Select a segment in the timeline first."
                          : `Render only ${selectedSeg.id} into out/segments/${video.video_id}/. Final mp4 stays at its previous state.`
                    }
                  />
                </div>
                {effectiveScope === "full" && (
                  <p className="text-xs text-fg-subtle">
                    Will render {segs.length} segment
                    {segs.length === 1 ? "" : "s"} and concat to{" "}
                    <code className="font-mono">out/final.mp4</code>.{" "}
                    {isManhwaTemplate ? (
                      <>
                        Manhwa-recap projects re-render the whole composition;
                        per-segment caching isn't applicable.
                      </>
                    ) : (
                      <>Per-segment caches mean only edited segments re-render.</>
                    )}
                  </p>
                )}
                {effectiveScope === "segment" && selectedSeg && (
                  <p className="flex items-start gap-1.5 rounded border border-border-subtle bg-bg-inset px-2.5 py-1.5 text-xs text-fg-subtle">
                    <Info size={12} strokeWidth={2} className="mt-0.5 shrink-0 text-fg-muted" />
                    <span>
                      Renders just <code className="font-mono">{selectedSeg.id}</code>{" "}
                      to <code className="font-mono">out/segments/{video.video_id}/{selectedSeg.id}.mp4</code>.
                      The final mp4 stays unchanged — run "Whole video"
                      after to bake it into{" "}
                      <code className="font-mono">out/final/{video.video_id}.mp4</code>.
                    </span>
                  </p>
                )}
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-fg-subtle">
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                  className="accent-accent"
                />
                Force re-render (bypass cache)
              </label>
              {busy && (
                <div className="flex items-center gap-2 rounded bg-bg-inset px-3 py-2 text-xs text-fg-muted">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" />
                  Rendering — this may take a while on the first pass.
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg disabled:opacity-50"
          >
            {done ? "Close" : "Cancel"}
          </button>
          {!done && (
            <button
              type="button"
              onClick={start}
              disabled={busy || segs.length === 0}
              className={cn(
                "rounded px-4 py-1.5 text-xs font-medium transition-colors",
                "disabled:cursor-not-allowed disabled:bg-bg-raised disabled:text-fg-muted",
                "enabled:bg-accent enabled:text-bg enabled:hover:bg-accent-hover",
              )}
            >
              {busy ? "Rendering…" : "Render"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** One option in the render-scope radio toggle. The active card
 *  has the accent border + filled background; the disabled state
 *  dims the card and shows the "why" in `desc` so the user knows
 *  what they'd unlock by changing context. */
function ScopeOption({
  active,
  disabled,
  onClick,
  title,
  desc,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex flex-col items-start gap-1 rounded border px-2.5 py-2 text-left transition-colors",
        active
          ? "border-accent bg-accent/10 text-fg"
          : "border-border-subtle bg-bg text-fg-subtle hover:border-border hover:bg-bg-raised",
        disabled && "cursor-not-allowed opacity-50 hover:border-border-subtle hover:bg-bg",
      )}
    >
      <span className="text-xs font-medium">{title}</span>
      <span className="text-[10px] leading-snug text-fg-muted">{desc}</span>
    </button>
  );
}
