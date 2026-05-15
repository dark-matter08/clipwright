// Claude rail — SRS §8.5.5 + §9.
//
// Mode A: persistent chat. Each turn invokes `claude --print --continue`
//         under the project directory, with the project-scoped system
//         prompt from `clipwright agent prompt`.
//
// Mode B: per-segment scoped invocation, triggered by the timeline's
//         "Ask Claude…" context menu item. We surface the active segment
//         id under the input so the user always knows what's in scope.
//
// History is persisted to `<project>/chat/sessions/<date>.jsonl` by Rust
// so the UI can repopulate on app restart.

import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ChevronRight,
  MessageSquare,
  RotateCcw,
  Slash,
  Square,
  Wrench,
  X,
} from "lucide-react";
import {
  cancelClaudeChat,
  claudeChat,
  claudeDoctor,
  clearClaudeSession,
  getIdleTimeoutSeconds,
  getModel,
  getPermissionMode,
  listSkills,
  listSlashCommands,
  loadChatHistory,
  openProject,
  runClipwrightCommand,
  type CommandResult,
  setIdleTimeoutSeconds,
  setModel,
  setPermissionMode,
  type ChatHistoryEntry,
  type PermissionMode,
  type Skill,
  type SlashCommand,
} from "../lib/tauri";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";
import { Dropdown } from "./Dropdown";
import { MarkdownView } from "./MarkdownView";
import { parseAskBlocks, QuestionCard } from "./QuestionCard";

interface ClaudeRailProps {
  collapsed: boolean;
}

export function ClaudeRail({ collapsed }: ClaudeRailProps) {
  const project = useApp((s) => s.project);
  const toggle = useApp((s) => s.toggleClaudeRail);
  const setError = useApp((s) => s.setError);
  const askSegId = useApp((s) => s.pendingAskSegmentId);
  const clearAsk = useApp((s) => s.clearPendingAsk);
  const loadProject = useApp((s) => s.loadProject);

  const [history, setHistory] = useState<ChatHistoryEntry[]>([]);
  const [pending, setPending] = useState<{ role: "user"; text: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyStartedAt, setBusyStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [permMode, setPermMode] = useState<PermissionMode>("acceptEdits");
  // Raw idle-timeout seconds from `claude-timeout.json#idle_seconds`:
  //   * 0  → backend default (2m)
  //   * -1 → watchdog off (wall-clock only)
  //   * N  → N seconds
  // The picker below maps to the preset menu.
  const [idleSeconds, setIdleSeconds] = useState<number>(0);

  // Slash-command autocomplete state. Loaded once per project from
  // `list_slash_commands` (cheap filesystem walk). The popover opens
  // when the draft starts with "/" and there's at least one matching
  // command. Index = the currently-highlighted suggestion (Arrow keys
  // move it; Enter/Tab accepts).
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  // Empty string = "CLI default" — the user's claude config picks.
  const [model, setModelState] = useState<string>("");
  // Live stream state — built up from `claude:turn` Tauri events while
  // the chat is in flight. Cleared on completion. The accumulated text
  // is what the user sees grow in real time; the trail of tool uses is
  // shown as small "🔧 running clipwright record" indicators so they
  // know Claude is actively working, not stuck.
  const [streamText, setStreamText] = useState("");
  const [streamTools, setStreamTools] = useState<StreamToolUse[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Pull the persisted permission mode whenever the project changes. It's
  // a per-project setting so different videos in the same project share
  // it, but two different projects can disagree.
  useEffect(() => {
    if (!project?.project_dir) return;
    getPermissionMode(project.project_dir)
      .then(setPermMode)
      .catch(() => setPermMode("acceptEdits"));
    getModel(project.project_dir)
      .then(setModelState)
      .catch(() => setModelState(""));
    getIdleTimeoutSeconds(project.project_dir)
      .then(setIdleSeconds)
      .catch(() => setIdleSeconds(0));
    listSlashCommands(project.project_dir)
      .then(setSlashCommands)
      .catch(() => setSlashCommands([]));
    listSkills(project.project_dir)
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [project?.project_dir]);

  async function onChangePermMode(mode: PermissionMode) {
    if (!project?.project_dir) return;
    setPermMode(mode);
    try {
      await setPermissionMode(project.project_dir, mode);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onChangeIdleTimeout(seconds: number) {
    if (!project?.project_dir) return;
    // Optimistic update — revert silently isn't worth the churn for a
    // tiny persistence call. If it fails the toast tells the user and
    // they can retry; the next project-open round-trip will resync.
    setIdleSeconds(seconds);
    try {
      await setIdleTimeoutSeconds(project.project_dir, seconds);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onChangeModel(next: string) {
    if (!project?.project_dir) return;
    setModelState(next);
    try {
      await setModel(project.project_dir, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Play-button handler for runnable code blocks in assistant bubbles.
  // The MarkdownView walks fenced `bash` blocks, detects clipwright
  // commands, and renders a Play button — clicking it routes here.
  //
  // We do TWO things on success:
  //   1. Return the CommandResult so the bubble can show stdout +
  //      stderr inline.
  //   2. Refresh the project state from disk — the command may have
  //      rendered a final, regenerated TTS, edited a manifest, etc.
  //      Mirrors the post-turn refresh in `send()` so the UI never
  //      diverges from disk after a Play.
  //
  // Failures throw — MarkdownView's RunnableCodeBlock catches and
  // shows the error inline.
  async function onRunCommand(command: string): Promise<CommandResult> {
    if (!project?.project_dir) {
      throw new Error("no project loaded");
    }
    const res = await runClipwrightCommand(project.project_dir, command);
    // Refresh project state regardless of exit code — a failed render
    // can still leave partial artifacts on disk (e.g. a stale segment
    // cache, an updated stale-token). The UI should reflect them.
    try {
      const fresh = await openProject(
        project.project_dir,
        project.current_video_id,
      );
      loadProject(fresh);
    } catch {
      // Same rationale as the post-turn refresh: a transient refresh
      // miss shouldn't pile on top of whatever the user's looking at.
    }
    return res;
  }

  // Tick the elapsed-time counter every second while a chat is in flight.
  // Plain `setInterval` is fine — we tear it down via the cleanup, and a
  // one-second cadence is cheap.
  useEffect(() => {
    if (!busy || busyStartedAt == null) {
      setElapsed(0);
      return;
    }
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - busyStartedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [busy, busyStartedAt]);

  useEffect(() => {
    claudeDoctor().then((r) => setInstalled(r.installed)).catch(() => setInstalled(false));
  }, []);

  // Subscribe to `claude:turn` events emitted by the streaming Rust
  // runner. Each event is one parsed line from `claude --output-format
  // stream-json`, scoped to a video_id. We pattern-match on
  // `payload.type` to grow the live assistant bubble.
  //
  // The listener is global (no per-render churn), but only events for
  // the currently-loaded video are surfaced — that way a chat in
  // chapter-2 doesn't pollute chapter-1's rail when the user switches.
  useEffect(() => {
    const currentVideoId = project?.video?.video_id;
    if (!currentVideoId) return;
    let cancelled = false;
    const unlisten = listen<ClaudeStreamEvent>("claude:turn", (e) => {
      if (cancelled) return;
      const { video_id, payload } = e.payload;
      if (video_id !== currentVideoId) return;
      applyStreamEvent(payload, setStreamText, setStreamTools);
    });
    return () => {
      cancelled = true;
      void unlisten.then((un) => un());
    };
  }, [project?.video?.video_id]);

  useEffect(() => {
    if (!project?.video) {
      setHistory([]);
      return;
    }
    loadChatHistory(project.project_dir, project.video.video_id)
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [project?.project_dir, project?.video?.video_id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [history.length, pending, busy]);

  async function onFreshChat() {
    if (!project?.video) return;
    try {
      await clearClaudeSession(project.project_dir, project.video.video_id);
      setHistory([]);
      setPending(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function send(override?: string) {
    if (!project?.video) return;
    const message = (override ?? draft).trim();
    if (!message) return;
    // Locally-handled slash commands. We intercept before the CLI
    // because the rail in --print mode wouldn't do anything useful
    // with them — `/clear` has no interactive session to clear, and
    // `/cancel` is the rail's own running-turn cancellation.
    if (message === "/clear") {
      if (!override) setDraft("");
      void onFreshChat();
      return;
    }
    if (message === "/cancel") {
      if (!override) setDraft("");
      if (busy) void onCancel();
      return;
    }
    if (busy) return; // Don't stack turns — wait for the in-flight one.
    const segId = askSegId;
    const videoId = project.video.video_id;
    if (!override) setDraft("");
    setPending({ role: "user", text: message });
    setBusy(true);
    setBusyStartedAt(Date.now());
    // Clear any leftover stream state from a prior turn so the live
    // bubble doesn't briefly flash the previous reply.
    setStreamText("");
    setStreamTools([]);
    try {
      const res = await claudeChat(project.project_dir, { message, videoId, segId });
      const now = new Date().toISOString();
      setHistory((h) => [
        ...h,
        { ts: now, role: "user", text: message },
        { ts: now, role: "assistant", text: res.reply },
      ]);
      setPending(null);
      if (segId) clearAsk();
    } catch (e) {
      setPending(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setBusyStartedAt(null);
      // The final reply is now in `history`; the streaming bubble was a
      // live preview and should disappear.
      setStreamText("");
      setStreamTools([]);
      // **Refresh project state from disk after every turn**, success
      // OR error. Claude may have:
      //   - rendered a segment / final mp4 → Preview's `finalAvailable`
      //     probe needs to re-run
      //   - regenerated TTS / captions → Inspector + stale-final banner
      //     need fresh data
      //   - edited `videos/<id>.json` directly (split / merge /
      //     reordered segments) → Timeline must rerender from the new
      //     segment list
      //   - added a new video → sidebar count needs to update
      // Before this hook, the only way to see those changes was to
      // close + reopen the project. We do this in `finally` so even a
      // cancelled / errored turn picks up partial mutations.
      //
      // `loadProject` already resets undo/redo + selection — that's
      // appropriate here because Claude is the source of truth for any
      // segment changes it made, not the user's in-memory edits.
      try {
        const fresh = await openProject(project.project_dir, videoId);
        loadProject(fresh);
      } catch {
        // Project may have been deleted out from under us. The error
        // path already surfaced any meaningful failure; a refresh miss
        // shouldn't pile on. Stale state in this edge case is better
        // than a confusing toast.
      }
    }
  }

  async function onCancel() {
    if (!project?.video) return;
    try {
      await cancelClaudeChat(project.video.video_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // The in-flight `send()` promise will reject with "cancelled" and its
    // `finally` clears `busy` — no need to flip it here.
  }

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggle}
        title="Open Claude rail (⌘\\)"
        className="flex h-full w-full flex-col items-center justify-start gap-3 pt-3 text-fg-muted transition-colors hover:text-fg"
      >
        <MessageSquare size={16} strokeWidth={1.75} />
        <span className="rotate-180 [writing-mode:vertical-rl] text-xs">Claude</span>
      </button>
    );
  }

  // Filter the discovered slash commands + skills by what the user
  // has typed so far. The popover opens only when:
  //   * the draft starts with "/" AND
  //   * there's no whitespace yet (typing "/qa test foo" closes the
  //     popover — they've moved on to the argument), AND
  //   * at least one entry matches the prefix after the slash.
  // We merge three sources into one ranked list:
  //   * built-ins  — locally-intercepted (`/clear`, `/cancel`).
  //   * commands   — `.claude/commands/**/*.md` files.
  //   * skills     — `.claude/skills/<name>/SKILL.md` directories.
  // Each entry carries a `kind` so the popover can render a distinct
  // chip ("built-in" / "command" / "skill") and the user can see what
  // they're about to invoke.
  const slashMatches = useMemo(() => {
    const m = draft.match(/^\/([A-Za-z0-9_\-:]*)$/);
    if (!m) return [] as SlashEntry[];
    const query = m[1]!.toLowerCase();
    const builtins: SlashEntry[] = [
      {
        kind: "builtin",
        name: "clear",
        description: "Start a fresh chat session (archives today's log).",
        argument_hint: "",
        source: "user",
      },
      {
        kind: "builtin",
        name: "cancel",
        description: "Cancel the in-flight turn.",
        argument_hint: "",
        source: "user",
      },
    ];
    const commandEntries: SlashEntry[] = slashCommands.map((c) => ({
      kind: "command",
      name: c.name,
      description: c.description,
      argument_hint: c.argument_hint,
      source: c.source,
    }));
    const skillEntries: SlashEntry[] = skills.map((s) => ({
      kind: "skill",
      name: s.name,
      description: s.description,
      argument_hint: "",
      source: s.source,
    }));
    const combined = [...builtins, ...commandEntries, ...skillEntries];
    return combined.filter((c) => c.name.toLowerCase().startsWith(query));
  }, [draft, slashCommands, skills]);
  // Reset the highlight when the filter changes so the user never
  // sees a stale "selected" row scroll out of view.
  useEffect(() => {
    setSlashIndex(0);
  }, [slashMatches.length, draft]);
  const slashOpen = slashMatches.length > 0;

  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-border-subtle px-3">
        <span className="text-xs font-medium uppercase tracking-wider text-fg-muted">
          Claude
        </span>
        <div className="flex items-center gap-1.5">
          <ModelPicker
            value={model}
            disabled={!project?.project_dir || busy || installed === false}
            onChange={onChangeModel}
          />
          <PermissionModePicker
            value={permMode}
            disabled={!project?.project_dir || busy || installed === false}
            onChange={onChangePermMode}
          />
          <IdleTimeoutPicker
            value={idleSeconds}
            disabled={!project?.project_dir || busy || installed === false}
            onChange={onChangeIdleTimeout}
          />
          {installed === false && (
            <span
              className="rounded bg-warn/20 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-warn"
              title="The `claude` CLI is not on PATH. Install Claude Code to enable chat."
            >
              CLI missing
            </span>
          )}
          <FreshChatButton
            disabled={!project?.video || busy || installed === false}
            historyEmpty={history.length === 0 && !pending}
            onConfirm={onFreshChat}
          />
          <button
            type="button"
            onClick={toggle}
            title="Collapse rail (⌘\\)"
            aria-label="Collapse Claude rail"
            className="rounded p-1 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg"
          >
            <ChevronRight size={14} strokeWidth={2} />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {history.length === 0 && !pending && (
          <p className="text-xs text-fg-muted">
            Ask Claude anything about this project. Right-click a segment for a
            scoped ask.
          </p>
        )}
        <div className="flex flex-col gap-3 text-sm">
          {history.map((m, i) => {
            // tool_use / tool_result are persisted alongside the bubble
            // entries (so a refresh or mid-turn stop preserves them).
            // Render them as ToolChip-style boxes inline with the
            // assistant bubbles — the JSONL order is the same order
            // the stream emitted them, so the replay reads naturally.
            //
            // We try to pair a tool_result with its preceding
            // tool_use by `tool_id` so the chip can show both `input`
            // and `output` together (matching the live bubble's
            // chip). If no pairing is found we render the orphan as
            // its own chip.
            if (m.role === "tool_use") {
              const pair = history
                .slice(i + 1)
                .find(
                  (x) =>
                    x.role === "tool_result" &&
                    x.tool_id &&
                    x.tool_id === m.tool_id,
                );
              const tool: StreamToolUse = {
                id: m.tool_id ?? "",
                name: m.tool_name ?? "tool",
                status: pair ? (pair.tool_error ? "error" : "ok") : "ok",
                input: m.tool_input,
                output: pair ? pair.tool_output : undefined,
              };
              return <HistoryToolChip key={i} tool={tool} />;
            }
            if (m.role === "tool_result") {
              // Already merged into the matching tool_use above; only
              // render as a standalone chip if we couldn't find the
              // partner (legacy log fragment, partial write, etc.).
              const partnerSeen = history
                .slice(0, i)
                .some(
                  (x) =>
                    x.role === "tool_use" &&
                    x.tool_id &&
                    x.tool_id === m.tool_id,
                );
              if (partnerSeen) return null;
              const tool: StreamToolUse = {
                id: m.tool_id ?? "",
                name: "tool_result (orphaned)",
                status: m.tool_error ? "error" : "ok",
                input: undefined,
                output: m.tool_output,
              };
              return <HistoryToolChip key={i} tool={tool} />;
            }
            // A bubble is "stale" once any newer message has landed —
            // its embedded questions represent decisions the
            // conversation has already moved past.
            const stale = i !== history.length - 1;
            return (
              <ChatBubble
                key={i}
                role={m.role as "user" | "assistant"}
                text={m.text}
                onAnswer={(ans) => void send(ans)}
                answerDisabled={busy || stale}
                stale={stale}
                onRunCommand={onRunCommand}
              />
            );
          })}
          {pending && <ChatBubble role={pending.role} text={pending.text} />}
          {busy && (
            <LiveAssistantBubble
              text={streamText}
              tools={streamTools}
              elapsed={elapsed}
              onRunCommand={onRunCommand}
            />
          )}
          {busy && (
            <button
              type="button"
              onClick={onCancel}
              className="flex items-center gap-1 self-start rounded border border-border-subtle bg-bg px-2 py-0.5 text-[11px] text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg"
              title="Kill the running claude subprocess"
            >
              <Square size={10} strokeWidth={2} fill="currentColor" />
              Cancel
            </button>
          )}
        </div>
        <div ref={bottomRef} />
      </div>

      <div className="flex flex-col gap-1 border-t border-border-subtle p-2">
        {askSegId && (
          <div className="flex items-center justify-between rounded bg-accent/10 px-2 py-1 text-[11px] text-accent">
            <span>
              Scoped to <span className="font-mono">{askSegId}</span>
            </span>
            <button
              type="button"
              onClick={clearAsk}
              className="flex items-center gap-0.5 text-fg-muted hover:text-fg"
            >
              clear
              <X size={11} strokeWidth={2} />
            </button>
          </div>
        )}
        {/* Relative wrapper so the slash-command popover can absolutely
         *  position itself just above the textarea. Without this the
         *  popover would either inherit the parent's flex layout
         *  (pushing content around) or escape to the body, losing the
         *  textarea-anchored placement. */}
        <div className="relative">
          {slashOpen && (
            <SlashCommandPopover
              matches={slashMatches}
              activeIndex={slashIndex}
              onPick={(cmd) => {
                // Replace the draft with the chosen command. If it
                // takes an argument, leave the trailing space so the
                // user can keep typing; otherwise close the popover
                // immediately and put the cursor at the end.
                const next = cmd.argument_hint
                  ? `/${cmd.name} `
                  : `/${cmd.name}`;
                setDraft(next);
              }}
            />
          )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Slash-command popover takes precedence over all other
            // key bindings — when it's open, ↑↓ navigate, Enter / Tab
            // accept, Esc closes.
            if (slashOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashIndex((i) => (i + 1) % slashMatches.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashIndex(
                  (i) => (i - 1 + slashMatches.length) % slashMatches.length,
                );
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                const cmd = slashMatches[slashIndex];
                if (cmd) {
                  setDraft(
                    cmd.argument_hint ? `/${cmd.name} ` : `/${cmd.name}`,
                  );
                }
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDraft("");
                return;
              }
            }
            // Enter sends; Shift+Enter inserts a newline. IME composition
            // (Japanese / Chinese input) emits Enter to commit — leave that
            // alone via `isComposing`.
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder={
            installed === false
              ? "Install Claude Code to enable chat"
              : askSegId
                ? `Ask Claude about ${askSegId}…  (Enter to send · Shift+Enter for newline)`
                : "Ask Claude about this video…  (Enter to send · Shift+Enter for newline)"
          }
          disabled={installed === false || busy}
          className="w-full resize-none rounded border border-border-subtle bg-bg-inset px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted focus:focus-ring disabled:cursor-not-allowed"
        />
        </div>
      </div>
    </div>
  );
}

/** Unified entry for the slash popover. Wraps the three sources we
 *  merge — locally-intercepted builtins, `.claude/commands/`
 *  templates, and `.claude/skills/` capabilities — under one shape so
 *  the popover only has to know about `name`, `description`,
 *  `argument_hint`, and the kind chip to render. */
type SlashEntry = {
  kind: "builtin" | "command" | "skill";
  name: string;
  description: string;
  argument_hint: string;
  source: "user" | "project";
};

/** Floating popover over the textarea showing matching slash entries.
 *  Anchored bottom-up so the user sees the list directly above where
 *  they're typing — feels like a continuation of the input rather
 *  than a separate UI element. Highlighted row reads as
 *  "ready-to-accept" (Enter or Tab). */
function SlashCommandPopover({
  matches,
  activeIndex,
  onPick,
}: {
  matches: SlashEntry[];
  activeIndex: number;
  onPick: (cmd: SlashEntry) => void;
}) {
  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 max-h-60 overflow-y-auto rounded border border-border bg-bg-raised shadow-lg">
      <div className="flex items-center gap-1 border-b border-border-subtle bg-bg-subtle px-2 py-1 text-[10px] uppercase tracking-wider text-fg-muted">
        <Slash size={10} strokeWidth={2} />
        <span>slash commands</span>
        <span className="ml-auto text-fg-muted/70">↑↓ navigate · Enter accept · Esc close</span>
      </div>
      <ul className="flex flex-col">
        {matches.map((cmd, i) => {
          const active = i === activeIndex;
          return (
            <li key={`${cmd.kind}-${cmd.source}-${cmd.name}`}>
              <button
                type="button"
                onMouseDown={(e) => {
                  // Use mousedown so the textarea doesn't lose focus
                  // before the click registers (which would close the
                  // popover via the focus blur).
                  e.preventDefault();
                  onPick(cmd);
                }}
                className={cn(
                  "flex w-full items-baseline gap-2 px-2 py-1 text-left text-xs transition-colors",
                  active ? "bg-accent/15 text-fg" : "text-fg-subtle hover:bg-bg-inset",
                )}
              >
                <span className="font-mono text-accent">/{cmd.name}</span>
                {cmd.argument_hint && (
                  <span className="font-mono text-[11px] text-fg-muted">
                    {cmd.argument_hint}
                  </span>
                )}
                {cmd.description && (
                  <span className="ml-auto truncate text-[11px] text-fg-muted">
                    {cmd.description}
                  </span>
                )}
                <span
                  className={cn(
                    "shrink-0 rounded px-1 py-px font-mono text-[9px] uppercase tracking-wider",
                    cmd.kind === "builtin"
                      ? "bg-accent/15 text-accent"
                      : cmd.kind === "skill"
                        ? "bg-warn/15 text-warn"
                        : "bg-bg-inset text-fg-muted",
                  )}
                  title={
                    cmd.kind === "builtin"
                      ? "Built-in — handled locally by the rail"
                      : cmd.kind === "skill"
                        ? cmd.source === "project"
                          ? "Skill defined in <project>/.claude/skills/"
                          : "Skill defined in ~/.claude/skills/"
                        : cmd.source === "project"
                          ? "Command defined in <project>/.claude/commands/"
                          : "Command defined in ~/.claude/commands/"
                  }
                >
                  {cmd.kind === "builtin"
                    ? "built-in"
                    : cmd.kind === "skill"
                      ? `skill · ${cmd.source}`
                      : `cmd · ${cmd.source}`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Model picker — a tiny `<select>` letting the user choose which Claude
// model drives the chat. Aliases (`sonnet`/`opus`/`haiku`) are passed
// through to `claude --model <name>`; "" = let the CLI use its default.
const MODEL_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: "",       label: "default", hint: "Use whatever model your `claude` CLI is configured for." },
  { value: "sonnet", label: "sonnet",  hint: "Sonnet — balanced quality + speed (recommended)." },
  { value: "opus",   label: "opus",    hint: "Opus — slower, highest quality. Best for visual storytelling." },
  { value: "haiku",  label: "haiku",   hint: "Haiku — fastest, lowest cost. Good for quick edits." },
];

function ModelPicker({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (model: string) => void;
}) {
  return (
    <Dropdown<string>
      value={value}
      options={MODEL_OPTIONS}
      disabled={disabled}
      onChange={onChange}
      menuAlign="right"
      menuMinWidth={220}
      titleFallback="Claude model for this project"
      triggerClassName="px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider"
    />
  );
}

// Permission-mode picker — a tiny `<select>` styled as a badge.
//
// `claude --print` can't render its interactive Allow/Deny dialog
// (non-TTY), so chats requesting tool use either silently noop or hang.
// We pass `--permission-mode <mode>` so the policy is set up-front.
// `acceptEdits` is the right default for an editor: writes inside the
// project dir go through, dangerous shell stays gated.
const PERM_OPTIONS: { value: PermissionMode; label: string; hint: string }[] = [
  { value: "acceptEdits",       label: "auto-edits", hint: "Auto-approve file writes and clipwright CLI commands (recommended)" },
  { value: "plan",              label: "read-only",  hint: "Read-only: Claude can browse but not modify files" },
  { value: "default",           label: "ask",        hint: "Honor normal CLI allow/deny — likely blocks since the approval dialog can't render in --print mode" },
  { value: "bypassPermissions", label: "yolo",       hint: "Bypass all permission checks — Claude can run any shell command. Use with care" },
];

function PermissionModePicker({
  value,
  disabled,
  onChange,
}: {
  value: PermissionMode;
  disabled: boolean;
  onChange: (mode: PermissionMode) => void;
}) {
  return (
    <Dropdown<PermissionMode>
      value={value}
      options={PERM_OPTIONS}
      disabled={disabled}
      onChange={onChange}
      menuAlign="right"
      menuMinWidth={280}
      titleFallback="Tool-permission policy for this project"
      triggerClassName="px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider"
    />
  );
}

// Idle-timeout picker — siblings with PermissionModePicker above.
//
// The Rust watchdog kills `claude --print` if no stream-json line
// arrives within this many seconds. Default is 2m. Long autonomous
// turns (heavy thinking, big bashes, deep tool chains in yolo mode)
// can legitimately go silent past that and the kill was firing on
// healthy turns — this dropdown lets the user pick a longer ceiling
// or disable the watchdog entirely. The wall-clock cap (2h default)
// remains a separate, always-on backstop so "off" doesn't mean
// "unbounded forever."
//
// Wire encoding mirrors the Rust side (claude.rs::load_idle_timeout):
// 0 = default, -1 = off, positive int = seconds (clamp 30..3600).
//
// The shared `Dropdown` component is constrained to `T extends string`,
// so we use stringified values here and convert at the boundary. The
// numeric encoding is preserved end-to-end via parseInt — no
// behavior change vs storing numbers, just satisfying the generic.
type IdlePresetValue = "0" | "300" | "900" | "1800" | "-1";
const IDLE_OPTIONS: { value: IdlePresetValue; label: string; hint: string }[] = [
  {
    value: "0",
    label: "idle 2m",
    hint: "Kill the turn after 2 minutes of silence (default). Best for normal sessions; catches genuinely-stuck CLI subprocesses fast.",
  },
  {
    value: "300",
    label: "idle 5m",
    hint: "Light bump. Good for occasional long tool calls without disabling the safety net.",
  },
  {
    value: "900",
    label: "idle 15m",
    hint: "Comfortable for autonomous turns in yolo mode (big bashes, deep tool chains). Watchdog still fires on truly stuck processes.",
  },
  {
    value: "1800",
    label: "idle 30m",
    hint: "Generous ceiling. Wall-clock cap (2h default) is still the upper limit.",
  },
  {
    value: "-1",
    label: "idle off",
    hint: "Disable the no-output watchdog entirely. Only the wall-clock cap will kill the turn. Use this for very long autonomous runs you trust.",
  },
];

/** Map raw seconds → preset string. Falls through to "0" (default)
 *  for hand-edited / out-of-menu values so the dropdown always
 *  shows SOMETHING coherent; the actual on-disk value isn't
 *  changed unless the user picks something explicitly. */
function idlePresetFor(seconds: number): IdlePresetValue {
  const known: IdlePresetValue[] = ["0", "300", "900", "1800", "-1"];
  const match = known.find((v) => parseInt(v, 10) === seconds);
  return match ?? "0";
}

function IdleTimeoutPicker({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled: boolean;
  onChange: (seconds: number) => void;
}) {
  return (
    <Dropdown<IdlePresetValue>
      value={idlePresetFor(value)}
      options={IDLE_OPTIONS}
      disabled={disabled}
      onChange={(v) => onChange(parseInt(v, 10))}
      menuAlign="right"
      menuMinWidth={280}
      titleFallback="How long Claude can go silent before we kill the turn"
      triggerClassName="px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider"
    />
  );
}

function FreshChatButton({
  disabled,
  historyEmpty,
  onConfirm,
}: {
  disabled: boolean;
  historyEmpty: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);

  // First click arms the button; second click within 4s confirms. If the
  // chat is already empty we skip the confirm step — there's nothing to
  // lose. (Today's log is archived to .archived-<ts>.jsonl either way,
  // so even an accidental click is recoverable from disk.)
  function onClick() {
    if (historyEmpty) {
      void onConfirm();
      return;
    }
    if (!confirming) {
      setConfirming(true);
      window.setTimeout(() => setConfirming(false), 4000);
      return;
    }
    setConfirming(false);
    void onConfirm();
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={
        confirming
          ? "Click again to wipe this video's chat. Today's log is archived."
          : "Start a fresh Claude conversation for this video"
      }
      className={cn(
        "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
        disabled && "cursor-not-allowed text-fg-muted opacity-40",
        !disabled && !confirming && "text-fg-muted hover:bg-bg-raised hover:text-fg",
        !disabled && confirming && "bg-warn/20 font-medium text-warn",
      )}
    >
      <RotateCcw size={10} strokeWidth={2.25} />
      {confirming ? "Confirm reset" : "Fresh"}
    </button>
  );
}

function ChatBubble({
  role,
  text,
  muted,
  onAnswer,
  answerDisabled,
  stale,
  onRunCommand,
}: {
  role: "user" | "assistant";
  text: string;
  muted?: boolean;
  /** Click handler for embedded QuestionCard buttons. Only the most
   *  recent assistant bubble should be interactive — older cards
   *  represent past decisions. */
  onAnswer?: (answer: string) => void;
  answerDisabled?: boolean;
  /** True when this bubble has been followed by newer messages. Embedded
   *  question cards render as "superseded" so the user can see at a
   *  glance that they're frozen. */
  stale?: boolean;
  /** Handler the MarkdownView uses to run `clipwright …` code blocks
   *  from a Play button. Only forwarded for assistant bubbles —
   *  there's nothing useful to "run" in a user message. */
  onRunCommand?: (command: string) => Promise<CommandResult>;
}) {
  const isUser = role === "user";
  // Pre-parse assistant text into markdown / question parts. User text
  // never carries question blocks — render it as-is.
  const parts = !isUser ? parseAskBlocks(text) : null;
  return (
    <div
      className={cn(
        "rounded px-2.5 py-2 text-sm",
        isUser
          ? "self-end max-w-[90%] bg-accent/15 text-fg"
          : "max-w-full bg-bg-inset text-fg-subtle",
        muted && "italic text-fg-muted",
      )}
    >
      <div className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
        {role}
      </div>
      {/* User messages stay literal — they're whatever the user typed,
       *  including stray asterisks they didn't mean as markdown. Only the
       *  assistant's GFM-flavored output gets the full markdown +
       *  question-card treatment. */}
      {isUser ? (
        <div className="mt-0.5 whitespace-pre-wrap break-words">{text}</div>
      ) : (
        <div className="mt-0.5">
          {parts!.map((part, i) =>
            part.kind === "markdown" ? (
              <MarkdownView key={i} text={part.text} onRunCommand={onRunCommand} />
            ) : (
              <QuestionCard
                key={i}
                block={part.block}
                disabled={answerDisabled || !onAnswer}
                stale={stale}
                onAnswer={(ans) => onAnswer?.(ans)}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live streaming — `claude:turn` event handling
// ---------------------------------------------------------------------------

/** One in-progress tool call surfaced under the live bubble.
 *
 * `input` is captured at tool_use time; `output` is filled when the
 * matching tool_result arrives. Both are kept verbatim so the user can
 * click the chip and inspect exactly what Claude sent and got back —
 * useful for debugging why a turn went sideways. */
interface StreamToolUse {
  id: string;
  name: string;
  /** Status mirrors the lifecycle: started → completed/error. We don't
   *  show "started" forever — completed ones get a checkmark + fade. */
  status: "running" | "ok" | "error";
  /** The tool_use `input` object verbatim. JSON-stringified at render
   *  time so we don't pay for serialization until the user opens the
   *  drawer. */
  input: unknown;
  /** The tool_result `content` once it lands. Often a string or an
   *  array of content blocks; we render whichever shape arrived. */
  output: unknown;
}

/** Wire shape of the `claude:turn` Tauri event. Mirrors
 *  `ClaudeStreamEvent` in `desktop/src-tauri/src/claude.rs`. */
interface ClaudeStreamEvent {
  video_id: string;
  payload: Record<string, unknown>;
}

/** Apply one streamed event to the live bubble state.
 *
 * Stream-json from `claude --print --output-format stream-json` emits:
 *   - `{type:"system", subtype:"init", ...}` — handshake; ignore.
 *   - `{type:"assistant", message:{content:[{type:"text",text:"..."},
 *      {type:"tool_use", id, name, input}]}}` — text adds to the bubble,
 *      tool_use appears as a chip.
 *   - `{type:"user", message:{content:[{type:"tool_result", tool_use_id,
 *      is_error, content}]}}` — flip the matching tool chip to ok/error.
 *   - `{type:"result", ...}` — finalizer; we don't grow text here
 *      because the `result` text is the SAME text the assistant lines
 *      already streamed in. Duplicating it would double the bubble.
 */
function applyStreamEvent(
  payload: Record<string, unknown>,
  setStreamText: React.Dispatch<React.SetStateAction<string>>,
  setStreamTools: React.Dispatch<React.SetStateAction<StreamToolUse[]>>,
) {
  const t = payload.type as string | undefined;
  if (t === "assistant") {
    const msg = payload.message as
      | { content?: Array<Record<string, unknown>> }
      | undefined;
    const parts = msg?.content ?? [];
    let textDelta = "";
    const newTools: StreamToolUse[] = [];
    for (const part of parts) {
      if (part.type === "text" && typeof part.text === "string") {
        textDelta += part.text;
      } else if (part.type === "tool_use") {
        newTools.push({
          id: String(part.id ?? ""),
          name: String(part.name ?? "tool"),
          status: "running",
          input: part.input,
          output: undefined,
        });
      }
    }
    if (textDelta) {
      // `assistant` events in stream-json are whole messages, not deltas.
      // The CLI emits one assistant event per turn-of-the-LLM (a "block"
      // of text + tool uses), so we replace rather than append once we
      // see a text part. If a turn produces multiple text blocks, we
      // join them with two newlines.
      setStreamText((prev) => (prev ? `${prev}\n\n${textDelta}` : textDelta));
    }
    if (newTools.length) {
      setStreamTools((prev) => [...prev, ...newTools]);
    }
  } else if (t === "user") {
    // tool_result inside a `user` event → flip the matching chip.
    const msg = payload.message as
      | { content?: Array<Record<string, unknown>> }
      | undefined;
    for (const part of msg?.content ?? []) {
      if (part.type !== "tool_result") continue;
      const targetId = String(part.tool_use_id ?? "");
      const isError = Boolean(part.is_error);
      const resultContent = part.content;
      setStreamTools((prev) =>
        prev.map((t) =>
          t.id === targetId
            ? {
                ...t,
                status: isError ? "error" : "ok",
                output: resultContent,
              }
            : t,
        ),
      );
    }
  }
}

function LiveAssistantBubble({
  text,
  tools,
  elapsed,
  onRunCommand,
}: {
  text: string;
  tools: StreamToolUse[];
  elapsed: number;
  onRunCommand?: (command: string) => Promise<CommandResult>;
}) {
  // Three visual layers in the live bubble:
  //   1. The growing assistant text (markdown-rendered, same as a final
  //      bubble — so when the stream finishes the user sees no visual
  //      jump, just the same content "settling").
  //   2. Tool chips — one per in-flight or completed tool call.
  //   3. A footer line with elapsed seconds so the user knows the
  //      backend is actively working even between text blocks.
  const showThinking = !text && tools.length === 0;
  return (
    <div className="rounded bg-bg-inset px-2.5 py-2 text-sm text-fg-subtle">
      <div className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
        assistant {elapsed > 0 && <span>· {elapsed}s</span>}
      </div>
      {showThinking ? (
        <div className="mt-0.5 italic text-fg-muted">thinking…</div>
      ) : (
        <>
          {text && (
            <div className="mt-0.5">
              <MarkdownView text={text} onRunCommand={onRunCommand} />
            </div>
          )}
          {tools.length > 0 && (
            <div className="mt-2 flex flex-col gap-1">
              {tools.map((t) => (
                <ToolChip key={t.id || t.name} tool={t} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** ToolChip wrapper for replayed history entries.
 *
 *  Visually identical to the live bubble's `ToolChip`, but wrapped in
 *  a thin "assistant" container so it visually aligns with the
 *  surrounding `ChatBubble`s — without that wrapper, history tool
 *  chips end up flush-left and read as a different speaker.
 *  Defaults to "open" so the user immediately sees input + output
 *  when reloading a stopped turn (that's the whole point of
 *  persisting them). */
function HistoryToolChip({ tool }: { tool: StreamToolUse }) {
  return (
    <div className="rounded bg-bg-inset px-2.5 py-2 text-sm text-fg-subtle">
      <div className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
        tool · {tool.name}
      </div>
      <div className="mt-1.5">
        <ToolChip tool={tool} />
      </div>
    </div>
  );
}

function ToolChip({ tool }: { tool: StreamToolUse }) {
  const [open, setOpen] = useState(false);
  const color =
    tool.status === "running"
      ? "text-fg-muted"
      : tool.status === "ok"
        ? "text-ok"
        : "text-danger";
  const verb =
    tool.status === "running"
      ? "running"
      : tool.status === "ok"
        ? "ok"
        : "error";

  // Only show the disclosure caret once we have something useful to
  // reveal — a running tool with no result yet has only `input`, which
  // is still worth viewing (the args Claude chose to send).
  const hasDetails = tool.input !== undefined || tool.output !== undefined;

  return (
    <div className="rounded border border-border-subtle bg-bg">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((v) => !v)}
        disabled={!hasDetails}
        className={cn(
          "flex w-full items-center gap-1.5 px-1.5 py-0.5 font-mono text-[11px]",
          color,
          hasDetails && "hover:bg-bg-raised",
          !hasDetails && "cursor-default",
        )}
        aria-expanded={open}
        title={hasDetails ? "Click to view input / output" : ""}
      >
        <Wrench size={11} strokeWidth={1.75} />
        <span className="text-fg">{tool.name}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wider">{verb}</span>
        {hasDetails && (
          <span className="ml-1 text-[10px] text-fg-muted">{open ? "▾" : "▸"}</span>
        )}
      </button>
      {open && hasDetails && (
        <div className="flex flex-col gap-2 border-t border-border-subtle bg-bg-inset px-2 py-2 font-mono text-[11px]">
          {tool.input !== undefined && (
            <JsonBlock label="input" value={tool.input} />
          )}
          {tool.output !== undefined && (
            <JsonBlock label="output" value={tool.output} />
          )}
        </div>
      )}
    </div>
  );
}

/** Pretty-printed JSON block with a label header. Truncates very long
 *  strings (>10KB) so a huge file dump doesn't blow up the rail. */
function JsonBlock({ label, value }: { label: string; value: unknown }) {
  const TRUNCATE_AT = 10_000;
  const formatted =
    typeof value === "string"
      ? value
      : (() => {
          try {
            return JSON.stringify(value, null, 2);
          } catch {
            return String(value);
          }
        })();
  const truncated = formatted.length > TRUNCATE_AT;
  const text = truncated
    ? `${formatted.slice(0, TRUNCATE_AT)}\n… [truncated ${formatted.length - TRUNCATE_AT} chars]`
    : formatted;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-fg-muted">
        {label}
      </span>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-fg-subtle">
        {text}
      </pre>
    </div>
  );
}
