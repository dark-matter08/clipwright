// Record-additional-video dialog — SRS F-REC-1 in a multi-video project.
//
// Reachable from the Videos sidebar. Targets a specific video_id inside
// the *currently open* project. The base URL defaults to the project's
// project.json#base_url so chapter-2 / chapter-3 recordings don't need
// to re-enter it.
//
// Recording opens a real browser window via Playwright; on completion
// the new video appears in the Videos sidebar and the editor switches
// to it.

import { useState } from "react";
import { recordProject } from "../lib/tauri";
import { useApp } from "../lib/store";
import type { Aspect } from "../lib/types";
import { cn } from "../lib/cn";

interface Props {
  /** Optional preset id — passed when the user picked "Re-record"
   *  from a sidebar item rather than "+ Record video". */
  presetVideoId?: string;
  onClose: () => void;
}

const VIDEO_ID_RE = /^[a-z][a-z0-9_-]*$/;

export function RecordVideoDialog({ presetVideoId, onClose }: Props) {
  const project = useApp((s) => s.project);
  const loadProject = useApp((s) => s.loadProject);
  const setError = useApp((s) => s.setError);
  const [videoId, setVideoId] = useState(presetVideoId ?? suggestVideoId(project?.videos.map((v) => v.video_id) ?? []));
  const [videoTitle, setVideoTitle] = useState("");
  const [baseUrlOverride, setBaseUrlOverride] = useState("");
  const [aspectOverride, setAspectOverride] = useState<Aspect | null>(null);
  const [mobile, setMobile] = useState(true);
  const [busy, setBusy] = useState(false);

  if (!project) return null;
  const isReplacing = !!presetVideoId;
  const projectBaseUrl = project.project.base_url ?? "";
  const projectAspect = (project.project.aspect ?? "9:16") as Aspect;

  const effectiveBaseUrl = (baseUrlOverride || projectBaseUrl).trim();
  const effectiveAspect = aspectOverride ?? projectAspect;
  const submitDisabled =
    !effectiveBaseUrl ||
    !VIDEO_ID_RE.test(videoId) ||
    busy;

  async function onSubmit() {
    if (submitDisabled) return;
    setBusy(true);
    try {
      const state = await recordProject({
        projectDir: project!.project_dir,
        title: "",  // project-level title left untouched on append
        aspect: effectiveAspect,
        baseUrl: effectiveBaseUrl,
        mobile,
        videoId,
        videoTitle: videoTitle.trim(),
        append: true,
      });
      loadProject(state);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div className="w-full max-w-xl rounded-lg border border-border bg-bg shadow-2xl">
        <header className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
          <h2 className="text-base font-medium">
            {isReplacing ? `Re-record ${presetVideoId}` : "Record a new video"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded p-1 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg disabled:opacity-50"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="flex flex-col gap-3 px-5 py-4">
          <p className="text-xs text-fg-muted">
            Drives Playwright against the URL below and seeds a new video in{" "}
            <span className="font-mono">{project.project.title || project.project_dir.split("/").pop()}</span>.
            Existing videos in the project are untouched.
          </p>

          <FieldRow label="Video id">
            <TextInput
              value={videoId}
              onChange={setVideoId}
              placeholder="chapter-2-recap"
              monospace
              disabled={isReplacing}
            />
            {!VIDEO_ID_RE.test(videoId) && (
              <p className="mt-1 text-[11px] text-warn">
                Must match <code className="font-mono">[a-z][a-z0-9_-]*</code>.
              </p>
            )}
          </FieldRow>

          <FieldRow label="Video title">
            <TextInput
              value={videoTitle}
              onChange={setVideoTitle}
              placeholder="Chapter 2 — Northern Front"
            />
          </FieldRow>

          <FieldRow label="Base URL">
            <TextInput
              value={baseUrlOverride}
              onChange={setBaseUrlOverride}
              placeholder={projectBaseUrl || "https://staging.example.com"}
              monospace
            />
            {projectBaseUrl && !baseUrlOverride && (
              <p className="mt-1 font-mono text-[10px] text-fg-muted">
                using project default: {projectBaseUrl}
              </p>
            )}
          </FieldRow>

          <FieldRow label="Aspect">
            <div className="flex gap-1">
              {(["9:16", "16:9", "1:1"] as Aspect[]).map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAspectOverride(a)}
                  className={cn(
                    "rounded border px-3 py-1 font-mono text-xs transition-colors",
                    effectiveAspect === a
                      ? "border-accent bg-bg-raised text-fg"
                      : "border-border-subtle text-fg-subtle hover:border-border hover:text-fg",
                  )}
                >
                  {a}
                </button>
              ))}
              <span className="self-center pl-2 font-mono text-[10px] text-fg-muted">
                project default: {projectAspect}
              </span>
            </div>
          </FieldRow>

          <FieldRow label="Viewport">
            <div className="flex items-center gap-3 text-xs">
              <label className="flex cursor-pointer items-center gap-1.5">
                <input type="radio" checked={mobile} onChange={() => setMobile(true)} className="accent-accent" />
                <span className="text-fg-subtle">Mobile 540×960</span>
              </label>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input type="radio" checked={!mobile} onChange={() => setMobile(false)} className="accent-accent" />
                <span className="text-fg-subtle">Desktop 1280×800</span>
              </label>
            </div>
          </FieldRow>

          {busy && (
            <div className="flex items-center gap-2 rounded bg-bg-inset px-3 py-2 text-xs text-fg-muted">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" />
              Recording — a Playwright Chromium window should open shortly.
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitDisabled}
            className={cn(
              "rounded px-4 py-1.5 text-xs font-medium transition-colors",
              "disabled:cursor-not-allowed disabled:bg-bg-raised disabled:text-fg-muted",
              "enabled:bg-accent enabled:text-bg enabled:hover:bg-accent-hover",
            )}
          >
            {busy ? "Recording…" : isReplacing ? "Re-record" : "Record"}
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[100px_1fr] items-start gap-3">
      <span className="pt-1.5 text-xs text-fg-muted">{label}</span>
      <div>{children}</div>
    </label>
  );
}

function TextInput({
  value, onChange, placeholder, monospace, disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  monospace?: boolean;
  disabled?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className={cn(
        "w-full rounded border border-border-subtle bg-bg-inset px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted focus:focus-ring",
        monospace && "font-mono",
        disabled && "cursor-not-allowed opacity-60",
      )}
    />
  );
}

function suggestVideoId(existing: string[]): string {
  const taken = new Set(existing);
  for (let i = 2; i < 1000; i++) {
    const candidate = `chapter-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return "chapter-x";
}
