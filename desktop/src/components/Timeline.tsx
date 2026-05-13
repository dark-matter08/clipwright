// Timeline — SRS §8.5.4. The spine of the editor.
//
// P1.4 adds: right-click context menu, keyboard-driven mutations
// (via the global keyboard hook), ⌘+/⌘-/⌘0 zoom. Drag-edge trim and
// drag-to-reorder land in P1.5 alongside the inspector trim group.

import { useState } from "react";
import type { Segment } from "../lib/types";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";
import { SegmentContextMenu } from "./SegmentContextMenu";

const MIN_PX_PER_SEC = 6;
const MAX_PX_PER_SEC = 60;
const DEFAULT_PX_PER_SEC = 18;

interface MenuState {
  segId: string;
  x: number;
  y: number;
}

export function Timeline() {
  const project = useApp((s) => s.project);
  const selectedId = useApp((s) => s.selectedSegmentId);
  const selectSegment = useApp((s) => s.selectSegment);
  const pxPerSecOverride = useApp((s) => s.pxPerSec);
  const past = useApp((s) => s.past.length);
  const future = useApp((s) => s.future.length);
  const undo = useApp((s) => s.undo);
  const redo = useApp((s) => s.redo);

  const [menu, setMenu] = useState<MenuState | null>(null);

  const segments = project?.video?.segments ?? [];
  const total = segments.reduce((acc, s) => acc + s.target_duration, 0);
  const pxPerSec =
    pxPerSecOverride !== null
      ? pxPerSecOverride
      : autoDensity(segments.length, total);

  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex h-6 shrink-0 items-center gap-3 border-b border-border-subtle px-3 text-xs text-fg-muted">
        <span className="font-mono uppercase tracking-wider">Timeline</span>
        <span>·</span>
        <span>
          {segments.length} segment{segments.length === 1 ? "" : "s"} ·{" "}
          {fmtDuration(total)}
        </span>
        <span className="ml-auto flex items-center gap-2 font-mono text-[10px]">
          <HistoryButton
            label="↶"
            title="Undo (⌘Z)"
            disabled={past === 0}
            onClick={undo}
          />
          <HistoryButton
            label="↷"
            title="Redo (⇧⌘Z)"
            disabled={future === 0}
            onClick={redo}
          />
          <span className="text-fg-muted">·</span>
          <span title="Pixels per second">{pxPerSec.toFixed(0)} px/s</span>
        </span>
      </header>
      <div
        className="flex flex-1 overflow-x-auto overflow-y-hidden"
        onClick={() => setMenu(null)}
        onContextMenu={(e) => {
          // Right-click on empty timeline area — close any open menu.
          if (e.target === e.currentTarget) {
            e.preventDefault();
            setMenu(null);
          }
        }}
      >
        <div
          className="flex h-full items-stretch gap-1 p-2"
          style={{ minWidth: "100%" }}
        >
          {segments.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">
              Empty timeline. Import a video or record a session to seed segments.
            </div>
          ) : (
            segments.map((seg) => (
              <SegmentBlock
                key={seg.id}
                seg={seg}
                selected={seg.id === selectedId}
                pxPerSec={pxPerSec}
                onSelect={() => selectSegment(seg.id)}
                onContextMenu={(x, y) => setMenu({ segId: seg.id, x, y })}
              />
            ))
          )}
        </div>
      </div>

      {menu && (
        <SegmentContextMenu
          segId={menu.segId}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function SegmentBlock(props: {
  seg: Segment;
  selected: boolean;
  pxPerSec: number;
  onSelect: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const { seg, selected, pxPerSec, onSelect, onContextMenu } = props;
  const width = Math.max(36, seg.target_duration * pxPerSec);
  return (
    <button
      type="button"
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      style={{ width }}
      className={cn(
        "group relative flex h-full shrink-0 flex-col items-start justify-between rounded border bg-bg-raised px-2 py-1.5 text-left transition-colors",
        selected
          ? "border-accent ring-1 ring-accent"
          : "border-border-subtle hover:border-border",
      )}
    >
      <span className="truncate text-xs font-medium text-fg">
        {seg.label || seg.id}
      </span>
      <div className="flex w-full items-center gap-1 text-[10px] text-fg-muted">
        <span className="font-mono">{seg.target_duration.toFixed(1)}s</span>
        {seg.chapter && (
          <span className="truncate rounded bg-bg-inset px-1 py-px font-mono">
            {seg.chapter}
          </span>
        )}
        <span className="ml-auto font-mono">{seg.id.replace("seg_", "")}</span>
      </div>
    </button>
  );
}

function HistoryButton(props: {
  label: string;
  title: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      className={cn(
        "rounded px-1.5 py-0.5 text-sm transition-colors",
        props.disabled
          ? "cursor-not-allowed text-fg-muted"
          : "text-fg-subtle hover:bg-bg-raised hover:text-fg",
      )}
    >
      {props.label}
    </button>
  );
}

function autoDensity(n: number, totalSec: number): number {
  if (n === 0 || totalSec === 0) return DEFAULT_PX_PER_SEC;
  const want = (1200 * 0.85) / totalSec;
  return Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, want));
}

function fmtDuration(sec: number): string {
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}
