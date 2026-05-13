// Status bar — SRS §8.5.6 + §6.8 Doctor surface.
//
// Aggregates required-dependency health. Renders the worst status of all
// configured checks; clicking the indicator opens the Doctor panel
// (deferred — for now it's a tooltip-only indicator).

import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { claudeDoctor, clipwrightDoctor } from "../lib/tauri";
import { cn } from "../lib/cn";

type Health = "ok" | "warn" | "missing" | "loading";

interface Check {
  name: string;
  status: Health;
  detail: string | null;
}

export function StatusBar() {
  const project = useApp((s) => s.project);
  const past = useApp((s) => s.past.length);
  const future = useApp((s) => s.future.length);
  const segs = project?.timeline.segments.length ?? 0;
  const [checks, setChecks] = useState<Check[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([clipwrightDoctor(), claudeDoctor()]).then(([cw, cl]) => {
      if (cancelled) return;
      setChecks([
        {
          name: "clipwright",
          status: cw.installed ? "ok" : "missing",
          detail: cw.path,
        },
        {
          name: "claude",
          status: cl.installed ? "ok" : "warn",
          detail: cl.path,
        },
      ]);
    });
    return () => {
      cancelled = true;
    };
  }, [project?.project_dir]);

  const aggregate = aggregateHealth(checks);

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border-subtle bg-bg-subtle px-3 text-xs text-fg-muted">
      <span className="flex items-center gap-1">
        <span className="text-ok">⚡</span> ready
      </span>
      <span>·</span>
      <span>
        {segs} segment{segs === 1 ? "" : "s"}
      </span>
      <span>·</span>
      <span className="font-mono">saved</span>
      {(past > 0 || future > 0) && (
        <>
          <span>·</span>
          <span className="font-mono" title="Undo/redo stack depth">
            {past}↶ {future}↷
          </span>
        </>
      )}
      <span className="ml-auto flex items-center gap-3">
        <DoctorIndicator status={aggregate} checks={checks} />
        <span className="truncate font-mono" title={project?.project_dir}>
          {project?.project_dir ?? ""}
        </span>
      </span>
    </footer>
  );
}

function DoctorIndicator({ status, checks }: { status: Health; checks: Check[] }) {
  const symbol =
    status === "ok" ? "✓" :
    status === "warn" ? "⚠" :
    status === "missing" ? "✗" :
    "…";
  const color =
    status === "ok" ? "text-ok" :
    status === "warn" ? "text-warn" :
    status === "missing" ? "text-danger" :
    "text-fg-muted";
  const tooltip = checks
    .map((c) => `${c.name}: ${labelFor(c.status)}${c.detail ? ` (${c.detail})` : ""}`)
    .join("\n");
  return (
    <span title={tooltip} className="cursor-help">
      doctor: <span className={cn("font-medium", color)}>{symbol}</span>
    </span>
  );
}

function labelFor(s: Health): string {
  return s === "ok" ? "installed" : s === "warn" ? "missing (optional)" : s === "missing" ? "missing" : "checking…";
}

function aggregateHealth(checks: Check[]): Health {
  if (checks.length === 0) return "loading";
  if (checks.some((c) => c.status === "missing")) return "missing";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "ok";
}
