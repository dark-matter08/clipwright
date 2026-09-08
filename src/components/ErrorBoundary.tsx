// React error boundary — converts uncaught render errors into a visible
// fallback UI instead of an unmounted root (which presents as a blank
// screen). Without this, a single crash in any descendant — e.g. Preview's
// `convertFileSrc` throwing because `window.__TAURI_INTERNALS__` is briefly
// absent during a hot-reload, or a transient state shape mismatch after a
// store action — tears down the whole App tree.
//
// The fallback surfaces the error message + stack so a user can paste it
// into a bug report, and offers a "Try again" button that resets the
// boundary state. We also write the error to `console.error` so DevTools
// shows it next to the stack.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional label shown above the error so the user knows which surface
   *  failed (e.g. "Preview crashed"). Defaults to "Something broke." */
  label?: string;
  /** Called whenever the boundary catches an error — handy for telemetry
   *  hooks in the future. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
  info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info });
    // Re-log so devtools shows the full stack — React's own logging
    // truncates aggressively in dev and entirely drops the stack in prod.
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", error, info.componentStack);
    this.props.onError?.(error, info);
  }

  private reset = (): void => {
    this.setState({ error: null, info: null });
  };

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const label = this.props.label ?? "Something broke.";
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg p-8 text-fg">
        <div className="max-w-2xl space-y-4">
          <h1 className="text-lg font-semibold text-danger">{label}</h1>
          <p className="text-sm text-fg-muted">
            A render error escaped to the app root. The screen would
            normally be blank here — this fallback exists so you can see
            the error and copy-paste it into a bug report.
          </p>
          <pre className="max-h-64 overflow-auto rounded border border-border-subtle bg-bg-inset p-3 text-xs">
            <code className="text-fg">
              {error.name}: {error.message}
              {"\n\n"}
              {error.stack ?? "(no JS stack)"}
              {info?.componentStack ? "\n\nComponent stack:" + info.componentStack : ""}
            </code>
          </pre>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={this.reset}
              className="rounded border border-border bg-bg-raised px-3 py-1.5 text-sm transition-colors hover:bg-bg-inset"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard
                  ?.writeText(
                    `${error.name}: ${error.message}\n${error.stack ?? ""}${info?.componentStack ?? ""}`,
                  )
                  .catch(() => {});
              }}
              className="rounded border border-border-subtle px-3 py-1.5 text-sm text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg"
            >
              Copy error
            </button>
          </div>
        </div>
      </div>
    );
  }
}
