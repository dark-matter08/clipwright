import type { Clip } from "../lib/types";
import { cn } from "../lib/cn";

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
      {clips.map((c, i) => (
        <button
          key={c.id}
          onClick={() => onSelect(c.id)}
          className={cn(
            "block w-full border-b border-border px-3 py-2 text-left font-mono text-xs hover:bg-panel/50",
            selected === c.id && "bg-panel border-l-2 border-l-accent",
          )}
        >
          <div className="flex items-baseline justify-between">
            <span className="text-muted">{String(i + 1).padStart(2, "0")}</span>
            <span className="text-accent">{c.target_seconds.toFixed(1)}s</span>
          </div>
          <div className="mt-1 text-fg">{c.chapter}</div>
          <div className="mt-1 truncate text-[10px] text-muted">{c.text || "(empty)"}</div>
        </button>
      ))}
    </div>
  );
}
