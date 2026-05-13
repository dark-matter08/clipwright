// Top bar — SRS §8.5.1.
// Breadcrumb (return to Hub), title (rename inline — P1.2), ⌘K, Render, Settings.

import { useState } from "react";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";
import { AddSourceDialog } from "./AddSourceDialog";
import { RenderDialog } from "./RenderDialog";

export function TopBar() {
  const project = useApp((s) => s.project);
  const closeProject = useApp((s) => s.closeProject);
  const toggleClaudeRail = useApp((s) => s.toggleClaudeRail);
  const railOpen = useApp((s) => s.claudeRailOpen);
  const [renderOpen, setRenderOpen] = useState(false);
  const [addSourceOpen, setAddSourceOpen] = useState(false);

  return (
    <header className="flex h-10 shrink-0 items-center justify-between border-b border-border-subtle bg-bg-subtle px-3">
      <nav className="flex items-center gap-2 text-sm">
        <button
          type="button"
          onClick={closeProject}
          className="rounded px-1.5 py-0.5 text-fg-subtle transition-colors hover:bg-bg-raised hover:text-fg"
        >
          ◀ Projects
        </button>
        <span className="text-fg-muted">·</span>
        <span className="font-medium text-fg">{project?.project.title || "Untitled"}</span>
      </nav>

      <div className="flex items-center gap-1">
        <TopBarButton
          label="+ Source"
          onClick={() => setAddSourceOpen(true)}
          title="Add another video to this project"
        />
        <TopBarButton
          label="⌘K"
          mono
          active={railOpen}
          onClick={toggleClaudeRail}
          title="Toggle Claude rail (⌘\\)"
        />
        <TopBarButton
          label="▶ Render"
          accent
          onClick={() => setRenderOpen(true)}
          title="Render final (out/final.mp4)"
        />
        <TopBarButton label="⚙" mono disabled title="Settings (P1.x)" />
      </div>
      {renderOpen && <RenderDialog onClose={() => setRenderOpen(false)} />}
      {addSourceOpen && <AddSourceDialog onClose={() => setAddSourceOpen(false)} />}
    </header>
  );
}

interface TopBarButtonProps {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  accent?: boolean;
  mono?: boolean;
  title?: string;
}

function TopBarButton(props: TopBarButtonProps) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      className={cn(
        "rounded px-2 py-1 text-xs transition-colors",
        props.mono && "font-mono",
        props.disabled && "cursor-not-allowed text-fg-muted",
        !props.disabled &&
          !props.accent &&
          !props.active &&
          "text-fg-subtle hover:bg-bg-raised hover:text-fg",
        !props.disabled && props.active && "bg-bg-raised text-fg",
        !props.disabled &&
          props.accent &&
          "bg-accent text-bg hover:bg-accent-hover active:bg-accent-press",
      )}
    >
      {props.label}
    </button>
  );
}
