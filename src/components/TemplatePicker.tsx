// Project-template picker — multi-select.
//
// A project can bind multiple templates simultaneously. The first
// entry in the list is the **primary** — it drives `render_preset`
// selection and default project settings. Additional entries
// contribute behavioral guidance only (their system prompts are
// appended to the agent prompt).
//
// Why multi: consider a manhwa-reader platform producing chapter
// recaps. The user wants `manhwa-recap-single` (primary, drives the
// panel-based Remotion preset) AND `product-demo` (secondary, so
// Claude also frames the deliverable as product marketing). Either
// template alone misses half the intent; both together give the
// right output.
//
// Each card has a checkbox. The currently-primary card shows a
// "primary" badge; selected-but-not-primary cards show a "make
// primary" button so the user can promote without rebuilding the
// whole selection.

import { useEffect, useState } from "react";
import { Star, StarOff } from "lucide-react";
import { listTemplates, showTemplate } from "../lib/tauri";
import type { TemplateFull, TemplateMeta } from "../lib/types";
import { cn } from "../lib/cn";

interface TemplatePickerProps {
  /** Pre-loaded catalog. If absent, the picker fetches it itself. */
  templates?: TemplateMeta[];
  /** Currently-selected template ids in order. First = primary.
   *  Pass `[]` for "no templates bound". */
  values: string[];
  /** Called with the next list of selected ids in order. */
  onChange: (next: string[], metas: TemplateMeta[]) => void;
  /** Compact mode for the TopBar — smaller cards, no preview pane. */
  compact?: boolean;
  /** Load failure from a parent that fetched the catalog itself.
   *  Parents that pass `templates` bypass this component's own fetch
   *  (and therefore its error branch), so they must forward the
   *  failure here — otherwise a broken `clipwright` install renders as
   *  an empty picker with no explanation. */
  error?: string | null;
}

export function TemplatePicker({
  templates: providedTemplates,
  values,
  onChange,
  compact,
  error: providedError,
}: TemplatePickerProps) {
  const [templates, setTemplates] = useState<TemplateMeta[] | null>(
    providedTemplates ?? null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (providedTemplates) {
      setTemplates(providedTemplates);
      return;
    }
    let cancelled = false;
    listTemplates()
      .then((list) => {
        if (!cancelled) setTemplates(list);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [providedTemplates]);

  const err = providedError ?? loadError;
  if (err) {
    return (
      <p className="rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-xs text-warn">
        Couldn't load templates: {err}
      </p>
    );
  }
  if (templates == null) {
    return <p className="text-xs text-fg-muted">Loading templates…</p>;
  }
  if (templates.length === 0) {
    // Distinct from the error case: the CLI answered, it just had
    // nothing to offer. Without this the dialog renders a blank space
    // under "Choose at least one template" and looks broken.
    return (
      <p className="rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-xs text-warn">
        No templates found. Check that <code>clipwright templates list</code>{" "}
        works in a terminal.
      </p>
    );
  }

  function commit(nextIds: string[]) {
    const metasById = new Map(templates!.map((t) => [t.template_id, t]));
    const metas = nextIds
      .map((id) => metasById.get(id))
      .filter((m): m is TemplateMeta => m != null);
    onChange(nextIds, metas);
  }

  function toggle(id: string) {
    if (values.includes(id)) {
      commit(values.filter((x) => x !== id));
    } else {
      commit([...values, id]);
    }
  }

  function makePrimary(id: string) {
    // Move `id` to the front of `values`, preserving the order of
    // everything else. We don't remove other entries — secondary
    // bindings stay bound; we just swap which one drives the
    // renderer.
    if (!values.includes(id)) return;
    commit([id, ...values.filter((x) => x !== id)]);
  }

  function clearAll() {
    commit([]);
  }

  // Group by category so a long catalog stays scannable.
  const byCategory = new Map<string, TemplateMeta[]>();
  for (const t of templates) {
    const k = t.category || "other";
    const list = byCategory.get(k) ?? [];
    list.push(t);
    byCategory.set(k, list);
  }
  const categories = Array.from(byCategory.keys()).sort();
  const primaryId = values[0] ?? "";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-[11px] text-fg-muted">
        <span>
          {values.length === 0
            ? "No templates selected — pick one or more below."
            : values.length === 1
              ? "1 template selected (primary)."
              : `${values.length} templates selected. The first one (★) is the primary.`}
        </span>
        {values.length > 0 && (
          <button
            type="button"
            onClick={clearAll}
            className="ml-auto rounded px-2 py-0.5 text-[10px] text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg"
          >
            Clear all
          </button>
        )}
      </div>
      {categories.map((cat) => (
        <div key={cat} className="flex flex-col gap-1.5">
          <div className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
            {cat}
          </div>
          <div
            className={cn(
              "grid gap-1.5",
              compact ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2",
            )}
          >
            {(byCategory.get(cat) ?? []).map((t) => (
              <TemplateCard
                key={t.template_id}
                meta={t}
                selected={values.includes(t.template_id)}
                isPrimary={t.template_id === primaryId}
                compact={compact}
                onToggle={() => toggle(t.template_id)}
                onMakePrimary={() => makePrimary(t.template_id)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function TemplateCard({
  meta,
  selected,
  isPrimary,
  compact,
  onToggle,
  onMakePrimary,
}: {
  meta: TemplateMeta;
  selected: boolean;
  isPrimary: boolean;
  compact?: boolean;
  onToggle: () => void;
  onMakePrimary: () => void;
}) {
  const [preview, setPreview] = useState<TemplateFull | null>(null);
  const [open, setOpen] = useState(false);

  async function togglePreview(e: React.MouseEvent) {
    e.stopPropagation();
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (preview) return;
    try {
      const full = await showTemplate(meta.template_id);
      setPreview(full);
    } catch {
      /* preview is best-effort */
    }
  }

  return (
    <div
      className={cn(
        "rounded border transition-colors",
        selected
          ? isPrimary
            ? "border-accent bg-accent/10"
            : "border-accent/50 bg-accent/5"
          : "border-border-subtle bg-bg hover:border-accent/50",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-2.5 py-2 text-left"
      >
        <div className="flex items-start justify-between gap-2">
          <div
            className={cn(
              "font-medium text-fg",
              compact ? "text-xs" : "text-sm",
            )}
          >
            {meta.name}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {isPrimary && (
              <span
                title="Primary — drives render preset and default settings."
                className="flex items-center gap-0.5 rounded bg-accent/20 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-accent"
              >
                <Star size={9} strokeWidth={2.5} fill="currentColor" />
                primary
              </span>
            )}
            {meta.source === "user" && (
              <span
                className="shrink-0 rounded bg-accent/20 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-accent"
                title="Lives under ~/.clipwright/templates/ — yours to edit."
              >
                user
              </span>
            )}
          </div>
        </div>
        <div
          className={cn(
            "mt-0.5 text-fg-muted",
            compact ? "text-[10px]" : "text-[11px]",
          )}
        >
          {meta.summary}
        </div>
      </button>
      {!compact && (
        <div className="flex items-center justify-between border-t border-border-subtle px-2.5 py-1">
          <span className="font-mono text-[10px] text-fg-muted">
            {meta.template_id}
          </span>
          <div className="flex items-center gap-2">
            {selected && !isPrimary && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onMakePrimary();
                }}
                title="Make this the primary template (drives render preset + defaults)."
                className="flex items-center gap-0.5 text-[10px] text-fg-muted underline-offset-2 transition-colors hover:text-fg hover:underline"
              >
                <StarOff size={9} strokeWidth={2} />
                make primary
              </button>
            )}
            <button
              type="button"
              onClick={togglePreview}
              className="text-[10px] text-fg-muted underline-offset-2 transition-colors hover:text-fg hover:underline"
            >
              {open ? "hide prompt" : "see prompt"}
            </button>
          </div>
        </div>
      )}
      {open && preview && (
        <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap border-t border-border-subtle bg-bg-inset px-2.5 py-2 text-[11px] text-fg-subtle">
          {preview.system_prompt}
        </pre>
      )}
    </div>
  );
}
