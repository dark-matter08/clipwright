import { useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Hub } from "./components/Hub";
import { Workspace } from "./components/Workspace";
import { useGlobalKeys } from "./lib/keyboard";
import { useApp } from "./lib/store";

export function App() {
  const view = useApp((s) => s.view);
  const error = useApp((s) => s.error);
  const errorHistory = useApp((s) => s.errorHistory);
  const setError = useApp((s) => s.setError);
  const clearErrorHistory = useApp((s) => s.clearErrorHistory);
  const [showHistory, setShowHistory] = useState(false);

  useGlobalKeys();

  // Persistent banner: once an error is set, it stays until the user
  // explicitly dismisses. The prior single-line banner would dismiss
  // immediately if the next state action re-rendered, so users hit a
  // failure mode where the message flashed and disappeared before they
  // could read it (especially Claude-rail subprocess failures where the
  // chat keeps re-rendering). Now: multi-line `<pre>`, copy button,
  // and an expandable history drawer fed by `errorHistory`.
  const hasHistory = errorHistory.length > 0;

  function copy(text: string) {
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  return (
    <div className="flex h-full w-full flex-col">
      {error && (
        <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-danger/10 px-4 py-3 text-sm">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 font-medium text-danger">Error:</span>
            <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-fg">
              {error}
            </pre>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => copy(error)}
                className="rounded border border-border-subtle px-2 py-0.5 text-xs text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg"
                title="Copy the error to clipboard"
              >
                Copy
              </button>
              <button
                type="button"
                onClick={() => setError(null)}
                className="text-xs text-fg-muted hover:text-fg"
                title="Hide the banner (the message stays in error history)"
              >
                dismiss
              </button>
            </div>
          </div>
          {hasHistory && (
            <div className="flex items-center gap-2 text-[11px] text-fg-muted">
              <button
                type="button"
                onClick={() => setShowHistory((v) => !v)}
                className="rounded border border-border-subtle px-2 py-0.5 hover:bg-bg-raised hover:text-fg"
              >
                {showHistory ? "Hide" : "Show"} error history ({errorHistory.length})
              </button>
              {showHistory && (
                <>
                  <button
                    type="button"
                    onClick={() => copy(formatHistory(errorHistory))}
                    className="rounded border border-border-subtle px-2 py-0.5 hover:bg-bg-raised hover:text-fg"
                  >
                    Copy all
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm("Clear all stored error records?")) {
                        clearErrorHistory();
                      }
                    }}
                    className="rounded border border-border-subtle px-2 py-0.5 text-danger hover:bg-bg-raised"
                  >
                    Clear history
                  </button>
                </>
              )}
            </div>
          )}
          {showHistory && hasHistory && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border-subtle bg-bg-inset p-2 font-mono text-[11px] leading-relaxed text-fg">
              {formatHistory(errorHistory)}
            </pre>
          )}
        </div>
      )}
      {/* Without this boundary, any uncaught render error in Hub /
       *  Workspace (e.g. Preview's convertFileSrc throwing during a
       *  hot-reload, a transient prop-shape mismatch after a store
       *  action, etc.) unmounts the entire React root and presents
       *  as a blank screen. The boundary catches it, shows the error
       *  text, and lets the user reset back into the app. */}
      <ErrorBoundary label={view === "hub" ? "Hub crashed." : "Workspace crashed."}>
        {view === "hub" ? <Hub /> : <Workspace />}
      </ErrorBoundary>
    </div>
  );
}

function formatHistory(records: { ts: string; source: string; message: string }[]): string {
  return records
    .slice()
    .reverse()
    .map((r) => `[${r.ts}] ${r.source}\n${r.message}`)
    .join("\n\n");
}
