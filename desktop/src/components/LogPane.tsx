import type { RefObject } from "react";

export function LogPane({
  logs,
  progress,
  innerRef,
}: {
  logs: string[];
  progress: { stage: string; pct?: number } | null;
  innerRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="h-48 border-t border-border bg-panel/40">
      {progress && (
        <div className="border-b border-border px-3 py-1 font-mono text-[11px] text-accent">
          {progress.stage}
          {progress.pct !== undefined && ` — ${(progress.pct * 100).toFixed(0)}%`}
        </div>
      )}
      <div ref={innerRef} className="h-full overflow-y-auto px-3 py-2 font-mono text-[11px] leading-5 text-muted">
        {logs.length === 0 && <span className="text-muted/60">// stdout/stderr stream</span>}
        {logs.map((l, i) => (
          <div key={i} className="whitespace-pre-wrap">{l}</div>
        ))}
      </div>
    </div>
  );
}
