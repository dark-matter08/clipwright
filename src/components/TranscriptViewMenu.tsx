// TranscriptViewMenu — the rail-header dropdown that picks the
// active transcript view mode and font size. Inspired by the
// Claude Code desktop transcript-view menu:
//
//   ┌──────────────────────────────┐
//   │ Transcript view    ⌃    ⊙    │   ← header + scroll-jump btns
//   │ Normal              ✓        │
//   │ Thinking                     │
//   │ Verbose                      │
//   │ Summary                      │
//   │ ┌─Aa─┬─Aa─┬─Aa─┐             │   ← three font sizes
//   │ └────┴────┴────┘             │
//   └──────────────────────────────┘
//
// Trigger: a small icon button on the rail header next to the
// collapse chevron. Opens a popover absolutely positioned below the
// trigger. Closing on outside-click + Escape.

import { useEffect, useRef, useState } from "react";
import { ChevronUp, Circle, FileText } from "lucide-react";
import { useApp } from "../lib/store";
import type { TranscriptFontSize, TranscriptView } from "../lib/store";
import { cn } from "../lib/cn";

interface TranscriptViewMenuProps {
  /** Called when the user clicks the "scroll to top" arrow. */
  onJumpTop?: () => void;
  /** Called when the user clicks the "jump to latest" circle. */
  onJumpLatest?: () => void;
}

const VIEW_OPTIONS: { value: TranscriptView; label: string; hint: string }[] = [
  {
    value: "normal",
    label: "Normal",
    hint: "User + assistant bubbles, tool calls folded as chips.",
  },
  {
    value: "thinking",
    label: "Thinking",
    hint: "Normal + reveal extended-thinking blocks above each reply.",
  },
  {
    value: "verbose",
    label: "Verbose",
    hint: "Flat event log with timestamps and raw JSON drawers.",
  },
  {
    value: "summary",
    label: "Summary",
    hint: "Skimming view — user message + 1-line gist + tool count.",
  },
];

const FONT_OPTIONS: { value: TranscriptFontSize; size: number; label: string }[] = [
  { value: "sm", size: 10, label: "Small" },
  { value: "md", size: 12, label: "Medium" },
  { value: "lg", size: 14, label: "Large" },
];

export function TranscriptViewMenu({
  onJumpTop,
  onJumpLatest,
}: TranscriptViewMenuProps) {
  const view = useApp((s) => s.transcriptView);
  const fontSize = useApp((s) => s.transcriptFontSize);
  const setView = useApp((s) => s.setTranscriptView);
  const setFontSize = useApp((s) => s.setTranscriptFontSize);

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Click-outside + Escape to close. We don't trap focus inside the
  // popover (it's small) but pulling focus back to the trigger on
  // close keeps keyboard nav predictable.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const t = e.target as Node | null;
      if (
        t &&
        !popoverRef.current?.contains(t) &&
        !triggerRef.current?.contains(t)
      ) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Transcript view"
        aria-label="Transcript view"
        aria-expanded={open}
        aria-haspopup="true"
        className={cn(
          "rounded p-1 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg",
          open && "bg-bg-raised text-fg",
        )}
      >
        <FileText size={14} strokeWidth={2} />
      </button>
      {open && (
        <div
          ref={popoverRef}
          role="menu"
          // Absolute positioned below the trigger, anchored to the
          // right edge so it doesn't overflow the rail's right
          // border when the rail is narrow.
          className="absolute right-0 top-full z-50 mt-1 w-56 rounded-md border border-border-subtle bg-bg-raised p-1.5 shadow-lg"
        >
          {/* Header: title + scroll-jump buttons. */}
          <div className="flex items-center justify-between px-1.5 py-1 text-[11px] text-fg-muted">
            <span>Transcript view</span>
            <div className="flex items-center gap-0.5">
              {onJumpTop && (
                <button
                  type="button"
                  onClick={() => {
                    onJumpTop();
                    setOpen(false);
                  }}
                  title="Jump to top"
                  className="rounded border border-border-subtle p-0.5 text-fg-muted transition-colors hover:bg-bg hover:text-fg"
                >
                  <ChevronUp size={11} strokeWidth={2} />
                </button>
              )}
              {onJumpLatest && (
                <button
                  type="button"
                  onClick={() => {
                    onJumpLatest();
                    setOpen(false);
                  }}
                  title="Jump to latest"
                  className="rounded border border-border-subtle p-0.5 text-fg-muted transition-colors hover:bg-bg hover:text-fg"
                >
                  <Circle size={11} strokeWidth={2} />
                </button>
              )}
            </div>
          </div>

          {/* Mode rows. */}
          <ul className="mt-0.5 flex flex-col">
            {VIEW_OPTIONS.map((opt) => (
              <li key={opt.value}>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={view === opt.value}
                  onClick={() => {
                    setView(opt.value);
                    // Don't auto-close — user might want to compare
                    // modes back to back. Closing on Escape / outside
                    // click still works.
                  }}
                  title={opt.hint}
                  className={cn(
                    "flex w-full items-center justify-between rounded px-1.5 py-1 text-left text-xs transition-colors",
                    "hover:bg-bg hover:text-fg",
                    view === opt.value ? "text-fg" : "text-fg-subtle",
                  )}
                >
                  <span>{opt.label}</span>
                  {view === opt.value && (
                    <svg
                      width={12}
                      height={12}
                      viewBox="0 0 12 12"
                      aria-hidden
                    >
                      <path
                        d="M2.5 6.5l2.5 2.5 4.5-5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </button>
              </li>
            ))}
          </ul>

          {/* Font-size row. */}
          <div className="mt-1.5 grid grid-cols-3 gap-1 border-t border-border-subtle px-1 pt-1.5">
            {FONT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setFontSize(opt.value)}
                title={opt.label}
                aria-label={`Font size: ${opt.label}`}
                aria-pressed={fontSize === opt.value}
                className={cn(
                  "flex items-center justify-center rounded border px-1.5 py-1 transition-colors",
                  fontSize === opt.value
                    ? "border-accent/40 bg-accent/10 text-fg"
                    : "border-border-subtle text-fg-muted hover:bg-bg hover:text-fg",
                )}
              >
                <span style={{ fontSize: opt.size, fontWeight: 600 }}>Aa</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
