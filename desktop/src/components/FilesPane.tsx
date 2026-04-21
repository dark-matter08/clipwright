import { useEffect, useMemo, useState } from "react";
import { listProjectFiles, onArtifactChange, type FileEntry } from "../lib/ipc";

export function FilesPane({
  projectPath,
  onOpenFile,
}: {
  projectPath: string;
  onOpenFile: (absPath: string, rel: string) => void;
}) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["out"]));

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      listProjectFiles(projectPath).then((f) => {
        if (alive) setFiles(f);
      });
    };
    refresh();
    let un: (() => void) | undefined;
    onArtifactChange(refresh).then((f) => (un = f));
    return () => {
      alive = false;
      un?.();
    };
  }, [projectPath]);

  const visible = useMemo(() => {
    return files.filter((f) => {
      const parts = f.rel.split("/");
      if (parts.length === 1) return true;
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join("/");
        if (!expanded.has(parent)) return false;
      }
      return true;
    });
  }, [files, expanded]);

  function toggle(rel: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden border-t border-border">
      <div className="border-b border-border px-2 py-1 font-mono text-[11px] uppercase text-muted">
        files
      </div>
      <div className="flex-1 overflow-y-auto py-1 font-mono text-[11px]">
        {visible.length === 0 && <p className="px-2 text-muted">// empty</p>}
        {visible.map((f) => {
          const depth = f.rel.split("/").length - 1;
          const isOpen = expanded.has(f.rel);
          return (
            <button
              key={f.rel}
              onClick={() =>
                f.isDir ? toggle(f.rel) : onOpenFile(`${projectPath}/${f.rel}`, f.rel)
              }
              className="flex w-full items-baseline justify-between gap-2 px-2 py-[2px] text-left hover:bg-panel/50"
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
            >
              <span className={f.isDir ? "text-accent" : "text-fg hover:text-accent"}>
                {f.isDir ? (isOpen ? "▾ " : "▸ ") : ""}
                {f.name}
              </span>
              {!f.isDir && (
                <span className="shrink-0 text-[10px] text-muted">{fmtSize(f.size)}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}
