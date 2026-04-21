import { useState } from "react";
import type { VideoState } from "../lib/types";
import { createVideo, deleteVideo, renameVideo } from "../lib/ipc";

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
  onReload,
}: {
  projectPath: string;
  videos: VideoState[];
  activeSlug: string | null;
  onSelect: (slug: string) => void;
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
        className="flex items-center gap-1 overflow-x-auto border-b border-border bg-panel/60 px-2 py-1 font-mono text-[11px]"
        onClick={() => setMenu(null)}
      >
        {videos.map((v) => {
          const active = v.slug === activeSlug;
          return (
            <button
              key={v.slug}
              onClick={() => onSelect(v.slug)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ slug: v.slug, x: e.clientX, y: e.clientY });
              }}
              className={`flex items-center gap-2 rounded border px-2 py-1 whitespace-nowrap ${
                active
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border text-muted hover:border-accent hover:text-fg"
              }`}
            >
              <span>{v.title || v.slug}</span>
              <span className="text-[9px] opacity-70">▸ {v.phase}</span>
              {active && <span className="text-[9px] uppercase">current</span>}
            </button>
          );
        })}
        <button
          onClick={() => setModalOpen(true)}
          className="ml-1 rounded border border-dashed border-border px-2 py-1 text-muted hover:border-accent hover:text-accent"
        >
          + NEW VIDEO
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
            className="block w-full px-3 py-1.5 text-left font-mono text-[11px] hover:bg-accent/10"
          >
            rename
          </button>
          <button
            onClick={() => {
              const v = videos.find((x) => x.slug === menu.slug);
              handleDelete(menu.slug, !!v?.hasFinal);
              setMenu(null);
            }}
            className="block w-full px-3 py-1.5 text-left font-mono text-[11px] text-red-400 hover:bg-accent/10"
          >
            delete
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
            <h2 className="text-accent">NEW VIDEO</h2>
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
            {err && <p className="mt-3 text-xs text-red-400">{err}</p>}
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
