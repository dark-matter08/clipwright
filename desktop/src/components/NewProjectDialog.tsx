// New Project dialog — SRS §8.4 + §6.1.a/b.
//
// Two equal modes: Record (Playwright-driven) and Upload (any video).
// One modal, three steps:
//   1. Pick mode.
//   2. Fill mode-specific config.
//   3. Submit → subprocess → land in Workspace.
//
// The Claude-authored plan draft (F-REC-2) is intentionally deferred to
// P1.9 when Mode B subprocess invocation lands; for P1.2 a user-supplied
// starter plan is created automatically.

import { useEffect, useMemo, useState } from "react";
import {
  clipwrightDoctor,
  importVideo,
  pickProjectDir,
  pickVideoFile,
  recordProject,
} from "../lib/tauri";
import type { Aspect } from "../lib/types";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";

type Step = "mode" | "upload" | "record" | "running";

interface Props {
  onClose: () => void;
}

export function NewProjectDialog({ onClose }: Props) {
  const loadProject = useApp((s) => s.loadProject);
  const setError = useApp((s) => s.setError);
  const [step, setStep] = useState<Step>("mode");
  const [doctorOk, setDoctorOk] = useState<boolean | null>(null);
  const [doctorPath, setDoctorPath] = useState<string | null>(null);

  useEffect(() => {
    clipwrightDoctor()
      .then((r) => {
        setDoctorOk(r.installed);
        setDoctorPath(r.path);
      })
      .catch(() => setDoctorOk(false));
  }, []);

  function handleEsc(e: React.KeyboardEvent) {
    if (e.key === "Escape" && step !== "running") onClose();
  }

  async function handleSubmit(action: () => Promise<void>) {
    setStep("running");
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("mode");
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onKeyDown={handleEsc}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div className="w-full max-w-2xl rounded-lg border border-border bg-bg shadow-2xl">
        <header className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
          <h2 className="text-base font-medium">New Project</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={step === "running"}
            className="rounded p-1 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg disabled:opacity-50"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="px-5 py-5">
          {doctorOk === false && (
            <DoctorBanner path={doctorPath} />
          )}

          {step === "mode" && (
            <ModeChooser onPick={(m) => setStep(m)} doctorOk={doctorOk !== false} />
          )}

          {step === "upload" && (
            <UploadStep
              onBack={() => setStep("mode")}
              onSubmit={(args) =>
                handleSubmit(async () => {
                  const state = await importVideo(args);
                  loadProject(state);
                  onClose();
                })
              }
            />
          )}

          {step === "record" && (
            <RecordStep
              onBack={() => setStep("mode")}
              onSubmit={(args) =>
                handleSubmit(async () => {
                  const state = await recordProject(args);
                  loadProject(state);
                  onClose();
                })
              }
            />
          )}

          {step === "running" && <RunningState />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — mode chooser (SRS §8.4)
// ---------------------------------------------------------------------------

function ModeChooser({
  onPick,
  doctorOk,
}: {
  onPick: (m: "record" | "upload") => void;
  doctorOk: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <ModeCard
        icon="🎬"
        label="Record with Claude"
        sub="Drive a browser flow with an agent"
        onClick={() => onPick("record")}
        disabled={!doctorOk}
      />
      <ModeCard
        icon="⬆"
        label="Upload a video"
        sub="MP4 / MOV / WebM from disk"
        onClick={() => onPick("upload")}
        disabled={!doctorOk}
      />
    </div>
  );
}

function ModeCard(props: {
  icon: string;
  label: string;
  sub: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className={cn(
        "flex flex-col items-start gap-2 rounded border border-border-subtle bg-bg-subtle p-5 text-left transition-colors",
        "hover:border-border hover:bg-bg-raised",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "focus:focus-ring",
      )}
    >
      <span className="text-2xl">{props.icon}</span>
      <span className="text-sm font-medium text-fg">{props.label}</span>
      <span className="text-xs text-fg-muted">{props.sub}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Step 2a — Upload (F-UPL-1/2)
// ---------------------------------------------------------------------------

function UploadStep({
  onBack,
  onSubmit,
}: {
  onBack: () => void;
  onSubmit: (args: {
    videoPath: string;
    projectDir: string;
    title: string;
    aspect: Aspect;
    autoSegment: boolean;
    sceneDetection: boolean;
  }) => void;
}) {
  const [videoPath, setVideoPath] = useState<string>("");
  const [parentDir, setParentDir] = useState<string>("");
  const [name, setName] = useState<string>("");
  const [aspect, setAspect] = useState<Aspect>("9:16");
  const [autoSegment, setAutoSegment] = useState(true);
  const [sceneDetection, setSceneDetection] = useState(true);

  const videoStem = useMemo(() => stemFromPath(videoPath), [videoPath]);
  useEffect(() => {
    if (!name && videoStem) setName(videoStem);
  }, [videoStem, name]);

  const projectDir = parentDir && name ? joinPath(parentDir, name) : "";
  const submitDisabled = !videoPath || !parentDir || !name;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (submitDisabled) return;
        onSubmit({
          videoPath,
          projectDir,
          title: name,
          aspect,
          autoSegment,
          sceneDetection,
        });
      }}
      className="flex flex-col gap-3"
    >
      <FieldRow label="Video file">
        <PathPicker
          value={videoPath}
          placeholder="No file selected"
          buttonLabel="Choose…"
          onPick={async () => {
            const p = await pickVideoFile();
            if (p) setVideoPath(p);
          }}
        />
      </FieldRow>

      <FieldRow label="Save into">
        <PathPicker
          value={parentDir}
          placeholder="Pick a parent directory"
          buttonLabel="Choose…"
          onPick={async () => {
            const p = await pickProjectDir("Pick a folder to save into");
            if (p) setParentDir(p);
          }}
        />
      </FieldRow>

      <FieldRow label="Project name">
        <TextInput value={name} onChange={setName} placeholder="my-demo" />
      </FieldRow>

      <FieldRow label="Aspect">
        <AspectPicker value={aspect} onChange={setAspect} />
      </FieldRow>

      <FieldRow label="Segmentation">
        <div className="flex flex-col gap-1.5 text-xs">
          <Checkbox
            checked={autoSegment}
            onChange={setAutoSegment}
            label="Auto-segment (silence + scenes)"
          />
          <Checkbox
            checked={sceneDetection}
            onChange={setSceneDetection}
            disabled={!autoSegment}
            label="Scene-change detection"
            hint="Slower on long files; off for static screen recordings."
          />
        </div>
      </FieldRow>

      {projectDir && (
        <p className="rounded bg-bg-inset px-2 py-1.5 font-mono text-[11px] text-fg-muted">
          Will create: <span className="text-fg-subtle">{projectDir}</span>
        </p>
      )}

      <ButtonRow
        onBack={onBack}
        submitLabel="Import"
        submitDisabled={submitDisabled}
      />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 2b — Record (F-REC-1, F-REC-4, F-REC-5)
// ---------------------------------------------------------------------------

function RecordStep({
  onBack,
  onSubmit,
}: {
  onBack: () => void;
  onSubmit: (args: {
    projectDir: string;
    title: string;
    aspect: Aspect;
    baseUrl: string;
    mobile: boolean;
    videoId: string;
    videoTitle: string;
    append: boolean;
  }) => void;
}) {
  const [parentDir, setParentDir] = useState<string>("");
  const [name, setName] = useState<string>("");
  const [aspect, setAspect] = useState<Aspect>("9:16");
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [mobile, setMobile] = useState(true);
  // First-creation Record always seeds video_id="main". Records into
  // additional videos (chapter-2, etc.) happen via the Videos sidebar
  // in the Workspace, so a v2-aware id input here would be misleading.
  const videoId = "main";
  const videoTitle = name;

  const projectDir = parentDir && name ? joinPath(parentDir, name) : "";
  const submitDisabled = !parentDir || !name || !baseUrl;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (submitDisabled) return;
        onSubmit({
          projectDir, title: name, aspect, baseUrl, mobile,
          videoId, videoTitle, append: false,
        });
      }}
      className="flex flex-col gap-3"
    >
      <FieldRow label="Project name">
        <TextInput value={name} onChange={setName} placeholder="feature-launch" />
      </FieldRow>

      <FieldRow label="Save into">
        <PathPicker
          value={parentDir}
          placeholder="Pick a parent directory"
          buttonLabel="Choose…"
          onPick={async () => {
            const p = await pickProjectDir("Pick a folder to save into");
            if (p) setParentDir(p);
          }}
        />
      </FieldRow>

      <FieldRow label="Base URL">
        <TextInput
          value={baseUrl}
          onChange={setBaseUrl}
          placeholder="https://staging.example.com"
          monospace
        />
      </FieldRow>

      <FieldRow label="Aspect">
        <AspectPicker value={aspect} onChange={setAspect} />
      </FieldRow>

      <FieldRow label="Viewport">
        <div className="flex items-center gap-3 text-xs">
          <RadioOption
            checked={mobile}
            onChange={() => setMobile(true)}
            label="Mobile 540×960"
          />
          <RadioOption
            checked={!mobile}
            onChange={() => setMobile(false)}
            label="Desktop 1280×800"
          />
        </div>
      </FieldRow>

      <p className="rounded bg-bg-inset px-3 py-2 text-[11px] text-fg-muted">
        A starter <code className="font-mono">browse-plan.json</code> with one
        navigate action is generated. Edit it (or ask Claude to draft a real
        plan — P1.9) before re-recording. Recording opens a real browser
        window via Playwright. Need additional chapter / episode videos?
        Use <span className="text-fg-subtle">"+ Record video"</span> in the
        Videos sidebar after this project loads.
      </p>

      <ButtonRow
        onBack={onBack}
        submitLabel="Record"
        submitDisabled={submitDisabled}
      />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — running
// ---------------------------------------------------------------------------

function RunningState() {
  return (
    <div className="flex flex-col items-center gap-3 py-8 text-sm text-fg-muted">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" />
      <p>Running clipwright…</p>
      <p className="text-xs text-fg-muted/70">
        First Kokoro download or the Playwright cold-start can take a minute.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable bits
// ---------------------------------------------------------------------------

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[120px_1fr] items-start gap-3">
      <span className="pt-1.5 text-xs text-fg-muted">{label}</span>
      <div>{children}</div>
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  monospace,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  monospace?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn(
        "w-full rounded border border-border-subtle bg-bg-inset px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted",
        "focus:focus-ring",
        monospace && "font-mono",
      )}
    />
  );
}

function PathPicker({
  value,
  placeholder,
  buttonLabel,
  onPick,
}: {
  value: string;
  placeholder: string;
  buttonLabel: string;
  onPick: () => void;
}) {
  return (
    <div className="flex items-stretch gap-1.5">
      <input
        type="text"
        readOnly
        value={value}
        placeholder={placeholder}
        className="w-full truncate rounded border border-border-subtle bg-bg-inset px-2 py-1.5 font-mono text-xs text-fg placeholder:text-fg-muted"
      />
      <button
        type="button"
        onClick={onPick}
        className="shrink-0 rounded border border-border-subtle bg-bg-raised px-3 text-xs text-fg-subtle transition-colors hover:bg-bg-inset hover:text-fg focus:focus-ring"
      >
        {buttonLabel}
      </button>
    </div>
  );
}

function AspectPicker({
  value,
  onChange,
}: {
  value: Aspect;
  onChange: (v: Aspect) => void;
}) {
  const options: Aspect[] = ["9:16", "16:9", "1:1"];
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          className={cn(
            "rounded border px-3 py-1 font-mono text-xs transition-colors",
            value === o
              ? "border-accent bg-bg-raised text-fg"
              : "border-border-subtle text-fg-subtle hover:border-border hover:text-fg",
          )}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-[2px] accent-accent"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-fg-subtle">{label}</span>
        {hint && <span className="text-fg-muted/70 text-[10px]">{hint}</span>}
      </span>
    </label>
  );
}

function RadioOption({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5">
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        className="accent-accent"
      />
      <span className="text-fg-subtle">{label}</span>
    </label>
  );
}

function ButtonRow({
  onBack,
  submitLabel,
  submitDisabled,
}: {
  onBack: () => void;
  submitLabel: string;
  submitDisabled: boolean;
}) {
  return (
    <div className="mt-1 flex items-center justify-between border-t border-border-subtle pt-3">
      <button
        type="button"
        onClick={onBack}
        className="rounded px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg"
      >
        ← Back
      </button>
      <button
        type="submit"
        disabled={submitDisabled}
        className={cn(
          "rounded px-4 py-1.5 text-xs font-medium transition-colors",
          "disabled:cursor-not-allowed disabled:bg-bg-raised disabled:text-fg-muted",
          "enabled:bg-accent enabled:text-bg enabled:hover:bg-accent-hover",
        )}
      >
        {submitLabel}
      </button>
    </div>
  );
}

function DoctorBanner({ path }: { path: string | null }) {
  return (
    <div className="mb-4 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
      <p className="font-medium">
        The <code className="font-mono">clipwright</code> Python CLI is not on PATH.
      </p>
      <p className="mt-1 text-fg-subtle">
        Install it (<code>./install.sh</code> at the repo root) or set the{" "}
        <code className="font-mono">CLIPWRIGHT_BIN</code> env var to its location.
        {path && (
          <>
            {" "}
            Looked under <span className="font-mono">{path}</span>.
          </>
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Path utilities — kept tiny + cross-platform aware
// ---------------------------------------------------------------------------

function joinPath(parent: string, name: string): string {
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  const trimmed = parent.replace(/[\\/]+$/, "");
  return `${trimmed}${sep}${name}`;
}

function stemFromPath(p: string): string {
  if (!p) return "";
  const base = p.split(/[\\/]/).pop() ?? "";
  return base.replace(/\.[^.]+$/, "");
}
