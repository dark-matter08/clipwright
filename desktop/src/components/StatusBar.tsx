// Status bar — SRS §8.5.6. Render readiness · save state · doctor health ·
// last render. P1.4 adds the undo-stack indicator and segment count
// reflecting live timeline mutations.

import { useApp } from "../lib/store";

export function StatusBar() {
  const project = useApp((s) => s.project);
  const past = useApp((s) => s.past.length);
  const future = useApp((s) => s.future.length);
  const segs = project?.timeline.segments.length ?? 0;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border-subtle bg-bg-subtle px-3 text-xs text-fg-muted">
      <span className="flex items-center gap-1">
        <span className="text-ok">⚡</span> ready
      </span>
      <span>·</span>
      <span>
        {segs} segment{segs === 1 ? "" : "s"}
      </span>
      <span>·</span>
      <span className="font-mono">saved</span>
      {(past > 0 || future > 0) && (
        <>
          <span>·</span>
          <span className="font-mono" title="Undo/redo stack depth">
            {past}↶ {future}↷
          </span>
        </>
      )}
      <span className="ml-auto flex items-center gap-3">
        <span>doctor: <span className="text-ok">✓</span></span>
        <span className="font-mono">{project?.project_dir ?? ""}</span>
      </span>
    </footer>
  );
}
