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
import { Check, Upload, Video as VideoIcon, X } from "lucide-react";
import {
  applyTemplates,
  clipwrightDoctor,
  importVideo,
  listTemplates,
  openProject,
  pickProjectDir,
  pickVideoFile,
  recordProject,
} from "../lib/tauri";
import type { Aspect, TemplateMeta } from "../lib/types";
import {
  defaultVoiceFor,
  VOICE_PROVIDER_OPTIONS,
  VOICES_BY_PROVIDER,
  voiceInCatalog,
  type VoiceProvider,
} from "../lib/voiceCatalog";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";
import { sanitizeVideoId } from "../lib/timeline";
import { Dropdown } from "./Dropdown";
import { VoicePreview } from "./VoicePreview";
import { TemplatePicker } from "./TemplatePicker";

// Four-stage wizard. Was a two-stage chooser-then-form before; we
// promoted Template selection to its own step (step 1) because too
// many users were sailing past the optional picker at the bottom of
// the mode screen and ending up with template-less projects. Now you
// can't reach the mode picker without binding at least one template.
//
//   1. template — pick at least one template (required, blocks step 2)
//   2. mode     — Upload vs Record
//   3. upload | record — mode-specific config form
//   4. running  — subprocess in flight
//
// Step counter at the top reads "Step 2 of 3" etc.; upload/record
// share slot 3 because from the user's POV they're the same step.
type Step = "template" | "mode" | "upload" | "record" | "running";

/** UX step number (1..3) for the counter. `upload`/`record` collapse
 *  into slot 3 because they're mode-specific variants of the same
 *  step. `running` returns 3 too — the user already submitted, no
 *  reason to bump the counter mid-flight. */
function stepIndex(step: Step): number {
  if (step === "template") return 1;
  if (step === "mode") return 2;
  return 3; // upload | record | running
}

const STEP_LABELS = ["Templates", "Mode", "Configure"] as const;

interface Props {
  onClose: () => void;
}

export function NewProjectDialog({ onClose }: Props) {
  const loadProject = useApp((s) => s.loadProject);
  const setError = useApp((s) => s.setError);
  const [step, setStep] = useState<Step>("template");
  const [doctorOk, setDoctorOk] = useState<boolean | null>(null);
  const [doctorPath, setDoctorPath] = useState<string | null>(null);
  // Template selection lives at the dialog level so it survives
  // switching between mode/upload/record steps. A project can bind
  // multiple templates — the FIRST entry is the primary, which
  // drives default project settings (aspect/fps/voice). Subsequent
  // entries only contribute behavioral guidance.
  const [templateIds, setTemplateIds] = useState<string[]>([]);
  const [templateMetas, setTemplateMetas] = useState<TemplateMeta[]>([]);
  const [templates, setTemplates] = useState<TemplateMeta[]>([]);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const primaryMeta = templateMetas[0] ?? null;
  // Project-default voice. Lives at the dialog level (not per-step)
  // so swapping between Upload and Record doesn't lose the picks. The
  // template-system primary still seeds initial values when bound, but
  // any explicit choice here wins via the `*Touched` latches below.
  const [ttsProvider, setTtsProvider] = useState<VoiceProvider>("kokoro");
  const [voiceId, setVoiceId] = useState<string>("");
  const [ttsTouched, setTtsTouched] = useState(false);
  useEffect(() => {
    if (ttsTouched) return;
    const tplProvider = primaryMeta?.defaults?.tts_provider as
      | VoiceProvider
      | undefined;
    const tplVoice = primaryMeta?.defaults?.voice_id as string | undefined;
    if (tplProvider) setTtsProvider(tplProvider);
    if (tplVoice !== undefined) setVoiceId(tplVoice);
  }, [primaryMeta?.defaults?.tts_provider, primaryMeta?.defaults?.voice_id, ttsTouched]);

  useEffect(() => {
    clipwrightDoctor()
      .then((r) => {
        setDoctorOk(r.installed);
        setDoctorPath(r.path);
      })
      .catch(() => setDoctorOk(false));
    // Catalog is small — fetch once at open and pass into children so
    // each step doesn't repeat the round-trip.
    listTemplates()
      .then(setTemplates)
      .catch((e) =>
        // Surface it — an empty catalog here is almost always a broken
        // `clipwright` install, not a genuinely empty template dir.
        setTemplatesError(e instanceof Error ? e.message : String(e)),
      );
  }, []);

  /** After a project is created, bind the chosen template (if any) and
   *  re-fetch state so the workspace reflects the binding immediately. */
  async function finalize(
    initialState: Awaited<ReturnType<typeof importVideo>>,
  ) {
    if (templateIds.length === 0) {
      loadProject(initialState);
      onClose();
      return;
    }
    // The form already syncs aspect to the primary template's
    // recommendation when the user hasn't manually touched it (see
    // AspectPicker wrapper in each step). So at apply time we honor
    // whatever the form wrote — `overwriteDefaults: false` only
    // fills in blanks. All selected templates get bound; the first
    // one is the primary.
    await applyTemplates(initialState.project_dir, templateIds, false);
    const refreshed = await openProject(
      initialState.project_dir,
      initialState.current_video_id,
    );
    loadProject(refreshed);
    onClose();
  }

  function handleEsc(e: React.KeyboardEvent) {
    if (e.key === "Escape" && step !== "running") onClose();
  }

  async function handleSubmit(action: () => Promise<void>) {
    // Remember which config step we were on so an error can bounce
    // back to the same form instead of dumping the user at the mode
    // chooser (which loses their typed-in fields).
    const previousStep = step;
    setStep("running");
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep(previousStep === "upload" || previousStep === "record"
        ? previousStep
        : "mode");
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
          <div className="flex items-baseline gap-3">
            <h2 className="text-base font-medium">New Project</h2>
            {step !== "running" && (
              <span className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                Step {stepIndex(step)} of {STEP_LABELS.length} ·{" "}
                <span className="text-fg-subtle">
                  {STEP_LABELS[stepIndex(step) - 1]}
                </span>
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={step === "running"}
            className="rounded p-1 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg disabled:opacity-50"
            aria-label="Close"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </header>

        {/* Step indicator pills — three dots that fill in as the user
         *  progresses. The active pill gets a subtle pulse on entry so
         *  the eye locks onto the new position without us animating
         *  the entire header. */}
        {step !== "running" && (
          <div className="flex items-center gap-2 border-b border-border-subtle px-5 py-2.5">
            {STEP_LABELS.map((label, i) => {
              const n = i + 1;
              const active = n === stepIndex(step);
              const done = n < stepIndex(step);
              return (
                <div key={label} className="flex items-center gap-2">
                  <span
                    className={cn(
                      "flex h-5 w-5 items-center justify-center rounded-full font-mono text-[10px] transition-colors",
                      active
                        ? "animate-pillPulse bg-accent text-bg"
                        : done
                          ? "bg-accent/30 text-accent"
                          : "bg-bg-raised text-fg-muted",
                    )}
                  >
                    {done ? <Check size={10} strokeWidth={3} /> : n}
                  </span>
                  <span
                    className={cn(
                      "text-[11px] transition-colors",
                      active
                        ? "text-fg"
                        : done
                          ? "text-fg-subtle"
                          : "text-fg-muted",
                    )}
                  >
                    {label}
                  </span>
                  {n < STEP_LABELS.length && (
                    <span
                      className={cn(
                        "ml-1 h-px w-6 transition-colors",
                        done ? "bg-accent/40" : "bg-border-subtle",
                      )}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="px-5 py-5">
          {doctorOk === false && (
            <DoctorBanner path={doctorPath} />
          )}

          {/* `key={step}` remounts the panel on step change so the
           *  `animate-stepFade` keyframes fire each time. */}
          {step === "template" && (
            <div key="template" className="flex animate-stepFade flex-col gap-4">
              <div className="flex flex-col gap-1">
                <h3 className="text-sm font-medium text-fg">
                  Choose at least one template
                </h3>
                <p className="text-xs text-fg-muted">
                  Templates inject genre-specific guidance into Claude — the
                  difference between "a video" and "a manhwa recap" or "a
                  product demo." Pick one as primary; secondaries layer
                  behavioral guidance on top.
                </p>
              </div>
              <TemplatePicker
                templates={templates}
                error={templatesError}
                values={templateIds}
                onChange={(next, metas) => {
                  setTemplateIds(next);
                  setTemplateMetas(metas);
                }}
              />
              <div className="mt-1 flex items-center justify-between border-t border-border-subtle pt-3">
                <span className="text-[11px] text-fg-muted">
                  {templateIds.length === 0
                    ? "Pick at least one template to continue."
                    : `${templateIds.length} selected · primary: ${
                        primaryMeta?.name ?? templateIds[0]
                      }`}
                </span>
                <button
                  type="button"
                  onClick={() => setStep("mode")}
                  disabled={templateIds.length === 0 || doctorOk === false}
                  className={cn(
                    "rounded px-4 py-1.5 text-xs font-medium transition-colors",
                    "disabled:cursor-not-allowed disabled:bg-bg-raised disabled:text-fg-muted",
                    "enabled:bg-accent enabled:text-bg enabled:hover:bg-accent-hover",
                  )}
                >
                  Next →
                </button>
              </div>
            </div>
          )}

          {step === "mode" && (
            <div key="mode" className="flex animate-stepFade flex-col gap-4">
              <div className="flex flex-col gap-1">
                <h3 className="text-sm font-medium text-fg">
                  How are you creating this project?
                </h3>
                <p className="text-xs text-fg-muted">
                  Upload an existing video file, or have Claude drive a
                  Playwright session and capture it.
                </p>
              </div>
              <ModeChooser
                onPick={(m) => setStep(m)}
                doctorOk={doctorOk !== false}
              />
              {primaryMeta && (
                <div className="rounded border border-border-subtle bg-bg-subtle px-3 py-2 text-[11px] text-fg-muted">
                  Will bind{" "}
                  <span className="font-medium text-fg-subtle">
                    {primaryMeta.name}
                  </span>{" "}
                  {templateIds.length > 1 &&
                    `(+ ${templateIds.length - 1} more)`}{" "}
                  as the project template.
                </div>
              )}
              <div className="mt-1 flex items-center justify-between border-t border-border-subtle pt-3">
                <button
                  type="button"
                  onClick={() => setStep("template")}
                  className="rounded px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg"
                >
                  ← Back
                </button>
                <span className="text-[11px] text-fg-muted">
                  Pick a mode above to continue.
                </span>
              </div>
            </div>
          )}

          {step === "upload" && (
            <UploadStep
              key="upload"
              templateMeta={primaryMeta}
              ttsProvider={ttsProvider}
              voiceId={voiceId}
              onTtsChange={(provider, voice) => {
                setTtsProvider(provider);
                setVoiceId(voice);
                setTtsTouched(true);
              }}
              onBack={() => setStep("mode")}
              onSubmit={(args) =>
                handleSubmit(async () => {
                  const state = await importVideo({
                    ...args,
                    ttsProvider,
                    voiceId,
                  });
                  await finalize(state);
                })
              }
            />
          )}

          {step === "record" && (
            <RecordStep
              key="record"
              templateMeta={primaryMeta}
              ttsProvider={ttsProvider}
              voiceId={voiceId}
              onTtsChange={(provider, voice) => {
                setTtsProvider(provider);
                setVoiceId(voice);
                setTtsTouched(true);
              }}
              onBack={() => setStep("mode")}
              onSubmit={(args) =>
                handleSubmit(async () => {
                  const state = await recordProject({
                    ...args,
                    ttsProvider,
                    voiceId,
                  });
                  await finalize(state);
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
        icon={<VideoIcon size={22} strokeWidth={1.75} />}
        label="Record with Claude"
        sub="Drive a browser flow with an agent"
        onClick={() => onPick("record")}
        disabled={!doctorOk}
      />
      <ModeCard
        icon={<Upload size={22} strokeWidth={1.75} />}
        label="Upload a video"
        sub="MP4 / MOV / WebM from disk"
        onClick={() => onPick("upload")}
        disabled={!doctorOk}
      />
    </div>
  );
}

function ModeCard(props: {
  icon: React.ReactNode;
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
      <span className="text-fg-subtle">{props.icon}</span>
      <span className="text-sm font-medium text-fg">{props.label}</span>
      <span className="text-xs text-fg-muted">{props.sub}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Step 2a — Upload (F-UPL-1/2)
// ---------------------------------------------------------------------------

function UploadStep({
  templateMeta,
  ttsProvider,
  voiceId,
  onTtsChange,
  onBack,
  onSubmit,
}: {
  templateMeta: TemplateMeta | null;
  ttsProvider: VoiceProvider;
  voiceId: string;
  onTtsChange: (provider: VoiceProvider, voice: string) => void;
  onBack: () => void;
  onSubmit: (args: {
    videoPath: string;
    projectDir: string;
    title: string;
    aspect: Aspect;
    autoSegment: boolean;
    sceneDetection: boolean;
    videoId: string;
    videoTitle: string;
  }) => void;
}) {
  const [videoPath, setVideoPath] = useState<string>("");
  const [parentDir, setParentDir] = useState<string>("");
  const [name, setName] = useState<string>("");
  // First-video title. Distinct from the project name because a
  // project is a *collection* — the user might later add a chapter-2
  // video alongside the chapter-1 they're uploading right now. This
  // field titles only the FIRST video; subsequent ones come from the
  // sidebar's "+ New video" / "+ Record video" flows. Defaults to the
  // uploaded file's stem so the common case is one-click; rename
  // freely.
  const [firstVideoTitle, setFirstVideoTitle] = useState<string>("");
  // The `videoId` is the on-disk slug for this video — drives every
  // per-video path (`videos/<id>.json`, `out/segments/<id>/`,
  // `voiceover/audio/<id>/`, etc.). We sanitize the title live so the
  // user sees what's going to land on disk.
  const firstVideoId = useMemo(
    () => sanitizeVideoId(firstVideoTitle) || "main",
    [firstVideoTitle],
  );
  // `aspect` tracks the template's recommendation by default. Once the
  // user manually clicks an AspectPicker option, `aspectTouched` flips
  // and we stop syncing — their explicit choice survives any further
  // template change. Default is 9:16 (short-form) until told otherwise.
  const [aspect, setAspect] = useState<Aspect>(
    (templateMeta?.defaults?.aspect as Aspect | undefined) ?? "9:16",
  );
  const [aspectTouched, setAspectTouched] = useState(false);
  useEffect(() => {
    if (aspectTouched) return;
    const rec = templateMeta?.defaults?.aspect as Aspect | undefined;
    if (rec) setAspect(rec);
  }, [templateMeta?.defaults?.aspect, aspectTouched]);
  const [autoSegment, setAutoSegment] = useState(true);
  const [sceneDetection, setSceneDetection] = useState(true);

  const videoStem = useMemo(() => stemFromPath(videoPath), [videoPath]);
  // Default both project name AND first-video title to the file
  // stem on first upload. Either is editable independently after
  // that — typing into either field disables the autofill for that
  // field only. The user can have e.g. project name "Eternally
  // Regressing Knight" and first video "Chapter 1" without one
  // overriding the other.
  useEffect(() => {
    if (!name && videoStem) setName(videoStem);
    if (!firstVideoTitle && videoStem) setFirstVideoTitle(videoStem);
  }, [videoStem, name, firstVideoTitle]);

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
          videoId: firstVideoId,
          videoTitle: firstVideoTitle.trim() || name,
        });
      }}
      className="flex animate-stepFade flex-col gap-3"
    >
      {templateMeta && <TemplateChip meta={templateMeta} />}

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
        <div className="flex flex-col gap-1">
          <TextInput value={name} onChange={setName} placeholder="my-demo" />
          <span className="text-[10px] text-fg-muted">
            The parent project — a collection of videos. You can add more videos
            later via the sidebar (record-with-Claude or upload another file).
          </span>
        </div>
      </FieldRow>

      <FieldRow label="First video name">
        <div className="flex flex-col gap-1">
          <TextInput
            value={firstVideoTitle}
            onChange={setFirstVideoTitle}
            placeholder="Chapter 1 — The Tower Falls"
          />
          <span className="font-mono text-[10px] text-fg-muted">
            video_id:{" "}
            <span className="text-accent">{firstVideoId}</span>
            {firstVideoId !== firstVideoTitle.toLowerCase().replace(/\s+/g, "-") && firstVideoTitle.trim() && (
              <span className="text-fg-muted">
                {" "}
                (sanitized for on-disk paths)
              </span>
            )}
          </span>
        </div>
      </FieldRow>

      <FieldRow label="Aspect">
        <div className="flex flex-col gap-1">
          <AspectPicker
            value={aspect}
            onChange={(v) => {
              setAspect(v);
              setAspectTouched(true);
            }}
          />
          <AspectHint
            templateMeta={templateMeta}
            chosen={aspect}
            touched={aspectTouched}
          />
        </div>
      </FieldRow>

      <VoiceFieldRow
        provider={ttsProvider}
        voice={voiceId}
        onChange={onTtsChange}
      />

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
  templateMeta,
  ttsProvider,
  voiceId,
  onTtsChange,
  onBack,
  onSubmit,
}: {
  templateMeta: TemplateMeta | null;
  ttsProvider: VoiceProvider;
  voiceId: string;
  onTtsChange: (provider: VoiceProvider, voice: string) => void;
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
  // Same template-sync behavior as UploadStep — see comment there.
  const [aspect, setAspect] = useState<Aspect>(
    (templateMeta?.defaults?.aspect as Aspect | undefined) ?? "9:16",
  );
  const [aspectTouched, setAspectTouched] = useState(false);
  useEffect(() => {
    if (aspectTouched) return;
    const rec = templateMeta?.defaults?.aspect as Aspect | undefined;
    if (rec) setAspect(rec);
  }, [templateMeta?.defaults?.aspect, aspectTouched]);
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
      className="flex animate-stepFade flex-col gap-3"
    >
      {templateMeta && <TemplateChip meta={templateMeta} />}

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
        <div className="flex flex-col gap-1">
          <AspectPicker
            value={aspect}
            onChange={(v) => {
              setAspect(v);
              setAspectTouched(true);
            }}
          />
          <AspectHint
            templateMeta={templateMeta}
            chosen={aspect}
            touched={aspectTouched}
          />
        </div>
      </FieldRow>

      <VoiceFieldRow
        provider={ttsProvider}
        voice={voiceId}
        onChange={onTtsChange}
      />

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
    <div className="flex animate-stepFade flex-col items-center gap-3 py-8 text-sm text-fg-muted">
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

/** Hint next to AspectPicker that surfaces the template's recommended
 *  aspect — and warns if the user has chosen something different.
 *  Silent when no template is selected or the picks already match. */
function AspectHint({
  templateMeta,
  chosen,
  touched,
}: {
  templateMeta: TemplateMeta | null;
  chosen: Aspect;
  touched: boolean;
}) {
  const recommended = templateMeta?.defaults?.aspect;
  if (!recommended) return null;
  if (recommended === chosen) {
    // Untouched + matching = "we picked this for you." Touched + matching
    // = "ok, that's also what the template wants." Both read fine as
    // a quiet confirmation.
    return (
      <span className="flex items-center gap-1 font-mono text-[10px] text-fg-muted">
        {touched && <Check size={10} strokeWidth={2.5} />}
        {touched ? "matches template recommendation" : "from template default"}
      </span>
    );
  }
  // User has deliberately picked something different from the template.
  // We honor their choice (apply step uses `overwriteDefaults: false`),
  // but flag the mismatch so it's not silent.
  return (
    <span className="font-mono text-[10px] text-warn">
      overriding template recommendation ({recommended})
    </span>
  );
}

/** Inline reminder banner showing which template will be applied after
 *  the project is created. Sits at the top of the Upload / Record forms
 *  so the user doesn't forget the choice they made on the mode screen. */
function TemplateChip({ meta }: { meta: TemplateMeta }) {
  return (
    <div className="flex items-center justify-between rounded border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs">
      <span className="text-fg">
        <span className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
          template
        </span>{" "}
        <span className="font-medium">{meta.name}</span>
      </span>
      <span className="font-mono text-[10px] text-fg-muted">
        {meta.template_id}
      </span>
    </div>
  );
}

/** Project-default voice picker. Provider + voice dropdowns side-by-side
 *  with the same dependent-dropdown pattern as the per-segment Inspector
 *  and the per-video Settings dialog: changing the provider auto-swaps
 *  the voice to that provider's catalog default (unless the current
 *  voice already exists in the new provider's list — rare but possible).
 *
 *  Writes straight into `project.json#tts_provider` and `voice_id`. The
 *  per-video override path in `videos/<id>.json#recap_overrides` still
 *  wins at TTS time when the user sets it explicitly. */
function VoiceFieldRow({
  provider,
  voice,
  onChange,
}: {
  provider: VoiceProvider;
  voice: string;
  onChange: (provider: VoiceProvider, voice: string) => void;
}) {
  return (
    <FieldRow label="Voice (default)">
      <div className="flex flex-col gap-1">
        <div className="grid grid-cols-2 gap-2">
          <Dropdown<VoiceProvider>
            value={provider}
            onChange={(nextProvider) => {
              // Snap voice to the new provider's catalog default if
              // the current voice isn't in its list. Otherwise keep
              // it (cross-provider voice ids are rare but legal —
              // e.g. user typed one in via the per-segment Inspector).
              const nextVoice = voiceInCatalog(nextProvider, voice)
                ? voice
                : defaultVoiceFor(nextProvider);
              onChange(nextProvider, nextVoice);
            }}
            options={VOICE_PROVIDER_OPTIONS as unknown as Array<{
              value: VoiceProvider;
              label: string;
              hint?: string;
            }>}
            wrapperClassName="block w-full"
            triggerClassName="w-full justify-between bg-bg-inset px-2 py-1.5 text-sm text-fg"
            menuMinWidth={240}
          />
          <div className="flex items-center gap-1.5">
            <Dropdown<string>
              value={voice}
              onChange={(v) => onChange(provider, v)}
              options={VOICES_BY_PROVIDER[provider]}
              wrapperClassName="block min-w-0 flex-1"
              triggerClassName="w-full justify-between bg-bg-inset px-2 py-1.5 text-sm text-fg"
              menuMinWidth={240}
              placeholder="(provider default)"
            />
            <VoicePreview provider={provider} voice={voice} />
          </div>
        </div>
        <span className="text-[10px] text-fg-muted">
          Project-wide default. Each video can override via Settings → "This video".
          Preview synthesizes one line so you can hear a voice before picking it.
        </span>
      </div>
    </FieldRow>
  );
}

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
