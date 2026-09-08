// Custom dropdown / select component.
//
// Native HTML `<select>` on macOS renders a white-on-blue menu that
// clashes hard with our dark UI tokens — you can see it in the
// permission-mode and model pickers in the rail header. This component
// replaces them with a themed equivalent: themed trigger button, themed
// open menu, keyboard navigation, click-outside-to-close, current-option
// highlight + check mark.
//
// Headless-ish: the caller provides `options` and a controlled `value`;
// styling is partially overridable via `triggerClassName` so the same
// component can be a tiny badge in a top bar OR a full-width input in
// a form (see Inspector's Source picker).

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../lib/cn";

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
  /** Optional small-text description shown in the open menu and as
   *  the tooltip title on the trigger when this option is selected. */
  hint?: string;
}

export interface DropdownProps<T extends string> {
  value: T;
  options: ReadonlyArray<DropdownOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Trigger button label fallback when no matching option is found.
   *  Useful when `value` is set to a custom string outside the
   *  declared options. */
  placeholder?: string;
  /** Tailwind classes added to the trigger button. Use this to make
   *  the dropdown render as a badge (mono/small) vs a form input
   *  (full-width, regular size). The component supplies the base
   *  border / focus-ring / disabled classes. */
  triggerClassName?: string;
  /** Where the open menu aligns relative to the trigger. Default
   *  `"left"` — menu's left edge meets the trigger's left edge. */
  menuAlign?: "left" | "right";
  /** Optional menu width — defaults to "match trigger". Pass a fixed
   *  pixel width (e.g. 220) when the labels are long but the trigger
   *  is a compact badge. */
  menuMinWidth?: number;
  /** Used as the trigger's `title` when the selected option has no
   *  hint of its own. */
  titleFallback?: string;
  /** Tailwind classes for the outer wrapper. Default is
   *  `relative inline-block` (fit-content); pass `relative block w-full`
   *  to make the trigger span its parent for form-input usage. */
  wrapperClassName?: string;
}

export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  disabled,
  placeholder = "—",
  triggerClassName,
  menuAlign = "left",
  menuMinWidth,
  titleFallback,
  wrapperClassName,
}: DropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<number>(() =>
    Math.max(0, options.findIndex((o) => o.value === value)),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const current = options.find((o) => o.value === value);

  // Reset highlight to the currently-selected row when the menu opens
  // so arrow-key navigation starts on something familiar.
  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((o) => o.value === value);
    setHighlight(idx >= 0 ? idx : 0);
  }, [open, options, value]);

  // Click-outside to close — listen at the document level so a click
  // anywhere outside the trigger + menu dismisses.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const root = rootRef.current;
      if (!root) return;
      if (root.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Auto-scroll the highlighted row into view as the user arrow-keys.
  useEffect(() => {
    if (!open) return;
    const el = menuRef.current?.querySelector<HTMLElement>(
      `[data-dd-idx="${highlight}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  function pick(idx: number) {
    const opt = options[idx];
    if (!opt) return;
    onChange(opt.value);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((i) => Math.max(0, i - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setHighlight(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setHighlight(options.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(highlight);
    } else if (e.key === "Tab") {
      // Let Tab close the menu without picking — accessibility-
      // friendly: arrow keys for navigation, Tab to escape.
      setOpen(false);
    }
  }

  return (
    <div
      ref={rootRef}
      className={cn("relative inline-block", wrapperClassName)}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        disabled={disabled}
        title={current?.hint ?? titleFallback ?? ""}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => !disabled && setOpen((v) => !v)}
        className={cn(
          // Base trigger — caller overrides the fonts/sizes/borders.
          "flex items-center gap-1 rounded border border-border-subtle bg-bg text-fg-muted",
          "transition-colors hover:text-fg focus:focus-ring",
          disabled && "cursor-not-allowed opacity-40",
          triggerClassName,
        )}
      >
        <span className="truncate">{current?.label ?? placeholder}</span>
        <ChevronDown
          size={11}
          strokeWidth={2}
          className={cn(
            "shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div
          ref={menuRef}
          id={listboxId}
          role="listbox"
          style={{
            minWidth: menuMinWidth ?? "100%",
            [menuAlign === "right" ? "right" : "left"]: 0,
          }}
          className={cn(
            "absolute top-[calc(100%+4px)] z-50 max-h-72 overflow-y-auto rounded",
            "border border-border-subtle bg-bg-raised shadow-xl",
            "py-1",
          )}
        >
          {options.map((opt, idx) => {
            const selected = opt.value === value;
            const isHighlighted = idx === highlight;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={selected}
                data-dd-idx={idx}
                onMouseEnter={() => setHighlight(idx)}
                onClick={() => pick(idx)}
                title={opt.hint}
                className={cn(
                  "flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-xs transition-colors",
                  isHighlighted && !selected && "bg-bg-inset text-fg",
                  selected && "bg-accent/15 text-fg",
                  !isHighlighted && !selected && "text-fg-subtle",
                )}
              >
                <Check
                  size={12}
                  strokeWidth={2.5}
                  className={cn(
                    "mt-[3px] shrink-0",
                    selected ? "text-accent" : "invisible",
                  )}
                />
                <span className="flex flex-col">
                  <span className="font-medium leading-tight">{opt.label}</span>
                  {opt.hint && (
                    <span className="mt-0.5 text-[10px] leading-snug text-fg-muted">
                      {opt.hint}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
