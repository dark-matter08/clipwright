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
import type { ChatRuntime, TranscriptFontSize, TranscriptView } from "../lib/store";
import { cn } from "../lib/cn";
import {
  groupIntoTurns,
  type InFlightOverlay,
  type Turn,
} from "../lib/transcript";
import { Dropdown } from "./Dropdown";
import { MarkdownView } from "./MarkdownView";
import { parseAskBlocks, QuestionCard } from "./QuestionCard";
import { TranscriptViewMenu } from "./TranscriptViewMenu";

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

  // Per-video runtime — busy / pending / streamText / streamTools / draft
  // all live in the global store, keyed by `video_id`. Switching videos
  // mid-turn no longer wipes the in-flight state; both videos can have
  // simultaneous turns going on the Tauri side and the rail just shows
  // whichever one is currently selected.
  const currentVideoId = project?.video?.video_id ?? "";
  const runtime = useApp((s) =>
    currentVideoId ? s.chatRuntime[currentVideoId] : undefined,
  );
  const updateChatRuntime = useApp((s) => s.updateChatRuntime);
  const busy = runtime?.busy ?? false;
  const busyStartedAt = runtime?.busyStartedAt ?? null;
  const pending = runtime?.pending ?? null;
  const streamText = runtime?.streamText ?? "";
  const streamTools = runtime?.streamTools ?? [];
  const draft = runtime?.draft ?? "";
  // Convenience setter — every per-video state mutation flows through
  // here. Uses the currentVideoId captured at call-time so a switch
  // in flight doesn't write to the wrong slice.
  const setRuntime = (patch: Partial<ChatRuntime>) => {
    if (!currentVideoId) return;
    updateChatRuntime(currentVideoId, patch);
  };
  const setDraft = (d: string) => setRuntime({ draft: d });
  const setPending = (p: { role: "user"; text: string } | null) =>
    setRuntime({ pending: p });
  const setBusy = (b: boolean) => setRuntime({ busy: b });
  const setBusyStartedAt = (t: number | null) => setRuntime({ busyStartedAt: t });
  const setStreamText = (text: string) => setRuntime({ streamText: text });
  const setStreamTools = (tools: StreamToolUse[]) =>
    setRuntime({ streamTools: tools });

  const [history, setHistory] = useState<ChatHistoryEntry[]>([]);
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  // Subscribe to view-mode + font-size. The transcript body picks its
  // layout from `transcriptView`; the wrapper div applies a font-size
  // class derived from `transcriptFontSize` so every text element
  // inside scales together.
  const transcriptView = useApp((s) => s.transcriptView);
  const transcriptFontSize = useApp((s) => s.transcriptFontSize);

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

  // NOTE: the `claude:turn` event listener lives in `Workspace.tsx`,
  // not here. That listener routes each event into the matching
  // `chatRuntime[video_id]` slice REGARDLESS of which video is
  // currently shown — which is what lets parallel chats survive a
  // video switch. The rail just reads `chatRuntime[currentVideoId]`
  // for display.

  useEffect(() => {
    if (!project?.video) {
      setHistory([]);
      return;
    }
    const videoId = project.video.video_id;
    loadChatHistory(project.project_dir, videoId)
      .then((entries) => {
        setHistory(entries);
        // Dedupe: disk is now authoritative for this video, so any
        // optimistic `pending` bubble whose text matches the most
        // recent disk-side user row is redundant. Clearing it kills
        // the "two USER resume bubbles" duplication-on-switch bug
        // (the prior pending was queued on a different render path
        // and didn't see the disk catch-up). The transcript grouper
        // ALSO dedupes inside `groupIntoTurns`, but clearing the
        // store slice keeps the data shape clean for future renders.
        const lastUser = [...entries].reverse().find((e) => e.role === "user");
        const currentPending =
          useApp.getState().chatRuntime[videoId]?.pending ?? null;
        if (
          lastUser &&
          currentPending &&
          currentPending.text.trim() === lastUser.text.trim()
        ) {
          useApp.getState().updateChatRuntime(videoId, { pending: null });
        }
      })
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
      const errText = e instanceof Error ? (e.stack || e.message) : String(e);
      // Tag the error source so the App's error history can group by
      // subsystem (claude / tauri / schema). Without this every entry
      // shows up as "unknown" and the user can't tell at a glance what
      // failed.
      setError(errText, "claude");
      // Persist the failure into the rail's chat transcript too. The
      // banner can be dismissed; the chat scroll cannot. This gives the
      // user a permanent in-context record of "this turn failed
      // because X" so they can scroll back to it or share the
      // surrounding turn.
      const now = new Date().toISOString();
      setHistory((h) => [
        ...h,
        { ts: now, role: "user", text: message },
        {
          ts: now,
          role: "assistant",
          // Markdown so the bubble renders the error in a code block.
          // `MarkdownView` will pick this up like a regular reply.
          text:
            `**⚠ Turn failed** \`(${new Date().toLocaleTimeString()})\`\n\n` +
            "```\n" +
            errText +
            "\n```\n\n" +
            "_The error is also in the banner at the top of the app — click " +
            "Copy there to grab the full text, or open Error history to see " +
            "this and any prior failures._",
        },
      ]);
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
  //
  // **This MUST stay above the `collapsed` early-return** so the hook
  // count is stable across renders. Putting the return first and these
  // two hooks below it triggers React's "Rendered fewer hooks than
  // expected" error on every toggle: open → 15 hooks; collapsed →
  // 13 hooks; React's per-component hook counter mismatches and the
  // whole rail throws, blanking the app. The expanded rail still uses
  // `slashMatches` / `slashOpen` further down; the collapsed view just
  // ignores them. Cheap to compute when collapsed (empty draft → early
  // null match in the regex).
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
          <TranscriptViewMenu
            onJumpTop={() => topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
            onJumpLatest={() => bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })}
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
        <div ref={topRef} />
        {history.length === 0 && !pending && !streamText && (
          <p className="text-xs text-fg-muted">
            Ask Claude anything about this project. Right-click a segment for a
            scoped ask.
          </p>
        )}
        <Transcript
          history={history}
          pending={pending}
          streamText={streamText}
          streamTools={streamTools}
          busy={busy}
          elapsed={elapsed}
          view={transcriptView}
          fontSize={transcriptFontSize}
          onAnswer={(ans) => void send(ans)}
          onRunCommand={onRunCommand}
          onCancel={onCancel}
        />
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

// ---------------------------------------------------------------------------
// Transcript — view-mode-aware renderer for the chat scroll
// ---------------------------------------------------------------------------
//
// Reads the persisted `history` + in-flight overlay, groups into
// `Turn[]` via `groupIntoTurns`, then dispatches to the per-mode
// renderer. The grouping does double duty as the dedupe — when the
// optimistic `pending` user message matches the most recent disk
// user row, the grouper merges them into one turn instead of
// rendering two USER bubbles.

interface TranscriptProps {
  history: ChatHistoryEntry[];
  pending: { role: "user"; text: string } | null;
  streamText: string;
  streamTools: StreamToolUse[];
  busy: boolean;
  elapsed: number;
  view: TranscriptView;
  fontSize: TranscriptFontSize;
  onAnswer: (answer: string) => void;
  onRunCommand: (cmd: string) => Promise<CommandResult>;
  onCancel: () => void;
}

const FONT_SIZE_CLASS: Record<TranscriptFontSize, string> = {
  sm: "text-[11px] leading-snug",
  md: "text-sm leading-snug",
  lg: "text-base leading-relaxed",
};

function Transcript({
  history,
  pending,
  streamText,
  streamTools,
  busy,
  elapsed,
  view,
  fontSize,
  onAnswer,
  onRunCommand,
  onCancel,
}: TranscriptProps) {
  // Build the in-flight overlay from the rail's live state and feed
  // it through the grouper. `pending.text` and the disk's most-recent
  // user row dedupe inside `groupIntoTurns`.
  const overlay: InFlightOverlay | null = useMemo(() => {
    if (!pending && !streamText && streamTools.length === 0 && !busy) return null;
    return {
      userText: pending?.text ?? null,
      streamText,
      streamTools: streamTools.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        input: t.input,
        output: t.output,
      })),
    };
  }, [pending, streamText, streamTools, busy]);

  const turns = useMemo(
    () => groupIntoTurns(history, overlay, busy),
    [history, overlay, busy],
  );

  const fontClass = FONT_SIZE_CLASS[fontSize];

  let body: React.ReactNode;
  if (view === "verbose") {
    body = (
      <VerboseTranscript history={history} pending={pending} streamText={streamText} streamTools={streamTools} busy={busy} />
    );
  } else if (view === "summary") {
    body = <SummaryTranscript turns={turns} />;
  } else {
    // Normal + Thinking share the same bubble layout; Thinking adds
    // reveal-by-default for any `Turn.thinking` blocks (Normal hides
    // them behind a click-to-expand toggle).
    body = (
      <NormalTranscript
        turns={turns}
        showThinking={view === "thinking"}
        onAnswer={onAnswer}
        onRunCommand={onRunCommand}
        elapsed={elapsed}
        busy={busy}
      />
    );
  }

  return (
    <div className={cn("flex flex-col gap-3", fontClass)}>
      {body}
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
  );
}

function NormalTranscript({
  turns,
  showThinking,
  onAnswer,
  onRunCommand,
  elapsed,
  busy,
}: {
  turns: Turn[];
  showThinking: boolean;
  onAnswer: (a: string) => void;
  onRunCommand: (cmd: string) => Promise<CommandResult>;
  elapsed: number;
  busy: boolean;
}) {
  return (
    <>
      {turns.map((turn, i) => {
        const isLast = i === turns.length - 1;
        const stale = !isLast;
        return (
          <div key={turn.id} className="flex flex-col gap-2">
            {turn.userText && (
              <ChatBubble
                role="user"
                text={turn.userText}
                onAnswer={onAnswer}
                answerDisabled={busy || stale}
                stale={stale}
                onRunCommand={onRunCommand}
              />
            )}
            {showThinking && turn.thinking.length > 0 && (
              <div className="flex flex-col gap-1.5 rounded border border-border-subtle bg-bg-inset px-2 py-1.5">
                <span className="text-[10px] font-medium uppercase tracking-wider text-fg-muted">
                  Thinking
                </span>
                {turn.thinking.map((t, j) => (
                  <p key={j} className="whitespace-pre-wrap text-xs text-fg-subtle">
                    {t.text}
                  </p>
                ))}
              </div>
            )}
            {turn.tools.map((tool, j) => (
              <HistoryToolChip key={`${turn.id}-tool-${j}`} tool={tool} />
            ))}
            {turn.assistant.map((block, j) => (
              <ChatBubble
                key={`${turn.id}-asst-${j}`}
                role="assistant"
                text={block.text}
                onAnswer={onAnswer}
                answerDisabled={busy || stale}
                stale={stale}
                onRunCommand={onRunCommand}
              />
            ))}
            {turn.inFlight && turn.assistant.length === 0 && (
              // No assistant text yet — show the live spinner so the
              // user knows the turn is still cooking.
              <LiveAssistantBubble
                text=""
                tools={[]}
                elapsed={elapsed}
                onRunCommand={onRunCommand}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function SummaryTranscript({ turns }: { turns: Turn[] }) {
  if (turns.length === 0) {
    return <p className="text-xs text-fg-muted">No turns yet.</p>;
  }
  return (
    <ol className="flex flex-col gap-1.5">
      {turns.map((turn, i) => {
        const gist = firstSentence(turn.assistant.map((a) => a.text).join(" ").trim());
        const toolCount = turn.tools.length;
        return (
          <li
            key={turn.id}
            className="flex flex-col gap-0.5 rounded border border-border-subtle bg-bg-inset px-2 py-1.5"
          >
            <div className="flex items-baseline gap-2">
              <span className="shrink-0 font-mono text-[10px] text-fg-muted">
                #{i + 1}
              </span>
              <span className="truncate font-medium text-fg">
                {turn.userText || "(no user message)"}
              </span>
            </div>
            <div className="flex items-baseline gap-2 pl-5">
              <span className="line-clamp-2 text-fg-subtle">
                {gist || (turn.inFlight ? "(in flight…)" : "(no reply)")}
              </span>
              {toolCount > 0 && (
                <span className="shrink-0 rounded border border-border-subtle px-1 py-0.5 font-mono text-[10px] text-fg-muted">
                  {toolCount} tool{toolCount === 1 ? "" : "s"}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function VerboseTranscript({
  history,
  pending,
  streamText,
  streamTools,
  busy,
}: {
  history: ChatHistoryEntry[];
  pending: { role: "user"; text: string } | null;
  streamText: string;
  streamTools: StreamToolUse[];
  busy: boolean;
}) {
  type Row = {
    role: string;
    ts: string;
    text?: string;
    tool_name?: string;
    tool_input?: unknown;
    tool_output?: unknown;
    tool_error?: boolean;
  };
  const rows: Row[] = history.map((h) => ({
    role: h.role,
    ts: h.ts,
    text: h.text,
    tool_name: h.tool_name,
    tool_input: h.tool_input,
    tool_output: h.tool_output,
    tool_error: h.tool_error,
  }));
  // Append in-flight overlay (pending user + streaming assistant +
  // running tools) — explicitly NOT deduped against history here.
  // Verbose's job is to show the rail's literal state including any
  // optimistic-but-not-persisted entries.
  const nowIso = new Date().toISOString();
  if (pending && !history.some((h) => h.role === "user" && h.text === pending.text)) {
    rows.push({ role: "user (pending)", ts: nowIso, text: pending.text });
  }
  for (const t of streamTools) {
    rows.push({
      role: `tool_${t.status}`,
      ts: nowIso,
      tool_name: t.name,
      tool_input: t.input,
      tool_output: t.output,
    });
  }
  if (streamText) {
    rows.push({ role: "assistant (stream)", ts: nowIso, text: streamText });
  }
  if (busy) {
    rows.push({ role: "status", ts: nowIso, text: "turn in flight" });
  }
  if (rows.length === 0) return <p className="text-xs text-fg-muted">No events yet.</p>;
  return (
    <div className="flex flex-col gap-1.5 font-mono text-[11px]">
      {rows.map((r, i) => (
        <VerboseRow key={i} row={r} />
      ))}
    </div>
  );
}

function VerboseRow({
  row,
}: {
  row: {
    role: string;
    ts: string;
    text?: string;
    tool_name?: string;
    tool_input?: unknown;
    tool_output?: unknown;
    tool_error?: boolean;
  };
}) {
  const [open, setOpen] = useState(false);
  const hasPayload =
    row.tool_input !== undefined ||
    row.tool_output !== undefined ||
    Boolean(row.text && row.text.length > 80);
  return (
    <div className="rounded border border-border-subtle bg-bg-inset px-2 py-1">
      <button
        type="button"
        onClick={() => hasPayload && setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 text-left",
          hasPayload && "cursor-pointer",
        )}
      >
        <span className="shrink-0 text-fg-muted">{shortTime(row.ts)}</span>
        <span
          className={cn(
            "shrink-0 rounded px-1 py-0.5 text-[10px] uppercase tracking-wider",
            row.role.startsWith("tool")
              ? row.tool_error
                ? "bg-danger/15 text-danger"
                : "bg-accent/15 text-accent"
              : row.role.startsWith("user")
                ? "bg-bg text-fg-subtle"
                : "bg-bg text-fg-muted",
          )}
        >
          {row.role}
        </span>
        {row.tool_name && (
          <span className="shrink-0 font-mono text-fg-subtle">{row.tool_name}</span>
        )}
        <span className="min-w-0 flex-1 truncate text-fg-subtle">
          {row.text ?? ""}
        </span>
        {hasPayload && (
          <span className="shrink-0 text-fg-muted">{open ? "▾" : "▸"}</span>
        )}
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-1 text-fg-subtle">
          {row.text && row.text.length > 80 && (
            <pre className="whitespace-pre-wrap break-words">{row.text}</pre>
          )}
          {row.tool_input !== undefined && (
            <details className="flex flex-col">
              <summary className="cursor-pointer text-[10px] text-fg-muted">
                input
              </summary>
              <pre className="overflow-x-auto rounded border border-border-subtle bg-bg p-1 text-[10px]">
                {safeStringify(row.tool_input)}
              </pre>
            </details>
          )}
          {row.tool_output !== undefined && (
            <details className="flex flex-col">
              <summary className="cursor-pointer text-[10px] text-fg-muted">
                output
              </summary>
              <pre className="overflow-x-auto rounded border border-border-subtle bg-bg p-1 text-[10px]">
                {safeStringify(row.tool_output)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function firstSentence(s: string): string {
  if (!s) return "";
  const m = s.match(/^[^.!?\n]+[.!?]?/);
  return (m?.[0] ?? s).slice(0, 180).trim();
}

function shortTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return ts.slice(11, 19);
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
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
export interface StreamToolUse {
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
export interface ClaudeStreamEvent {
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
export function applyStreamEvent(
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
