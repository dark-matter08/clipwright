// Reusable confirmation modal for destructive actions.
//
// One canonical dialog so every "are you sure?" in the app speaks the
// same shape: title, body, optional list of items at stake, a Cancel
// and a Confirm button. Confirm is `danger`-colored by default so the
// user can't miss what they're about to do; flip `tone="primary"` when
// the action isn't destructive.
//
// Why a dialog, not the previous two-click-arm pattern: arming is
// fine for low-stakes ops (clear chat, where the data is archived
// anyway), but real destructive actions deserve a hard-to-misclick
// surface that shows exactly what will happen.

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { cn } from "../lib/cn";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Plain-language description of what's about to happen. */
  description: React.ReactNode;
  /** Optional bulleted list of artifacts / side effects so the user
   *  sees exactly what's at stake. */
  consequences?: string[];
  /** Confirmation label (e.g. "Delete video"). */
  confirmLabel: string;
  cancelLabel?: string;
  /** "danger" (red) for destructive ops; "primary" (accent) otherwise. */
  tone?: "danger" | "primary";
  /** Called on confirm. May be async; the modal stays open and disables
   *  the buttons until the promise resolves so a slow op doesn't leave
   *  the user wondering. */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  consequences,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  // Focus the cancel button on mount — destructive confirm should
  // require a deliberate hand movement, not an accidental Enter.
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) onCancel();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-bg shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-border-subtle px-5 py-3">
          <div className="flex items-start gap-2.5">
            {tone === "danger" && (
              <AlertTriangle
                size={20}
                strokeWidth={2}
                className="mt-0.5 shrink-0 text-warn"
                aria-hidden
              />
            )}
            <h2 id="confirm-title" className="text-base font-medium text-fg">
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="Close"
            className="rounded p-1 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg disabled:opacity-50"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </header>

        <div className="flex flex-col gap-3 px-5 py-4 text-sm text-fg-subtle">
          <div>{description}</div>
          {consequences && consequences.length > 0 && (
            <ul className="rounded border border-border-subtle bg-bg-inset px-3 py-2 font-mono text-[11px] text-fg-muted">
              {consequences.map((c, i) => (
                <li key={i} className="leading-5">
                  · {c}
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded px-3 py-1.5 text-xs text-fg-subtle transition-colors hover:bg-bg-raised hover:text-fg focus:focus-ring disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={busy}
            className={cn(
              "flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors focus:focus-ring",
              tone === "danger"
                ? "bg-warn text-bg hover:bg-warn/85"
                : "bg-accent text-bg hover:bg-accent-hover",
              busy && "cursor-not-allowed opacity-60",
            )}
          >
            {busy && <Loader2 size={12} strokeWidth={2.5} className="animate-spin" />}
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
