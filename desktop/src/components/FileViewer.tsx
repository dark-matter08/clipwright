import { useEffect, useState } from "react";
import { readTextFile } from "../lib/ipc";
import { I } from "../lib/icons";

export function FileViewer({
  absPath,
  rel,
  onClose,
}: {
  absPath: string;
  rel: string;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setContent(null);
    setError(null);
    readTextFile(absPath)
      .then((s) => setContent(pretty(rel, s)))
      .catch((e) => setError(String(e)));
  }, [absPath, rel]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border bg-panel/60 px-3 py-1.5 font-mono text-xs">
        <span className="flex items-center gap-1.5 text-accent">
          <I.FileText size={12} />
          <span>{rel}</span>
        </span>
        <button
          onClick={onClose}
          className="flex items-center gap-1 rounded p-1 text-muted hover:bg-panel hover:text-fg"
        >
          <I.X size={12} />
          <span className="text-[10px] uppercase">close</span>
        </button>
      </div>
      <div className="flex-1 overflow-auto px-3 py-2 font-mono text-xs">
        {error && <p className="text-accent2">{error}</p>}
        {content === null && !error && <p className="text-muted">// loading…</p>}
        {content !== null && (
          <pre className="whitespace-pre-wrap text-fg">{content}</pre>
        )}
      </div>
    </div>
  );
}

function pretty(rel: string, raw: string): string {
  if (rel.endsWith(".json")) {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }
  return raw;
}
