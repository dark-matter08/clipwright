import { useState } from "react";
import type { VideoState } from "../lib/types";
import { createVideo, deleteVideo, renameVideo } from "../lib/ipc";
import { I } from "../lib/icons";

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "untitled";
}

export function VideoRail({
  projectPath,
  videos,
  activeSlug,
  onSelect,
  onEdit,
  onReload,
}: {
  projectPath: string;
  videos: VideoState[];
  activeSlug: string | null;
  onSelect: (slug: string) => void;
  /** Click the pencil glyph on a tab: selects that video AND flips Workspace
   *  into timeline mode. Gated on hasSegments — the glyph is hidden otherwise. */
  onEdit?: (slug: string) => void;
  onReload: () => Promise<void>;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [fromSlug, setFromSlug] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ slug: string; x: number; y: number } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const effectiveSlug = slug.trim() || slugify(title);
      await createVideo(projectPath, effectiveSlug, title.trim() || effectiveSlug, fromSlug || undefined);
      await onReload();
      onSelect(effectiveSlug);
      setModalOpen(false);
      setTitle("");
      setSlug("");
      setFromSlug("");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleRename(oldSlug: string) {
    const next = prompt(`rename ${oldSlug} →`, oldSlug);
    if (!next || next === oldSlug) return;
    try {
      await renameVideo(projectPath, oldSlug, slugify(next));
      await onReload();
    } catch (e) {
      alert(String(e));
    }
  }

  async function handleDelete(s: string, hasFinal: boolean) {
    const msg = hasFinal
      ? `delete ${s}? final.mp4 exists — this uses --force`
      : `delete ${s}?`;
    if (!confirm(msg)) return;
    try {
      await deleteVideo(projectPath, s, hasFinal);
      await onReload();
    } catch (e) {
      alert(String(e));
    }
  }

  return (
    <>
      <div
        className="flex items-center gap-1 overflow-x-auto border-b border-border bg-panel/60 px-2 pt-1 font-mono text-[11px]"
        onClick={() => setMenu(null)}
      >
        {videos.map((v) => {
          const active = v.slug === activeSlug;
          const canEdit = !!onEdit && v.hasSegments;
          return (
            <div
              key={v.slug}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ slug: v.slug, x: e.clientX, y: e.clientY });
              }}
              className={`group flex items-center gap-1 rounded-t border-x border-t px-1 py-0 -mb-px whitespace-nowrap transition-colors ${
                active
                  ? "border-border border-b-bg bg-bg text-fg"
                  : "border-transparent text-muted hover:bg-panel hover:text-fg"
              }`}
            >
              <button
                onClick={() => onSelect(v.slug)}
                className="flex items-center gap-2 py-1.5 pl-1.5 pr-1"
              >
                {active ? (
                  <I.Clapperboard size={13} className="text-accent" />
                ) : (
                  <I.Film size={13} className="text-accent/60" />
                )}
                <span className="max-w-[18ch] truncate">{v.title || v.slug}</span>
                <span
                  className={`rounded px-1 text-[9px] uppercase ${
                    active ? "bg-accent/10 text-accent" : "text-muted/80"
                  }`}
                >
                  {v.phase}
                </span>
              </button>
              {canEdit && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit!(v.slug);
                  }}
                  title="Open in timeline editor"
                  className="flex items-center justify-center rounded px-1 py-0.5 text-muted/60 opacity-0 transition-opacity hover:text-accent2 group-hover:opacity-100 data-[active=true]:opacity-100"
                  data-active={active}
                >
                  <I.Pencil size={11} />
                </button>
              )}
            </div>
          );
        })}
        <button
          onClick={() => setModalOpen(true)}
          className="ml-1 flex items-center gap-1 rounded border border-dashed border-border px-2 py-1 text-muted hover:border-accent hover:text-accent"
        >
          <I.Plus size={12} />
          <span>NEW VIDEO</span>
        </button>
      </div>

      {menu && (
        <div
          className="fixed z-50 rounded border border-border bg-panel shadow-lg"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            onClick={() => {
              handleRename(menu.slug);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11px] hover:bg-accent/10"
          >
            <I.Pencil size={12} /> rename
          </button>
          <button
            onClick={() => {
              const v = videos.find((x) => x.slug === menu.slug);
              handleDelete(menu.slug, !!v?.hasFinal);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11px] text-accent2 hover:bg-accent2/10"
          >
            <I.Trash size={12} /> delete
          </button>
        </div>
      )}

      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setModalOpen(false)}
        >
          <form
            onSubmit={submit}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded border border-border bg-bg p-4 font-mono text-sm"
          >
            <h2 className="flex items-center gap-2 text-accent">
              <I.Clapperboard size={16} /> NEW VIDEO
            </h2>
            <label className="mt-3 block text-[11px] uppercase text-muted">title</label>
            <input
              autoFocus
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                if (!slug) setSlug(slugify(e.target.value));
              }}
              className="mt-1 w-full rounded border border-border bg-panel p-2 focus:border-accent focus:outline-none"
            />
            <label className="mt-3 block text-[11px] uppercase text-muted">slug</label>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="auto from title"
              className="mt-1 w-full rounded border border-border bg-panel p-2 focus:border-accent focus:outline-none"
            />
            {videos.length > 0 && (
              <>
                <label className="mt-3 block text-[11px] uppercase text-muted">copy from (optional)</label>
                <select
                  value={fromSlug}
                  onChange={(e) => setFromSlug(e.target.value)}
                  className="mt-1 w-full rounded border border-border bg-panel p-2"
                >
                  <option value="">— blank —</option>
                  {videos.map((v) => (
                    <option key={v.slug} value={v.slug}>
                      {v.title || v.slug}
                    </option>
                  ))}
                </select>
              </>
            )}
            {err && <p className="mt-3 text-xs text-accent2">{err}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded border border-border px-3 py-1 text-xs text-muted hover:text-fg"
              >
                CANCEL
              </button>
              <button
                type="submit"
                disabled={busy || (!title.trim() && !slug.trim())}
                className="rounded border border-accent bg-accent/10 px-3 py-1 text-xs text-accent hover:bg-accent/20 disabled:opacity-40"
              >
                {busy ? "…" : "CREATE"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
