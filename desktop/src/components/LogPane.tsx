import type { RefObject } from "react";
import { I } from "../lib/icons";

export function LogPane({
  logs,
  progress,
  innerRef,
}: {
  logs: string[];
  progress: { stage: string; pct?: number } | null;
  innerRef: RefObject<HTMLDivElement | null>;
}) {
  const pct = progress?.pct ?? 0;
  return (
    <div className="flex h-48 flex-col border-t border-border bg-panel/40">
      <div className="flex items-center justify-between border-b border-border px-3 py-1 font-mono text-[10px] uppercase text-muted">
        <span className="flex items-center gap-1.5">
          <I.Terminal size={11} className="text-accent/70" /> logs
          <span className="text-muted/60">· {logs.length} lines</span>
        </span>
        {progress && (
          <span className="flex items-center gap-1.5 text-accent">
            <I.Loader size={10} className="animate-spin" />
            <span>{progress.stage}</span>
            {progress.pct !== undefined && <span>· {(pct * 100).toFixed(0)}%</span>}
          </span>
        )}
      </div>
      {progress && progress.pct !== undefined && (
        <div className="h-px bg-border">
          <div
            className="h-px bg-accent transition-[width]"
            style={{ width: `${Math.min(100, Math.max(0, pct * 100))}%` }}
          />
        </div>
      )}
      <div
        ref={innerRef}
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-5 text-muted"
      >
        {logs.length === 0 && (
          <span className="text-muted/60">// stdout / stderr stream will appear here</span>
        )}
        {logs.map((l, i) => {
          const isErr = l.startsWith("[stderr]") || l.includes("error") || l.includes("Error");
          return (
            <div
              key={i}
              className={
                "whitespace-pre-wrap " + (isErr ? "text-accent2" : "text-muted hover:text-fg")
              }
            >
              {l}
            </div>
          );
        })}
      </div>
    </div>
  );
}
