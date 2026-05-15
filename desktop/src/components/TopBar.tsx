// Top bar — SRS §8.5.1.
// Breadcrumb (return to Hub), title (rename inline — P1.2), ⌘K, Render, Settings.

import { useEffect, useState } from "react";
import {
  ChevronLeft,
  MessageSquare,
  Play,
  Plus,
  Settings,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";
import { listTemplates } from "../lib/tauri";
import type { TemplateMeta } from "../lib/types";
import { AddSourceDialog } from "./AddSourceDialog";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";
import { RenderDialog } from "./RenderDialog";
import { TemplateDialog } from "./TemplateDialog";
import { ThemeToggle } from "./ThemeToggle";

export function TopBar() {
  const project = useApp((s) => s.project);
  const closeProject = useApp((s) => s.closeProject);
  const toggleClaudeRail = useApp((s) => s.toggleClaudeRail);
  const railOpen = useApp((s) => s.claudeRailOpen);
  const inspectorOpen = useApp((s) => s.inspectorOpen);
  const toggleInspector = useApp((s) => s.toggleInspector);
  const [renderOpen, setRenderOpen] = useState(false);
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [catalog, setCatalog] = useState<TemplateMeta[]>([]);

  // Resolve template bindings — prefer the multi-list, fall back to
  // the legacy single field. The first id is the primary; we render
  // its friendly name and append "+N" when secondary bindings exist
  // so the user can see at a glance whether the project is
  // multi-template.
  const templateIds =
    project?.project.template_ids && project.project.template_ids.length > 0
      ? project.project.template_ids
      : project?.project.template_id
        ? [project.project.template_id]
        : [];
  const primaryTemplateId = templateIds[0] ?? "";
  const primaryName =
    catalog.find((t) => t.template_id === primaryTemplateId)?.name ??
    primaryTemplateId;
  const extraCount = Math.max(0, templateIds.length - 1);

  // Cache the catalog once per project so the badge can render the
  // friendly template name (e.g. "Manhwa Recap — Single Chapter") instead
  // of the bare `manhwa-recap-single` id. We refetch whenever the bound
  // id changes so a newly-installed template's name resolves without an
  // app restart.
  useEffect(() => {
    if (!primaryTemplateId) return;
    let cancelled = false;
    listTemplates()
      .then((list) => {
        if (!cancelled) setCatalog(list);
      })
      .catch(() => {
        /* fall back to id-only label */
      });
    return () => {
      cancelled = true;
    };
  }, [primaryTemplateId]);

  return (
    <header className="flex h-10 shrink-0 items-center justify-between border-b border-border-subtle bg-bg-subtle px-3">
      <nav className="flex items-center gap-2 text-sm">
        <button
          type="button"
          onClick={closeProject}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-fg-subtle transition-colors hover:bg-bg-raised hover:text-fg"
          title="Back to projects"
        >
          <ChevronLeft size={14} strokeWidth={2} />
          Projects
        </button>
        <span className="text-fg-muted">·</span>
        <span className="font-medium text-fg">{project?.project.title || "Untitled"}</span>
      </nav>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setTemplateOpen(true)}
          title={
            templateIds.length === 0
              ? "Attach one or more project templates to guide Claude's behavior."
              : templateIds.length === 1
                ? `Template: ${primaryTemplateId}. Click to change.`
                : `Templates: ${templateIds.join(", ")} (primary first). Click to edit.`
          }
          className={cn(
            "flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
            primaryTemplateId
              ? "border border-accent/40 bg-accent/10 text-fg hover:bg-accent/15"
              : "text-fg-muted hover:bg-bg-raised hover:text-fg",
          )}
        >
          <Sparkles size={12} strokeWidth={2} />
          <span className="font-mono text-[10px] uppercase tracking-wider opacity-70">
            {templateIds.length > 1 ? "templates:" : "template:"}
          </span>{" "}
          {primaryTemplateId ? primaryName : "none"}
          {extraCount > 0 && (
            <span
              className="ml-1 rounded bg-accent/30 px-1 py-px font-mono text-[9px] uppercase tracking-wider text-accent"
              title={`Plus ${extraCount} secondary template${extraCount === 1 ? "" : "s"}`}
            >
              +{extraCount}
            </span>
          )}
        </button>
        <TopBarButton
          icon={<Plus size={12} strokeWidth={2} />}
          label="Source"
          onClick={() => setAddSourceOpen(true)}
          title="Add another video to this project"
        />
        <TopBarButton
          icon={<SlidersHorizontal size={12} strokeWidth={2} />}
          label="Inspect"
          active={inspectorOpen}
          onClick={toggleInspector}
          title="Toggle segment inspector drawer"
        />
        <TopBarButton
          icon={<MessageSquare size={12} strokeWidth={2} />}
          label="Claude"
          active={railOpen}
          onClick={toggleClaudeRail}
          title="Toggle Claude rail (⌘\\)"
        />
        <TopBarButton
          icon={<Play size={12} strokeWidth={2} fill="currentColor" />}
          label="Render"
          accent
          onClick={() => setRenderOpen(true)}
          title="Render final (out/final.mp4)"
        />
        <ThemeToggle />
        <TopBarButton
          icon={<Settings size={14} strokeWidth={2} />}
          label=""
          onClick={() => setSettingsOpen(true)}
          title="Project settings — script + outro"
        />
      </div>
      {renderOpen && <RenderDialog onClose={() => setRenderOpen(false)} />}
      {addSourceOpen && <AddSourceDialog onClose={() => setAddSourceOpen(false)} />}
      {templateOpen && <TemplateDialog onClose={() => setTemplateOpen(false)} />}
      {settingsOpen && <ProjectSettingsDialog onClose={() => setSettingsOpen(false)} />}
    </header>
  );
}

interface TopBarButtonProps {
  /** Leading icon — required for all buttons except the disabled
   *  settings placeholder. We accept ReactNode rather than a component
   *  ref so callers can pass `<Plus size={12} />` with their own
   *  size/stroke choices. */
  icon?: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  accent?: boolean;
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
        "flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
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
      {props.icon}
      {props.label}
    </button>
  );
}
