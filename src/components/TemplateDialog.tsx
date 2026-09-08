// Template attach/change/clear dialog for an open project.
//
// Opened from the TopBar's "Template:" badge. Mounts the same picker
// the New Project dialog uses. A project can bind MULTIPLE templates
// — the first is the primary (drives render preset + defaults), the
// rest contribute behavioral guidance only.
//
// On submit we call `applyTemplates` (which rewrites project.json
// via the CLI) and re-open the project so the workspace sees the
// new bindings — the agent's next chat turn picks up the change
// because the system prompt is rebuilt per turn.

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { applyTemplates, listTemplates, openProject } from "../lib/tauri";
import type { TemplateMeta } from "../lib/types";
import { useApp } from "../lib/store";
import { TemplatePicker } from "./TemplatePicker";

interface Props {
  onClose: () => void;
}

export function TemplateDialog({ onClose }: Props) {
  const project = useApp((s) => s.project);
  const loadProject = useApp((s) => s.loadProject);
  const setError = useApp((s) => s.setError);

  // Initial list reads `template_ids` (current) with fallback to the
  // legacy single `template_id` so projects bound before this change
  // open cleanly.
  const initial = projectTemplateIds(project?.project);
  const [picked, setPicked] = useState<string[]>(initial);
  const [templates, setTemplates] = useState<TemplateMeta[]>([]);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    listTemplates()
      .then(setTemplates)
      .catch((e) =>
        setTemplatesError(e instanceof Error ? e.message : String(e)),
      );
  }, []);

  const dirty = JSON.stringify(picked) !== JSON.stringify(initial);

  async function onSubmit() {
    if (!project || submitting) return;
    setSubmitting(true);
    try {
      // overwriteDefaults: false → don't clobber a thoughtful
      // aspect/voice choice the user already made on this project.
      // Same posture as the previous TemplateDialog.
      await applyTemplates(project.project_dir, picked, false);
      const refreshed = await openProject(
        project.project_dir,
        project.current_video_id,
      );
      loadProject(refreshed);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (!project) return null;

  const submitLabel =
    picked.length === 0
      ? "Clear templates"
      : initial.length === 0
        ? "Attach templates"
        : "Update templates";

  return (
    <div
      role="dialog"
      aria-modal="true"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !submitting) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div className="w-full max-w-2xl rounded-lg border border-border bg-bg shadow-2xl">
        <header className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
          <h2 className="text-base font-medium">Project Templates</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded p-1 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg disabled:opacity-50"
            aria-label="Close"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </header>

        <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto px-5 py-4">
          <p className="text-xs text-fg-muted">
            Bind one or more templates to drive Claude's behavior. The
            first one is the <span className="text-fg">primary</span>
            {" "}— it controls the renderer's preset and default
            settings. Additional templates contribute editorial
            guidance only (their system prompts get concatenated into
            Claude's prompt). For example: a manhwa-reader platform
            producing chapter recaps could bind <span className="font-mono">
              manhwa-recap-single
            </span> as primary AND <span className="font-mono">product-demo</span>
            {" "}as secondary, so Claude treats every video as both a
            recap and a product showcase. Changes apply on the next
            chat turn — no restart needed.
          </p>
          <p className="text-xs text-fg-muted">
            Current:{" "}
            <span className="font-mono text-fg">
              {initial.length === 0 ? "(none)" : initial.join(" + ")}
            </span>
          </p>
          <TemplatePicker
            templates={templates}
            error={templatesError}
            values={picked}
            onChange={(next) => setPicked(next)}
          />
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded px-3 py-1.5 text-xs text-fg-subtle transition-colors hover:bg-bg-raised hover:text-fg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!dirty || submitting}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-bg transition-colors hover:bg-accent-hover disabled:bg-bg-raised disabled:text-fg-muted"
          >
            {submitting ? "Applying…" : submitLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Resolve the project's template bindings as an ordered list,
 *  preferring `template_ids` and falling back to the legacy single
 *  `template_id` for projects bound before multi-template landed. */
function projectTemplateIds(
  project: { template_ids?: string[]; template_id?: string } | undefined,
): string[] {
  if (!project) return [];
  if (project.template_ids && project.template_ids.length > 0) {
    return [...project.template_ids];
  }
  if (project.template_id) return [project.template_id];
  return [];
}
