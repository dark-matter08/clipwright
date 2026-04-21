import { useEffect, useState } from "react";
import { pickProject, loadProject, initProject, checkClaudeAuth } from "../lib/ipc";
import type { ProjectState } from "../lib/types";

export function ProjectPicker({ onOpened }: { onOpened: (s: ProjectState) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [auth, setAuth] = useState<{ ok: boolean; message: string } | null>(null);
  const [mode, setMode] = useState<"menu" | "new">("menu");

  useEffect(() => {
    checkClaudeAuth().then(setAuth).catch((e) => setAuth({ ok: false, message: String(e) }));
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

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6">
      <div className="text-center">
        <h1 className="font-mono text-4xl text-accent">CLIPWRIGHT</h1>
        <p className="mt-2 text-sm text-muted">// desktop refinement console</p>
      </div>

      {mode === "menu" ? (
        <div className="flex gap-3">
          <button
            className="rounded border border-border bg-panel px-6 py-3 font-mono text-sm hover:border-accent hover:text-accent"
            onClick={open}
          >
            OPEN PROJECT
          </button>
          <button
            className="rounded border border-border bg-panel px-6 py-3 font-mono text-sm hover:border-accent2 hover:text-accent2"
            onClick={() => {
              setError(null);
              setMode("new");
            }}
          >
            NEW PROJECT
          </button>
        </div>
      ) : (
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
      )}

      {error && <p className="max-w-md text-center text-sm text-accent2">{error}</p>}

      <div className="fixed bottom-4 right-4 rounded border border-border bg-panel px-3 py-2 text-xs font-mono">
        {auth === null ? (
          <span className="text-muted">checking claude cli…</span>
        ) : auth.ok ? (
          <span className="text-accent">● claude ready — {auth.message}</span>
        ) : (
          <span className="text-accent2">● claude unavailable — run `claude login`</span>
        )}
      </div>
    </div>
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
    <form onSubmit={submit} className="w-[480px] rounded border border-border bg-panel p-5 font-mono text-xs">
      <h2 className="text-sm text-accent2">// NEW PROJECT</h2>

      <label className="mt-4 block text-[11px] uppercase text-muted">parent directory</label>
      <div className="mt-1 flex gap-2">
        <input
          value={parent}
          readOnly
          placeholder="click PICK to choose…"
          className="flex-1 rounded border border-border bg-bg px-2 py-1 text-fg focus:outline-none"
        />
        <button
          type="button"
          onClick={pickParent}
          className="rounded border border-border px-3 py-1 hover:border-accent hover:text-accent"
        >
          PICK
        </button>
      </div>

      <label className="mt-3 block text-[11px] uppercase text-muted">project name</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="my-demo"
        className="mt-1 w-full rounded border border-border bg-bg px-2 py-1 text-fg focus:border-accent focus:outline-none"
      />

      <label className="mt-3 block text-[11px] uppercase text-muted">base url</label>
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        className="mt-1 w-full rounded border border-border bg-bg px-2 py-1 text-fg focus:border-accent focus:outline-none"
      />

      <label className="mt-3 block text-[11px] uppercase text-muted">
        description
        <span className="ml-2 normal-case text-muted">// what this demo shows — used as claude context</span>
      </label>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={4}
        placeholder="e.g. sign up, log in, add a title to library, read one chapter, test reader settings — PWA version"
        className="mt-1 w-full rounded border border-border bg-bg px-2 py-1 text-fg focus:border-accent focus:outline-none"
      />

      <label className="mt-3 block text-[11px] uppercase text-muted">aspect</label>
      <select
        value={aspect}
        onChange={(e) => setAspect(e.target.value)}
        className="mt-1 w-full rounded border border-border bg-bg px-2 py-1 text-fg focus:border-accent focus:outline-none"
      >
        <option value="9:16">9:16 (vertical)</option>
        <option value="16:9">16:9 (landscape)</option>
        <option value="1:1">1:1 (square)</option>
      </select>

      {parent && name && (
        <p className="mt-3 text-[10px] text-muted">
          → will scaffold <span className="text-fg">{parent}/{name}</span>
        </p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded border border-border px-3 py-1 text-muted hover:text-fg disabled:opacity-40"
        >
          CANCEL
        </button>
        <button
          type="submit"
          disabled={busy || !parent || !name}
          className="rounded border border-accent2 bg-accent2/10 px-3 py-1 text-accent2 hover:bg-accent2/20 disabled:opacity-40"
        >
          {busy ? "CREATING…" : "CREATE"}
        </button>
      </div>
    </form>
  );
}
