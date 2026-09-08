// Transcript model — group the flat `ChatHistoryEntry[]` stream emitted
// by the Rust chat-log writer into a structured `Turn[]` that the
// transcript view modes (Normal / Thinking / Verbose / Summary) all
// consume.
//
// **Why a grouper?** The on-disk JSONL is a sequence of typed rows:
//   user → tool_use → tool_use → tool_result → tool_use → tool_result
//        → assistant
// Rendering that flat is the source of two complaints:
//   1. tool_use chips appear as orphan rows between USER and ASSISTANT
//      headers, which reads as a broken transcript.
//   2. The in-memory `pending` and live-stream state was rendered as
//      SEPARATE elements after the history map — so when the disk
//      caught up with the in-flight user message, both rendered and
//      the user saw two "USER resume" bubbles.
//
// The grouper produces `Turn[]` where each Turn carries a user message,
// the assistant reply (text), and the tool calls executed during that
// turn (already paired with their results). The renderers don't have
// to know about flat JSONL anymore; they just walk turns.

import type { ChatHistoryEntry } from "./tauri";

/** A paired tool call — `input` is captured at `tool_use` time;
 *  `output` lands when the matching `tool_result` arrives.
 *  Status reflects the result row's `is_error` flag once we see it. */
export interface TurnTool {
  id: string;
  name: string;
  status: "running" | "ok" | "error";
  input: unknown;
  output: unknown;
}

/** One assistant text block. Stream-json can emit multiple text
 *  blocks per turn (when the model interleaves text + tools); we
 *  preserve their order so Verbose mode can show them as separate
 *  rows while Normal mode joins them with blank lines. */
export interface TurnAssistantText {
  text: string;
  /** ISO timestamp from the originating row. */
  ts: string;
}

/** One thinking block from extended-thinking turns. Present when
 *  the stream-json carries `type: "thinking"` events. */
export interface TurnThinking {
  text: string;
  ts: string;
}

export interface Turn {
  /** Stable id derived from the user-row index so React keys stay
   *  stable across re-renders even if entries above get edited. */
  id: string;
  /** Wall-clock of the user message — anchors the turn for Verbose
   *  timestamps and Summary-mode ordering. */
  ts: string;
  /** What the user typed. Empty when the turn opens with a
   *  tool/system row (rare but happens for resumed sessions). */
  userText: string;
  /** Assistant text blocks in emission order. */
  assistant: TurnAssistantText[];
  /** Thinking blocks in emission order — only populated when the
   *  upstream stream-json had thinking events. */
  thinking: TurnThinking[];
  /** Tool calls inside this turn, paired with their results. */
  tools: TurnTool[];
  /** True when the turn carries no assistant reply yet — drives the
   *  live-bubble / spinner in the Normal renderer and the "in
   *  flight" badge in Verbose. */
  inFlight: boolean;
  /** True iff this turn was a failure surfaced via the catch-path
   *  trailer (assistant text starts with the `⚠ Turn failed` marker).
   *  Lets the renderer style it as an error. */
  errored: boolean;
}

/** Optional in-flight overlay — the optimistic `pending` user bubble
 *  + live streaming assistant text + running tool chips. The grouper
 *  merges these with the persisted history so the renderer doesn't
 *  have to special-case "in-flight" rows. */
export interface InFlightOverlay {
  userText: string | null;
  streamText: string;
  streamTools: TurnTool[];
}

/**
 * Group the flat history into turns. The contract:
 *
 *   - A new turn starts on every `user` row.
 *   - `tool_use` and `tool_result` rows attach to the current turn.
 *     If they precede the first user row (resumed-session edge case)
 *     they attach to a synthetic "preamble" turn with empty userText.
 *   - `assistant` rows attach to the current turn's `assistant` list.
 *   - Multiple consecutive `assistant` rows are kept as separate
 *     blocks (Verbose mode shows them; Normal joins with newlines).
 *   - The in-flight overlay (if provided) appends to the LAST turn
 *     when its userText matches `overlay.userText` (i.e. the
 *     persisted user row IS the optimistic pending message —
 *     **this is the dedupe**), otherwise it appends as a fresh turn.
 *
 * Pure — no side effects, no React.
 */
export function groupIntoTurns(
  history: ChatHistoryEntry[],
  overlay: InFlightOverlay | null = null,
  busy: boolean = false,
): Turn[] {
  const turns: Turn[] = [];

  function nextId(): string {
    return `turn-${turns.length}`;
  }

  function startTurn(userText: string, ts: string): Turn {
    const t: Turn = {
      id: nextId(),
      ts,
      userText,
      assistant: [],
      thinking: [],
      tools: [],
      inFlight: false,
      errored: false,
    };
    turns.push(t);
    return t;
  }

  // First pass: walk history and build turns.
  for (const row of history) {
    if (row.role === "user") {
      startTurn(row.text, row.ts);
      continue;
    }
    // Ensure we always have a current turn — synthetic preamble for
    // orphan rows. Empty userText means "no user message originated
    // this turn" (resumed session, system bootstrapping, etc.).
    const cur = turns[turns.length - 1] ?? startTurn("", row.ts);
    if (row.role === "assistant") {
      const text = (row.text ?? "").trim();
      if (text) {
        cur.assistant.push({ text: row.text, ts: row.ts });
        if (text.startsWith("⚠ Turn failed") || text.startsWith("**⚠ Turn failed")) {
          cur.errored = true;
        }
      }
      continue;
    }
    if (row.role === "tool_use") {
      cur.tools.push({
        id: row.tool_id ?? "",
        name: row.tool_name ?? "tool",
        // Optimistic "ok" — if a paired tool_result arrives we may
        // flip to "error". Default ok means an unpaired tool_use
        // (e.g. mid-turn save) doesn't show as a red broken row.
        status: "ok",
        input: row.tool_input,
        output: undefined,
      });
      continue;
    }
    if (row.role === "tool_result") {
      const id = row.tool_id ?? "";
      // Pair backwards within the CURRENT turn first. ES2023's
      // `findLast` isn't in our target lib; the manual reverse-find
      // is equivalent and works on any ES2015+ target.
      const partner = cur.tools
        .slice()
        .reverse()
        .find((t: TurnTool) => t.id && t.id === id);
      if (partner) {
        partner.output = row.tool_output;
        partner.status = row.tool_error ? "error" : "ok";
      } else {
        // Orphan result — render as a degenerate chip so the user
        // sees the data instead of silently dropping it.
        cur.tools.push({
          id,
          name: "tool_result (orphaned)",
          status: row.tool_error ? "error" : "ok",
          input: undefined,
          output: row.tool_output,
        });
      }
      continue;
    }
    if (row.role === "thinking") {
      const text = (row.text ?? "").trim();
      if (text) {
        cur.thinking.push({ text: row.text, ts: row.ts });
      }
      continue;
    }
    // Unknown roles are dropped silently — older logs may carry
    // shapes we don't render, and we want forward-compat reads.
  }

  // Second pass: merge the in-flight overlay.
  if (overlay) {
    const last = turns[turns.length - 1];
    // Dedupe: if the last turn's user text matches the overlay's
    // user text, this is the SAME turn — just merge the live stream
    // into it instead of creating a new one. This is what kills the
    // "two USER resume bubbles" bug.
    const sameTurn =
      overlay.userText != null &&
      last &&
      last.userText.trim() === overlay.userText.trim() &&
      // …and we haven't yet seen the final assistant reply for it.
      last.assistant.length === 0;
    let target: Turn;
    if (sameTurn) {
      target = last;
    } else {
      target = startTurn(overlay.userText ?? "", new Date().toISOString());
    }
    if (overlay.streamText.trim()) {
      target.assistant.push({
        text: overlay.streamText,
        ts: new Date().toISOString(),
      });
    }
    // Stream tools merge in the same way — pair by id, preserve
    // order, don't double up.
    for (const tool of overlay.streamTools) {
      const existing = target.tools.find((t) => t.id && t.id === tool.id);
      if (existing) {
        // Stream may flip a "running" → "ok"/"error". Keep input
        // from whichever side was earlier (history wins; overlay
        // only fills output / status).
        existing.status = tool.status;
        if (existing.output === undefined && tool.output !== undefined) {
          existing.output = tool.output;
        }
      } else {
        target.tools.push(tool);
      }
    }
    target.inFlight = busy;
  }

  return turns;
}

/** Convenience — a stable, deterministic id for the "live" turn so
 *  React doesn't unmount the in-flight bubble every animation tick. */
export const LIVE_TURN_KEY = "turn-live";
