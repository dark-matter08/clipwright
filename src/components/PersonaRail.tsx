// Persona rail — the library, the editor, memory, and the graph.
//
// Opened from the top bar and shaped like the Claude rail rather than a
// modal: tuning a voice is iterative, so you want the timeline and
// transcript still on screen, and you want it to stay open across turns
// to see whether the voice landed.
//
// Four tabs over one selected persona:
//
//   Library   every persona, with attach / clone / delete
//   Write     the six-block builder + composed prose
//   Voice     provider, voice, speed, pitch, provider-specific controls
//   Memory    what it has learned, plus the knowledge graph
//
// Personas are user-level and referenced by id, so "attach" writes
// `project.json#persona_id` and nothing else — editing the persona
// later changes every project using it, which is the point of a shared
// library.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  Drama,
  Loader2,
  Plus,
  Search,
  Telescope,
  Trash2,
  X,
} from "lucide-react";
import {
  EMPTY_PERSONA_VOICE,
  clonePersona,
  deletePersona,
  listPersonas,
  personaMemoryAdd,
  personaMemoryForget,
  personaMemoryList,
  savePersona,
  setProjectPersona,
  type MemoryEntry,
  type MemoryKind,
  type PersonaDoc,
} from "../lib/tauri";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";
import {
  EMPTY_PERSONA_DRAFT,
  PersonaBuilder,
  composePersona,
} from "./PersonaBuilder";
import { PersonaGraphView } from "./PersonaGraphView";
import { VoiceControls } from "./VoiceControls";

type Tab = "library" | "write" | "voice" | "memory";

/** Loaded into the Claude composer by "Derive from a reference".
 *
 *  Asks for the six builder blocks by name and in order so the reply
 *  pastes field-for-field, and demands observable detail rather than
 *  adjectives — "energetic" changes nothing about the output, "max 15
 *  words per sentence, never says 'furthermore'" does. */
const EXTRACTION_PROMPT = `I want to build a writing persona from a reference.

Below this line I'll paste a transcript from a channel whose voice I want to work in. (If I haven't pasted one yet, ask me for it and stop.)

Reverse-engineer its style and give me exactly these six blocks, each 1-3 sentences, concrete enough that following them changes the output:

1. **Who they are** — identity and expertise, completing "You are…".
2. **Voice & tone** — tense, register, rhythm.
3. **Structural rules** — what they do to a script, in order: how they open, how a beat is built, how they close.
4. **Vocabulary** — actual verbs and phrases they reach for, and actual words they never use. Quote real examples from the transcript.
5. **Pacing** — measured, not vibes: words per sentence, how runtime is spent, what gets compressed.
6. **Never does** — the failure mode this style deliberately avoids.

Rules: describe what's observably in the transcript, not what sounds flattering. No adjectives I can't act on ("engaging", "dynamic"). Don't write me a sample script — just the six blocks, so I can paste each into the persona builder.

---
`;

export function PersonaRail({ collapsed }: { collapsed: boolean }) {
  const project = useApp((s) => s.project);
  const loadProject = useApp((s) => s.loadProject);
  const setError = useApp((s) => s.setError);
  const toggle = useApp((s) => s.togglePersonaRail);
  const toggleClaudeRail = useApp((s) => s.toggleClaudeRail);
  const updateChatRuntime = useApp((s) => s.updateChatRuntime);

  const [tab, setTab] = useState<Tab>("library");
  const [personas, setPersonas] = useState<PersonaDoc[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draftDoc, setDraftDoc] = useState<PersonaDoc | null>(null);
  const [pristine, setPristine] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<"guided" | "custom">("guided");

  const attachedId = project?.project?.persona_id ?? "";
  const videoId = project?.video?.video_id ?? "";

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listPersonas();
      setPersonas(list);
      setSelectedId((cur) => cur || attachedId || list[0]?.persona_id || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [attachedId, setError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Track the selected persona as an editable copy.
  useEffect(() => {
    const found = personas.find((p) => p.persona_id === selectedId) ?? null;
    setDraftDoc(found ? structuredClone(found) : null);
    setPristine(found ? JSON.stringify(found) : "");
    if (found) {
      // Resume the builder in Guided only when the stored prose is still
      // what the fields compose to — otherwise it was hand-written and
      // Guided would overwrite it on the first keystroke.
      const composed = composePersona(found.draft ?? EMPTY_PERSONA_DRAFT).trim();
      const prose = (found.prose ?? "").trim();
      setMode(!prose || composed === prose ? "guided" : "custom");
    }
  }, [selectedId, personas]);

  const dirty = useMemo(
    () => !!draftDoc && JSON.stringify(draftDoc) !== pristine,
    [draftDoc, pristine],
  );

  async function onSave() {
    if (!draftDoc || saving || !dirty) return;
    setSaving(true);
    try {
      await savePersona(draftDoc);
      await refresh();
      setPristine(JSON.stringify(draftDoc));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function onCreate() {
    const id = `persona-${Date.now().toString(36)}`;
    const doc: PersonaDoc = {
      persona_id: id,
      name: "New persona",
      draft: { ...EMPTY_PERSONA_DRAFT },
      prose: "",
      voice: { ...EMPTY_PERSONA_VOICE },
      created_at: "",
      updated_at: "",
      cloned_from: "",
    };
    try {
      await savePersona(doc);
      await refresh();
      setSelectedId(id);
      setTab("write");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onClone(personaId: string, name: string) {
    try {
      const list = await clonePersona(personaId, `${name} (copy)`);
      setPersonas(list);
      // The library is newest-updated first, so the clone leads it.
      setSelectedId(list[0]?.persona_id ?? personaId);
      setTab("write");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onDelete(personaId: string) {
    try {
      await deletePersona(personaId);
      setSelectedId("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Bind this persona to the project. Live reference — we store the id
   *  and nothing else, so later edits reach this project automatically. */
  async function onAttach(personaId: string) {
    if (!project?.project_dir) return;
    try {
      await setProjectPersona(project.project_dir, personaId);
      loadProject({
        ...project,
        project: { ...project.project, persona_id: personaId },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function draftFromReference() {
    if (!videoId) return;
    updateChatRuntime(videoId, { draft: EXTRACTION_PROMPT });
    toggleClaudeRail();
  }

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggle}
        title="Open Persona panel"
        className="flex h-full w-full flex-col items-center justify-start gap-3 pt-3 text-fg-muted transition-colors hover:text-fg"
      >
        <Drama size={16} strokeWidth={1.75} />
        <span className="rotate-180 [writing-mode:vertical-rl] text-xs">Persona</span>
      </button>
    );
  }

  if (!project) return null;

  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-border-subtle px-3">
        <span className="text-xs font-medium uppercase tracking-wider text-fg-muted">
          Persona
        </span>
        <button
          type="button"
          onClick={toggle}
          title="Close Persona panel"
          aria-label="Close Persona panel"
          className="rounded p-1 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </header>

      <nav className="flex shrink-0 items-center gap-0.5 border-b border-border-subtle px-2 py-1.5">
        {(["library", "write", "voice", "memory"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            disabled={t !== "library" && !draftDoc}
            className={cn(
              "rounded px-2 py-0.5 text-[11px] capitalize transition-colors",
              tab === t ? "bg-accent/15 text-fg" : "text-fg-muted hover:text-fg",
              t !== "library" && !draftDoc && "cursor-not-allowed opacity-40",
            )}
          >
            {t}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {loading ? (
          <div className="flex items-center justify-center py-10 text-fg-muted">
            <Loader2 size={16} strokeWidth={2} className="mr-2 animate-spin" />
            Loading library…
          </div>
        ) : tab === "library" ? (
          <LibraryTab
            personas={personas}
            selectedId={selectedId}
            attachedId={attachedId}
            onSelect={(id) => {
              setSelectedId(id);
              setTab("write");
            }}
            onAttach={onAttach}
            onClone={onClone}
            onDelete={onDelete}
            onCreate={onCreate}
          />
        ) : !draftDoc ? null : tab === "write" ? (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-fg">Name</span>
              <input
                value={draftDoc.name}
                onChange={(e) =>
                  setDraftDoc({ ...draftDoc, name: e.target.value })
                }
                className="rounded border border-border-subtle bg-bg-inset px-2 py-1 text-sm text-fg focus:focus-ring"
              />
              <span className="font-mono text-[10px] text-fg-muted">
                {draftDoc.persona_id}
                {draftDoc.cloned_from && ` · cloned from ${draftDoc.cloned_from}`}
              </span>
            </label>

            <button
              type="button"
              onClick={draftFromReference}
              disabled={!videoId}
              title={
                videoId
                  ? "Load a prompt into the Claude composer that reverse-engineers a persona from a reference script"
                  : "Open a video first — the extraction runs in that video's chat"
              }
              className="flex w-full items-center gap-2 rounded border border-border-subtle px-2.5 py-2 text-left transition-colors hover:border-accent/50 hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Telescope size={14} strokeWidth={2} className="shrink-0 text-accent" />
              <span className="flex min-w-0 flex-col">
                <span className="text-xs font-medium text-fg">
                  Derive from a reference
                </span>
                <span className="text-[11px] text-fg-muted">
                  Paste a transcript — Claude extracts the voice into these fields.
                </span>
              </span>
            </button>

            <PersonaBuilder
              value={draftDoc.prose}
              draft={draftDoc.draft ?? EMPTY_PERSONA_DRAFT}
              onChange={({ persona, draft }) =>
                setDraftDoc((d) => (d ? { ...d, prose: persona, draft } : d))
              }
              mode={mode}
              onModeChange={setMode}
              hint="Who this persona is when it writes. Shared by every project that uses it."
            />
          </div>
        ) : tab === "voice" ? (
          <VoiceControls
            voice={draftDoc.voice ?? EMPTY_PERSONA_VOICE}
            onChange={(patch) =>
              setDraftDoc((d) =>
                d ? { ...d, voice: { ...d.voice, ...patch } } : d,
              )
            }
          />
        ) : (
          <MemoryTab personaId={draftDoc.persona_id} projectDir={project.project_dir} />
        )}
      </div>

      <footer className="flex shrink-0 items-center justify-between border-t border-border-subtle px-3 py-2">
        <span className="text-[11px] text-fg-muted">
          {dirty ? "Unsaved changes" : "Applies to every project using it"}
        </span>
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          className={cn(
            "flex items-center gap-1.5 rounded bg-accent px-3 py-1 text-xs font-medium text-bg transition-colors hover:bg-accent-hover focus:focus-ring",
            (!dirty || saving) && "cursor-not-allowed opacity-50",
          )}
        >
          {saving && <Loader2 size={12} strokeWidth={2.5} className="animate-spin" />}
          Save persona
        </button>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------

function LibraryTab({
  personas,
  selectedId,
  attachedId,
  onSelect,
  onAttach,
  onClone,
  onDelete,
  onCreate,
}: {
  personas: PersonaDoc[];
  selectedId: string;
  attachedId: string;
  onSelect: (id: string) => void;
  onAttach: (id: string) => void;
  onClone: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
}) {
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return personas;
    return personas.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.persona_id.toLowerCase().includes(q) ||
        (p.prose ?? "").toLowerCase().includes(q),
    );
  }, [personas, filter]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter personas…"
          className="min-w-0 flex-1 rounded border border-border-subtle bg-bg-inset px-2 py-1 text-xs text-fg placeholder:text-fg-muted focus:focus-ring"
        />
        <button
          type="button"
          onClick={onCreate}
          title="New persona"
          className="flex shrink-0 items-center gap-1 rounded border border-border-subtle px-2 py-1 text-[11px] text-fg-subtle transition-colors hover:border-accent/50 hover:text-fg"
        >
          <Plus size={11} strokeWidth={2} />
          New
        </button>
      </div>

      {shown.length === 0 && (
        <p className="px-1 py-2 text-[11px] text-fg-muted">
          {personas.length === 0
            ? "No personas yet. Create one, or derive it from a reference transcript in the Write tab."
            : `No personas match "${filter}".`}
        </p>
      )}

      {shown.map((p) => {
        const attached = p.persona_id === attachedId;
        return (
          <div
            key={p.persona_id}
            className={cn(
              "flex flex-col gap-1 rounded border px-2.5 py-2 transition-colors",
              p.persona_id === selectedId
                ? "border-accent/50 bg-accent/10"
                : "border-border-subtle hover:bg-bg-raised",
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(p.persona_id)}
              className="flex min-w-0 flex-col items-start text-left"
            >
              <span className="flex w-full items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                  {p.name}
                </span>
                {attached && (
                  <span className="flex shrink-0 items-center gap-0.5 rounded bg-accent/20 px-1 py-px font-mono text-[9px] uppercase text-accent">
                    <Check size={8} strokeWidth={3} />
                    in use
                  </span>
                )}
              </span>
              <span className="w-full truncate font-mono text-[10px] text-fg-muted">
                {p.voice?.provider ?? "kokoro"} · {p.voice?.voice_id || "default"}
                {p.cloned_from && ` · from ${p.cloned_from}`}
              </span>
            </button>
            <div className="flex items-center gap-1">
              {!attached && (
                <MiniBtn label="Use in project" onClick={() => onAttach(p.persona_id)} />
              )}
              <MiniBtn
                icon={<Copy size={10} strokeWidth={2} />}
                label="Clone"
                title="Copy the definition and voice under a new id. Memory is not copied."
                onClick={() => onClone(p.persona_id, p.name)}
              />
              <MiniBtn
                icon={<Trash2 size={10} strokeWidth={2} />}
                label="Delete"
                danger
                onClick={() => onDelete(p.persona_id)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MiniBtn({
  icon,
  label,
  onClick,
  danger,
  title,
}: {
  icon?: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      className={cn(
        "flex items-center gap-1 rounded border border-border-subtle px-1.5 py-0.5 text-[10px] transition-colors",
        danger
          ? "text-fg-muted hover:border-warn/50 hover:text-warn"
          : "text-fg-subtle hover:border-accent/50 hover:text-fg",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------

const KIND_LABEL: Record<MemoryKind, string> = {
  note: "Note you wrote",
  edit: "Correction to its output",
  reference: "Style from a reference",
  video: "Video it produced",
};

function MemoryTab({
  personaId,
  projectDir,
}: {
  personaId: string;
  projectDir: string;
}) {
  const setError = useApp((s) => s.setError);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");
  const [query, setQuery] = useState("");
  const [showGraph, setShowGraph] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await personaMemoryList(personaId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [personaId, setError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addNote() {
    if (!note.trim()) return;
    try {
      await personaMemoryAdd({
        persona_id: personaId,
        kind: "note",
        body: note.trim(),
        source: projectDir,
      });
      setNote("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) => e.body.toLowerCase().includes(q) || e.title.toLowerCase().includes(q),
    );
  }, [entries, query]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setShowGraph((v) => !v)}
          className={cn(
            "rounded border px-2 py-0.5 text-[11px] transition-colors",
            showGraph
              ? "border-accent/50 bg-accent/10 text-fg"
              : "border-border-subtle text-fg-subtle hover:text-fg",
          )}
        >
          {showGraph ? "Show list" : "Show graph"}
        </button>
        <span className="text-[11px] text-fg-muted">{entries.length} entries</span>
      </div>

      {showGraph ? (
        <div className="h-[420px]">
          <PersonaGraphView personaId={personaId} />
        </div>
      ) : (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-fg">Teach it something</span>
            <span className="text-[11px] text-fg-muted">
              A rule it should keep. Highest trust of anything in memory — it
              outranks what the persona infers from its own work.
            </span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Never open a recap on a wide establishing shot."
              className="mt-0.5 w-full resize-y rounded border border-border-subtle bg-bg-inset px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted focus:focus-ring"
            />
            <button
              type="button"
              onClick={addNote}
              disabled={!note.trim()}
              className="self-end rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-bg transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              Remember
            </button>
          </label>

          <div className="flex items-center gap-1.5 border-t border-border-subtle pt-2">
            <Search size={12} strokeWidth={2} className="shrink-0 text-fg-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter memory…"
              className="min-w-0 flex-1 rounded border border-border-subtle bg-bg-inset px-2 py-1 text-xs text-fg placeholder:text-fg-muted focus:focus-ring"
            />
          </div>

          {loading ? (
            <div className="flex items-center gap-2 py-4 text-[11px] text-fg-muted">
              <Loader2 size={12} strokeWidth={2} className="animate-spin" />
              Loading memory…
            </div>
          ) : shown.length === 0 ? (
            <p className="py-2 text-[11px] text-fg-muted">
              {entries.length === 0
                ? "Nothing learned yet. Write a note above, or let it learn from the videos it renders and the corrections you make."
                : "No entries match."}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {shown.map((e) => (
                <li
                  key={e.id}
                  className="group flex flex-col gap-0.5 rounded border border-border-subtle bg-bg-inset px-2.5 py-1.5"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[9px] uppercase tracking-wider text-accent">
                      {KIND_LABEL[e.kind] ?? e.kind}
                    </span>
                    <button
                      type="button"
                      onClick={async () => {
                        await personaMemoryForget(e.id);
                        await load();
                      }}
                      title="Forget this"
                      className="rounded p-0.5 text-fg-muted opacity-0 transition-opacity hover:text-warn group-hover:opacity-100"
                    >
                      <Trash2 size={11} strokeWidth={2} />
                    </button>
                  </span>
                  {e.title && (
                    <span className="text-xs font-medium text-fg">{e.title}</span>
                  )}
                  <span className="text-[11px] text-fg-subtle">{e.body}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
