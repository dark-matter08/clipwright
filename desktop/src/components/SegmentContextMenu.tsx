// Right-click context menu for a timeline segment — SRS F-TL-4.
//
// Renders at a fixed (x, y) viewport position. Closes on outside-click,
// Escape, or after invoking an action. Each row shows its keyboard
// shortcut so the user learns the bindings naturally.

import { useEffect, useRef } from "react";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";

interface Props {
  segId: string;
  x: number;
  y: number;
  onClose: () => void;
}

export function SegmentContextMenu({ segId, x, y, onClose }: Props) {
  const seg = useApp((s) => s.project?.timeline.segments.find((g) => g.id === segId));
  const segments = useApp((s) => s.project?.timeline.segments ?? []);
  const split = useApp((s) => s.splitSelected);
  const dup = useApp((s) => s.duplicateSelected);
  const del = useApp((s) => s.deleteSelected);
  const merge = useApp((s) => s.mergeSelected);
  const move = useApp((s) => s.moveSelected);
  const select = useApp((s) => s.selectSegment);
  const askClaude = useApp((s) => s.askClaudeForSegment);
  const ref = useRef<HTMLDivElement>(null);

  // Ensure the target segment is selected when the menu opens — every
  // action operates on `selectedSegmentId`.
  useEffect(() => {
    select(segId);
  }, [segId, select]);

  // Outside click / Esc to close
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!seg) return null;
  const idx = segments.findIndex((g) => g.id === segId);
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < segments.length - 1;
  const splittable = seg.target_duration >= 1.0;

  async function run(fn: () => Promise<void>) {
    onClose();
    await fn();
  }

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: x, top: y }}
      className={cn(
        "fixed z-50 w-56 rounded border border-border bg-bg-raised py-1 shadow-2xl",
        "text-sm text-fg",
      )}
    >
      <MenuLabel>{seg.id} · {seg.target_duration.toFixed(1)}s</MenuLabel>
      <Sep />
      <MenuItem
        label="Ask Claude…"
        shortcut="✨"
        onClick={() => {
          onClose();
          askClaude(segId);
        }}
      />
      <Sep />
      <MenuItem
        label="Split at midpoint"
        shortcut="⌘B"
        disabled={!splittable}
        onClick={() => run(split)}
      />
      <MenuItem label="Duplicate" shortcut="⌘D" onClick={() => run(dup)} />
      <MenuItem
        label="Delete"
        shortcut="⌫"
        danger
        onClick={() => run(del)}
      />
      <Sep />
      <MenuItem
        label="Merge with previous"
        disabled={!hasPrev}
        onClick={() => run(() => merge("prev"))}
      />
      <MenuItem
        label="Merge with next"
        disabled={!hasNext}
        onClick={() => run(() => merge("next"))}
      />
      <Sep />
      <MenuItem
        label="Move left"
        shortcut="⌘←"
        disabled={!hasPrev}
        onClick={() => run(() => move("prev"))}
      />
      <MenuItem
        label="Move right"
        shortcut="⌘→"
        disabled={!hasNext}
        onClick={() => run(() => move("next"))}
      />
    </div>
  );
}

function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
      {children}
    </div>
  );
}

function MenuItem({
  label,
  shortcut,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center justify-between px-3 py-1.5 text-left transition-colors",
        "disabled:cursor-not-allowed disabled:text-fg-muted",
        !disabled && !danger && "hover:bg-bg-subtle hover:text-fg",
        !disabled && danger && "text-danger hover:bg-danger/10",
      )}
    >
      <span>{label}</span>
      {shortcut && (
        <span className="font-mono text-[11px] text-fg-muted">{shortcut}</span>
      )}
    </button>
  );
}

function Sep() {
  return <div className="my-1 h-px bg-border-subtle" />;
}
