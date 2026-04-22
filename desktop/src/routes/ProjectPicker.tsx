import { useEffect, useState } from "react";
import {
  pickProject,
  loadProject,
  initProject,
  checkClaudeAuth,
  listKnownProjects,
  type KnownProject,
} from "../lib/ipc";
import type { ProjectState } from "../lib/types";
import { I } from "../lib/icons";

export function ProjectPicker({ onOpened }: { onOpened: (s: ProjectState) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [auth, setAuth] = useState<{ ok: boolean; message: string } | null>(null);
  const [mode, setMode] = useState<"menu" | "new">("menu");
  const [recents, setRecents] = useState<KnownProject[]>([]);

  useEffect(() => {
    checkClaudeAuth().then(setAuth).catch((e) => setAuth({ ok: false, message: String(e) }));
    listKnownProjects().then(setRecents).catch(() => setRecents([]));
  }, []);

  async function open() {
    setError(null);
    const path = await pickProject();
    if (!path) return;
    try {
      const state = await loadProject(path);
      onOpened(state);
    } catch (e) {
      setError(String(e));
    }
  }

  async function openByPath(path: string) {
    setError(null);
    try {
      const state = await loadProject(path);
      onOpened(state);
    } catch (e) {
      setError(String(e));
    }
  }

  if (mode === "new") {
    return (
      <NewProjectForm
        onCancel={() => setMode("menu")}
        onCreated={async (path) => {
          try {
            const state = await loadProject(path);
            onOpened(state);
          } catch (e) {
            setError(String(e));
            setMode("menu");
          }
        }}
        setError={setError}
      />
    );
  }

  return (
    <div className="relative flex w-full flex-col items-center gap-8 px-6 py-10 font-mono text-sm">
      {/* Hero */}
      <div className="text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-lg border border-accent/40 bg-accent/5 shadow-[0_0_40px_-12px_rgba(0,245,229,0.5)]">
          <I.Clapperboard size={40} className="text-accent" strokeWidth={1.25} />
        </div>
        <h1 className="mt-5 font-mono text-5xl tracking-[0.2em] text-accent">
          CLIPWRIGHT
        </h1>
        <p className="mt-2 font-mono text-xs uppercase tracking-widest text-muted">
          browser → tts → vertical in one run
        </p>
      </div>

      {/* Action cards */}
      <div className="grid w-full max-w-4xl grid-cols-3 gap-3">
        <ActionCard
          icon={<I.FolderPlus size={22} className="text-accent" />}
          title="New Project"
          subtitle="Spin up a fresh clipwright repo with a browse-plan template, assets, and a git-ready .clipwright.json"
          cta="CREATE"
          onClick={() => {
            setError(null);
            setMode("new");
          }}
          tone="accent"
        />
        <ActionCard
          icon={<I.FolderOpen size={22} className="text-accent" />}
          title="Open Folder"
          subtitle="Point to any folder with a .clipwright.json and clipwright takes it from there."
          cta="OPEN  ⌘O"
          onClick={open}
          tone="accent"
        />
        <ActionCard
          icon={<I.Download size={22} className="text-accent2" />}
          title="Clone from URL"
          subtitle="An existing clipwright repo from GitHub, hosted locally — nothing hidden here."
          cta="CLONE"
          onClick={() => setError("// clone-from-url is not wired yet — use `git clone` in a shell for now")}
          tone="accent2"
        />
      </div>

      {error && (
        <p className="flex max-w-xl items-center gap-2 rounded border border-accent2/40 bg-accent2/5 px-3 py-2 text-center text-xs text-accent2">
          <I.Zap size={12} />
          <span>{error}</span>
        </p>
      )}

      {/* Recents */}
      {recents.length > 0 && (
        <div className="w-full max-w-4xl">
          <div className="mb-2 flex items-center justify-between font-mono text-[11px] uppercase text-muted">
            <span className="flex items-center gap-1.5">
              <I.Clock size={11} className="text-accent/70" /> recent · sorted by last open
            </span>
            <span>{recents.length} projects</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {recents.slice(0, 8).map((p) => (
              <button
                key={p.path}
                onClick={() => p.exists && openByPath(p.path)}
                disabled={!p.exists}
                className="group flex items-center gap-3 rounded border border-border bg-panel/40 px-3 py-2 text-left hover:border-accent hover:bg-panel disabled:cursor-not-allowed disabled:opacity-40"
                title={p.path}
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-border bg-bg/60 font-mono text-[10px] uppercase text-muted group-hover:border-accent group-hover:text-accent">
                  {p.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs text-fg">{p.name}</div>
                  <div className="truncate font-mono text-[10px] text-muted">{p.path}</div>
                </div>
                {!p.exists && (
                  <span className="shrink-0 font-mono text-[10px] text-accent2">missing</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Status bar */}
      <div className="fixed bottom-4 right-4 flex items-center gap-2 rounded border border-border bg-panel px-3 py-2 font-mono text-xs">
        {auth === null ? (
          <>
            <I.Loader size={11} className="animate-spin text-muted" />
            <span className="text-muted">checking claude cli…</span>
          </>
        ) : auth.ok ? (
          <>
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
            <span className="text-accent">claude ready</span>
            <span className="text-muted/70">— {auth.message}</span>
          </>
        ) : (
          <>
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent2" />
            <span className="text-accent2">claude unavailable</span>
            <span className="text-muted/70">— run `claude login`</span>
          </>
        )}
      </div>
    </div>
  );
}

function ActionCard({
  icon,
  title,
  subtitle,
  cta,
  onClick,
  tone,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  cta: string;
  onClick: () => void;
  tone: "accent" | "accent2";
}) {
  const toneCls =
    tone === "accent"
      ? "hover:border-accent text-accent"
      : "hover:border-accent2 text-accent2";
  return (
    <button
      onClick={onClick}
      className={`group flex flex-col gap-3 rounded border border-border bg-panel/40 p-4 text-left transition-colors ${toneCls}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex h-10 w-10 items-center justify-center rounded border border-border bg-bg/60 group-hover:border-current">
          {icon}
        </div>
        <I.ChevronRight size={14} className="text-muted/70 group-hover:text-current" />
      </div>
      <div>
        <div className="font-mono text-base text-fg">{title}</div>
        <p className="mt-1 font-mono text-[11px] leading-relaxed text-muted">
          {subtitle}
        </p>
      </div>
      <div className="mt-auto font-mono text-[11px] tracking-wider">{cta}</div>
    </button>
  );
}

function NewProjectForm({
  onCancel,
  onCreated,
  setError,
}: {
  onCancel: () => void;
  onCreated: (path: string) => Promise<void>;
  setError: (s: string | null) => void;
}) {
  const [parent, setParent] = useState<string>("");
  const [name, setName] = useState<string>("");
  const [url, setUrl] = useState<string>("https://example.com");
  const [description, setDescription] = useState<string>("");
  const [aspect, setAspect] = useState<string>("9:16");
  const [busy, setBusy] = useState(false);

  async function pickParent() {
    const p = await pickProject();
    if (p) setParent(p);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!parent || !name) {
      setError("pick a parent directory and enter a project name");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const created = await initProject(parent, name, url, aspect, description);
      await onCreated(created);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mx-auto mt-10 w-[520px] rounded border border-border bg-panel p-5 font-mono text-xs"
    >
      <h2 className="flex items-center gap-2 text-sm text-accent2">
        <I.FolderPlus size={14} /> NEW PROJECT
      </h2>

      <label className="mt-4 block text-[11px] uppercase text-muted">parent directory</label>
      <div className="mt-1 flex gap-2">
        <input
          value={parent}
          readOnly
          placeholder="click PICK to choose…"
          className="flex-1 rounded border border-border bg-bg px-2 py-1.5 text-fg focus:outline-none"
        />
        <button
          type="button"
          onClick={pickParent}
          className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 hover:border-accent hover:text-accent"
        >
          <I.FolderOpen size={12} /> PICK
        </button>
      </div>

      <label className="mt-3 block text-[11px] uppercase text-muted">project name</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="my-demo"
        className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5 text-fg focus:border-accent focus:outline-none"
      />

      <label className="mt-3 flex items-center gap-1.5 text-[11px] uppercase text-muted">
        <I.Link size={11} /> base url
      </label>
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5 text-fg focus:border-accent focus:outline-none"
      />

      <label className="mt-3 block text-[11px] uppercase text-muted">
        description
        <span className="ml-2 normal-case text-muted/70">// used as claude context</span>
      </label>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={4}
        placeholder="e.g. sign up, log in, add a title to library, read one chapter, test reader settings — PWA version"
        className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5 text-fg focus:border-accent focus:outline-none"
      />

      <label className="mt-3 block text-[11px] uppercase text-muted">aspect</label>
      <div className="mt-1 grid grid-cols-3 gap-2">
        {[
          { value: "9:16", label: "9:16", note: "vertical" },
          { value: "16:9", label: "16:9", note: "landscape" },
          { value: "1:1", label: "1:1", note: "square" },
        ].map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setAspect(opt.value)}
            className={
              "rounded border px-2 py-1.5 text-center transition-colors " +
              (aspect === opt.value
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-muted hover:border-accent/50 hover:text-fg")
            }
          >
            <div className="text-[12px]">{opt.label}</div>
            <div className="text-[9px] uppercase text-muted">{opt.note}</div>
          </button>
        ))}
      </div>

      {parent && name && (
        <p className="mt-3 flex items-center gap-1 text-[10px] text-muted">
          <I.ChevronRight size={10} /> will scaffold{" "}
          <span className="text-fg">
            {parent}/{name}
          </span>
        </p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded border border-border px-3 py-1.5 text-muted hover:text-fg disabled:opacity-40"
        >
          CANCEL
        </button>
        <button
          type="submit"
          disabled={busy || !parent || !name}
          className="flex items-center gap-1.5 rounded border border-accent2 bg-accent2/10 px-3 py-1.5 text-accent2 hover:bg-accent2/20 disabled:opacity-40"
        >
          {busy ? (
            <>
              <I.Loader size={12} className="animate-spin" /> CREATING…
            </>
          ) : (
            <>
              <I.Sparkles size={12} /> CREATE
            </>
          )}
        </button>
      </div>
    </form>
  );
}
