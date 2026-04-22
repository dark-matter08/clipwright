// Catches render-time exceptions in the center pane so a bad TimelineMode /
// ClipDetail render doesn't wipe the whole Workspace shell to a blank screen.

import { Component, type ReactNode } from "react";
import { I } from "../lib/icons";

interface Props {
  children: ReactNode;
  label?: string;
}

interface State {
  err: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: unknown) {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] caught", this.props.label ?? "", err, info);
  }

  reset = () => this.setState({ err: null });

  render() {
    if (!this.state.err) return this.props.children;
    const e = this.state.err;
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 overflow-auto bg-bg p-6 font-mono text-xs text-accent2">
        <I.AlertTriangle size={32} strokeWidth={1.25} />
        <div className="flex flex-col items-center gap-1">
          <span className="text-[10px] uppercase text-muted">
            {this.props.label ?? "render error"}
          </span>
          <span className="text-fg">{e.message}</span>
        </div>
        <pre className="max-h-64 max-w-full overflow-auto rounded border border-border bg-panel/40 p-3 text-[10px] leading-4 text-muted">
          {e.stack ?? String(e)}
        </pre>
        <button
          onClick={this.reset}
          className="flex items-center gap-1.5 rounded border border-border bg-panel px-3 py-1 text-[11px] uppercase text-muted hover:border-accent hover:text-accent"
        >
          <I.RefreshCw size={11} /> retry
        </button>
      </div>
    );
  }
}
