// Markdown renderer for Claude chat replies.
//
// Claude returns GitHub-flavored markdown — bold, lists, tables, fenced
// code, links. Rendering it as `whitespace-pre-wrap` text showed the raw
// `**asterisks**` and pipe-tables to the user. `react-markdown` +
// `remark-gfm` covers the dialect; the className overrides below pin
// every element to our design tokens so the output blends with the rail.
//
// Runnable code blocks: when the markdown contains a fenced block like
//
//   ```bash
//   clipwright render-segment seg_004 --video my-video
//   ```
//
// and the caller supplied an `onRunCommand` prop, we replace the
// stock `<pre>` rendering with a `RunnableCodeBlock` that has a Play
// button. Recognition is a simple prefix check against the same
// allow-list the Rust runner enforces — only `clipwright …` and its
// `uv run` / `uvx` / `python -m` variants are runnable.

import { useState } from "react";
import { Loader2, Play, Square } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CommandResult } from "../lib/tauri";
import { cn } from "../lib/cn";

interface MarkdownViewProps {
  text: string;
  className?: string;
  /** When provided, runnable fenced code blocks get a Play button
   *  that invokes this handler with the block's command text. The
   *  handler is responsible for running the command, surfacing
   *  errors, and refreshing project state on completion. The
   *  resolved `CommandResult` is displayed inline below the code
   *  block. */
  onRunCommand?: (command: string) => Promise<CommandResult>;
}

/** Prefixes a code block has to START with for the Play button to
 *  appear. Mirrors `CLIPWRIGHT_RUN_PREFIXES` in claude.rs — if these
 *  diverge, the UI will offer to run commands the Rust side rejects.
 *  Keep them in lockstep. */
const RUNNABLE_PREFIXES = [
  "clipwright ",
  "clipwright\n",
  "uv run clipwright ",
  "uvx clipwright ",
  "python -m clipwright ",
  "python3 -m clipwright ",
];

function isRunnableCommand(text: string): boolean {
  const t = text.trim();
  if (t === "clipwright") return true;
  return RUNNABLE_PREFIXES.some((p) => t.startsWith(p.trimEnd() + " "));
}

export function MarkdownView({ text, className, onRunCommand }: MarkdownViewProps) {
  return (
    <div className={cn("text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-2 whitespace-pre-wrap break-words">{children}</p>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-accent underline hover:text-accent-hover"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="my-2 ml-4 list-disc space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 ml-4 list-decimal space-y-1">{children}</ol>,
          li: ({ children }) => <li className="leading-snug">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ className: lang, children }) => {
            const inline = !lang;
            if (inline) {
              return (
                <code className="rounded bg-bg-inset px-1 py-0.5 font-mono text-[12px] text-fg">
                  {children}
                </code>
              );
            }
            return (
              <code className="block font-mono text-[12px] text-fg">{children}</code>
            );
          },
          // We intercept `pre` (the wrapper) rather than `code` so we
          // can REPLACE the entire <pre>/<code> structure with the
          // Runnable widget instead of nesting it inside a <pre>
          // (which would produce invalid HTML and styling clashes).
          pre: ({ children }) => {
            const raw = extractCodeText(children);
            if (raw && onRunCommand && isRunnableCommand(raw)) {
              return <RunnableCodeBlock command={raw} onRun={onRunCommand} />;
            }
            return (
              <pre className="my-2 overflow-x-auto rounded border border-border-subtle bg-bg-inset p-2 text-[12px]">
                {children}
              </pre>
            );
          },
          h1: ({ children }) => <h1 className="my-2 text-base font-semibold text-fg">{children}</h1>,
          h2: ({ children }) => <h2 className="my-2 text-sm font-semibold text-fg">{children}</h2>,
          h3: ({ children }) => <h3 className="my-2 text-sm font-semibold text-fg">{children}</h3>,
          h4: ({ children }) => <h4 className="my-2 text-sm font-medium text-fg">{children}</h4>,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-border-subtle pl-3 italic text-fg-subtle">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-border-subtle" />,
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="min-w-full border-collapse text-[12px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-bg-inset">{children}</thead>,
          th: ({ children }) => (
            <th className="border border-border-subtle px-2 py-1 text-left font-medium text-fg">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-border-subtle px-2 py-1 align-top">{children}</td>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Walk the children passed to the `pre` override and pull out the
 *  inner code element's raw text. `react-markdown` typically passes a
 *  single `<code>` child; we still defensively walk in case a future
 *  rehype transform inserts wrappers. Returns null when no recognizable
 *  code text is found. */
function extractCodeText(children: unknown): string | null {
  // The structure from react-markdown is React elements. We peek at
  // the most common shape (single code element with a string child)
  // and bail to null otherwise — the caller falls back to rendering
  // the unmodified <pre>.
  const peek = (c: unknown): string | null => {
    if (c == null) return null;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      for (const item of c) {
        const got = peek(item);
        if (got !== null) return got;
      }
      return null;
    }
    if (typeof c === "object" && c !== null && "props" in (c as Record<string, unknown>)) {
      const props = (c as { props?: Record<string, unknown> }).props;
      if (props && "children" in props) {
        return peek(props.children as unknown);
      }
    }
    return null;
  };
  const got = peek(children);
  return got ? got.trim() : null;
}

/** A fenced code block we can Play. Shows the command, a button, and
 *  the stdout/stderr inline once it's run. Re-runnable (the user
 *  might bump a render after editing). */
function RunnableCodeBlock({
  command,
  onRun,
}: {
  command: string;
  onRun: (command: string) => Promise<CommandResult>;
}) {
  const [state, setState] = useState<"idle" | "running" | "ok" | "error">(
    "idle",
  );
  const [result, setResult] = useState<CommandResult | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  async function run() {
    setState("running");
    setErrMsg(null);
    try {
      const res = await onRun(command);
      setResult(res);
      // exit_code === 0 → ok; non-zero → error styling but still
      // show the output (failed renders usually print a useful
      // traceback or "fix:" line the user wants to see).
      setState(res.exit_code === 0 ? "ok" : "error");
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      setResult(null);
      setState("error");
    }
  }

  return (
    <div className="my-2 overflow-hidden rounded border border-border-subtle bg-bg-inset">
      <div className="flex items-center gap-2 border-b border-border-subtle bg-bg-subtle px-2 py-1">
        <button
          type="button"
          onClick={() => void run()}
          disabled={state === "running"}
          title={
            state === "running"
              ? "Running…"
              : state === "ok"
                ? "Re-run this command"
                : state === "error"
                  ? "Re-run after fixing the error"
                  : "Run this command in the project's sandbox"
          }
          className={cn(
            "flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors",
            state === "running"
              ? "bg-bg-raised text-fg-muted"
              : state === "error"
                ? "bg-danger/20 text-danger hover:bg-danger/30"
                : state === "ok"
                  ? "bg-ok/20 text-ok hover:bg-ok/30"
                  : "bg-accent text-bg hover:bg-accent-hover",
          )}
        >
          {state === "running" ? (
            <>
              <Loader2 size={10} strokeWidth={2.5} className="animate-spin" />
              running
            </>
          ) : state === "ok" ? (
            <>
              <Play size={10} strokeWidth={2.5} fill="currentColor" />
              ok · re-run
            </>
          ) : state === "error" ? (
            <>
              <Square size={10} strokeWidth={2.5} fill="currentColor" />
              error · retry
            </>
          ) : (
            <>
              <Play size={10} strokeWidth={2.5} fill="currentColor" />
              run
            </>
          )}
        </button>
        <span className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
          clipwright
        </span>
        {result && (
          <span className="ml-auto font-mono text-[10px] text-fg-muted">
            {result.duration_ms < 1000
              ? `${result.duration_ms}ms`
              : `${(result.duration_ms / 1000).toFixed(1)}s`}
            {" · exit "}
            {result.exit_code}
          </span>
        )}
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all p-2 font-mono text-[12px] text-fg">
        {command}
      </pre>
      {(result || errMsg) && (
        <div className="border-t border-border-subtle">
          {errMsg && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words bg-danger/10 px-2 py-1.5 font-mono text-[11px] text-danger">
              {errMsg}
            </pre>
          )}
          {result && result.stdout && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-[11px] text-fg-subtle">
              {result.stdout}
            </pre>
          )}
          {result && result.stderr && (
            <pre
              className={cn(
                "overflow-x-auto whitespace-pre-wrap break-words border-t border-border-subtle px-2 py-1.5 font-mono text-[11px]",
                state === "error" ? "bg-danger/10 text-danger" : "text-fg-muted",
              )}
            >
              {result.stderr}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
