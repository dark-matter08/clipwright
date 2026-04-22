import type { Clip } from "../lib/types";
import { cn } from "../lib/cn";
import { I } from "../lib/icons";

export function ClipList({
  clips,
  selected,
  onSelect,
}: {
  clips: Clip[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-panel/80 px-3 py-1.5 font-mono text-[10px] uppercase text-muted backdrop-blur">
        <span className="flex items-center gap-1.5">
          <I.ListMusic size={11} className="text-accent/70" /> clips · {clips.length}
        </span>
        <span>total {clips.reduce((a, c) => a + c.target_seconds, 0).toFixed(1)}s</span>
      </div>
      {clips.map((c, i) => {
        const isSelected = selected === c.id;
        return (
          <button
            key={c.id}
            onClick={() => onSelect(c.id)}
            className={cn(
              "block w-full border-b border-border px-3 py-2 text-left font-mono text-xs transition-colors hover:bg-panel/50",
              isSelected && "bg-panel border-l-2 border-l-accent",
            )}
          >
            <div className="flex items-baseline justify-between">
              <span className={cn("text-muted", isSelected && "text-accent/80")}>
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="flex items-center gap-1 text-accent">
                <I.Clock size={10} />
                {c.target_seconds.toFixed(1)}s
              </span>
            </div>
            <div className={cn("mt-1 truncate text-fg", !isSelected && "text-fg/90")}>{c.chapter}</div>
            <div className="mt-1 line-clamp-2 text-[10px] text-muted">{c.text || "(empty)"}</div>
          </button>
        );
      })}
    </div>
  );
}
