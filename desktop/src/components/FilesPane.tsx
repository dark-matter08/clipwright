import { useEffect, useMemo, useState } from "react";
import { listProjectFiles, onArtifactChange, type FileEntry } from "../lib/ipc";
import { I } from "../lib/icons";

export function FilesPane({
  projectPath,
  onOpenFile,
}: {
  projectPath: string;
  onOpenFile: (absPath: string, rel: string) => void;
}) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["out"]));
  const [collapsed, setCollapsed] = useState(false);

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
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="flex items-center justify-between border-b border-border bg-panel/40 px-2 py-1 font-mono text-[11px] uppercase text-muted hover:text-fg"
      >
        <span className="flex items-center gap-1.5">
          {collapsed ? <I.ChevronRight size={11} /> : <I.ChevronDown size={11} />}
          <I.Folder size={11} className="text-accent/70" />
          <span>files</span>
          <span className="normal-case text-[10px] text-muted/70">· {files.length}</span>
        </span>
      </button>
      {!collapsed && (
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
                className="flex w-full items-center gap-1.5 px-2 py-[2px] text-left hover:bg-panel/50"
                style={{ paddingLeft: `${depth * 12 + 8}px` }}
              >
                {f.isDir ? (
                  <>
                    {isOpen ? (
                      <I.ChevronDown size={10} className="shrink-0 text-muted" />
                    ) : (
                      <I.ChevronRight size={10} className="shrink-0 text-muted" />
                    )}
                    {isOpen ? (
                      <I.FolderOpen size={11} className="shrink-0 text-accent" />
                    ) : (
                      <I.Folder size={11} className="shrink-0 text-accent/70" />
                    )}
                    <span className="flex-1 truncate text-accent">{f.name}</span>
                  </>
                ) : (
                  <>
                    <span className="w-[10px] shrink-0" />
                    <FileKindIcon name={f.name} />
                    <span className="flex-1 truncate text-fg hover:text-accent">{f.name}</span>
                    <span className="shrink-0 text-[10px] text-muted">{fmtSize(f.size)}</span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FileKindIcon({ name }: { name: string }) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".mp4") || lower.endsWith(".mov") || lower.endsWith(".webm")) {
    return <I.Film size={11} className="shrink-0 text-accent2" />;
  }
  if (lower.endsWith(".mp3") || lower.endsWith(".wav") || lower.endsWith(".m4a")) {
    return <I.Music size={11} className="shrink-0 text-accent2" />;
  }
  if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".webp")) {
    return <I.Image size={11} className="shrink-0 text-muted" />;
  }
  if (lower.endsWith(".json") || lower.endsWith(".yaml") || lower.endsWith(".yml") || lower.endsWith(".toml")) {
    return <I.FileText size={11} className="shrink-0 text-muted" />;
  }
  return <I.File size={11} className="shrink-0 text-muted" />;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}
