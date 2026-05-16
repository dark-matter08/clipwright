// Inline question/answer cards inside Claude chat replies.
//
// `claude --print` returns plain markdown — there's no native channel for
// "ask the user one of these choices." Without a structured signal, every
// question collapses to a paragraph the user has to type a reply to,
// which is the exact UX in the screenshot ("Three quick confirms…").
//
// We instead teach Claude to emit a recognizable fenced block whenever it
// wants a multiple-choice answer:
//
//   ```clipwright-ask
//   {
//     "id": "theme",
//     "question": "Which visual theme should I use?",
//     "options": [
//       { "label": "Cyberpunk", "value": "cyberpunk" },
//       { "label": "Dark fantasy", "value": "dark-fantasy" }
//     ],
//     "multi": false
//   }
//   ```
//
// `parseAskBlocks` splits one reply into alternating markdown chunks and
// parsed question objects. The rail renders markdown via `MarkdownView`
// and each question as a `QuestionCard` with clickable buttons. Clicking
// a button sends `<label>` back as the next user turn — Claude sees a
// plain natural-language answer, exactly what it would have gotten from
// typing.

import { useState } from "react";
import { MarkdownView } from "./MarkdownView";
import { cn } from "../lib/cn";

export interface AskOption {
  label: string;
  value?: string;
  hint?: string;
}

export interface AskBlock {
  id?: string;
  question: string;
  options: AskOption[];
  multi?: boolean;
  allow_freeform?: boolean;
}

export type ReplyPart =
  | { kind: "markdown"; text: string }
  | { kind: "ask"; block: AskBlock };

const FENCE_RE = /```clipwright-ask\s*\n([\s\S]*?)\n```/g;

/** Split a raw assistant reply into markdown spans + parsed question
 *  blocks. Malformed blocks (bad JSON, missing fields) fall back to
 *  rendering as plain markdown so the user still sees the question. */
export function parseAskBlocks(text: string): ReplyPart[] {
  const parts: ReplyPart[] = [];
  let last = 0;
  for (const match of text.matchAll(FENCE_RE)) {
    const idx = match.index ?? 0;
    if (idx > last) {
      parts.push({ kind: "markdown", text: text.slice(last, idx) });
    }
    const body = match[1] ?? "";
    let parsed: AskBlock | null = null;
    try {
      const raw = JSON.parse(body);
      if (
        raw &&
        typeof raw.question === "string" &&
        Array.isArray(raw.options) &&
        raw.options.every(
          (o: unknown): o is AskOption =>
            !!o && typeof (o as AskOption).label === "string",
        )
      ) {
        parsed = {
          id: typeof raw.id === "string" ? raw.id : undefined,
          question: raw.question,
          options: raw.options,
          multi: raw.multi === true,
          allow_freeform: raw.allow_freeform !== false, // default true
        };
      }
    } catch {
      parsed = null;
    }
    if (parsed) {
      parts.push({ kind: "ask", block: parsed });
    } else {
      // Couldn't parse — surface the original fenced block as markdown so
      // the user can still read the intent and the bug is visible to us.
      parts.push({ kind: "markdown", text: match[0] });
    }
    last = idx + match[0].length;
  }
  if (last < text.length) {
    parts.push({ kind: "markdown", text: text.slice(last) });
  }
  // No fenced asks at all → one markdown part covering the whole reply.
  if (parts.length === 0) parts.push({ kind: "markdown", text });
  return parts;
}

interface QuestionCardProps {
  block: AskBlock;
  /** Send a user turn back to Claude with the rendered answer. */
  onAnswer: (answer: string) => void | Promise<void>;
  /** Disabled while a previous turn is still in flight. */
  disabled?: boolean;
  /** This card belongs to an older assistant turn that has already been
   *  followed by newer messages. Clicking it now would re-litigate a
   *  decision the conversation has moved past, so we render it fully
   *  inert with a "superseded" badge to make the freeze visible. Fixes
   *  the rough UX where Claude re-asks Q2/Q3 (because batched questions
   *  in one reply only get one user turn) and the original Q2/Q3 cards
   *  stay sitting there as if still clickable. */
  stale?: boolean;
}

export function QuestionCard({ block, onAnswer, disabled, stale }: QuestionCardProps) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const frozen = stale || submitted;

  function toggle(label: string) {
    if (frozen || disabled) return;
    if (!block.multi) {
      setSubmitted(true);
      void onAnswer(label);
      return;
    }
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  function submitMulti() {
    if (frozen || disabled || picked.size === 0) return;
    setSubmitted(true);
    void onAnswer(Array.from(picked).join(", "));
  }

  return (
    <div
      className={cn(
        "my-2 rounded border border-border-subtle bg-bg-inset/60 p-2.5",
        stale && "opacity-60",
      )}
    >
      <div className="text-sm text-fg">
        <MarkdownView text={block.question} className="text-sm" />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {block.options.map((opt, i) => {
          const isPicked = picked.has(opt.label);
          return (
            <button
              key={`${opt.label}-${i}`}
              type="button"
              onClick={() => toggle(opt.label)}
              disabled={frozen || disabled}
              title={stale ? "Superseded by a later turn" : opt.hint || opt.label}
              className={cn(
                "rounded border px-2 py-1 text-xs transition-colors",
                "border-border-subtle bg-bg text-fg-subtle hover:border-accent hover:text-fg",
                isPicked && "border-accent bg-accent/15 text-fg",
                (frozen || disabled) && "cursor-not-allowed opacity-50 hover:border-border-subtle hover:text-fg-subtle",
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      {block.multi && !frozen && (
        <button
          type="button"
          onClick={submitMulti}
          disabled={disabled || picked.size === 0}
          className={cn(
            "mt-2 rounded bg-accent px-2 py-1 text-xs font-medium text-bg transition-colors hover:bg-accent-hover",
            (disabled || picked.size === 0) && "cursor-not-allowed bg-bg-raised text-fg-muted",
          )}
        >
          Send {picked.size > 0 ? `(${picked.size})` : ""}
        </button>
      )}
      {submitted && !stale && (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
          answered
        </p>
      )}
      {stale && !submitted && (
        <p
          className="mt-2 font-mono text-[10px] uppercase tracking-wider text-fg-muted"
          title="A later message has moved past this question. Ask again in chat if you still need to decide."
        >
          superseded
        </p>
      )}
    </div>
  );
}
