// API Keys panel — user-scoped credentials for paid TTS providers.
//
// Lives inside the Project Settings dialog but labeled as APP-WIDE so
// the user knows the keys persist across projects. We never read the
// raw secret values back from disk — the panel shows presence-only
// status ("configured" / "not configured") and uses masked password
// inputs to write new values. Two consequences for the UX:
//
//   - **Editing one key doesn't require re-typing the other.** Each
//     input represents a "next value if I save"; leaving it blank
//     means "don't change". A small `Clear` button next to each
//     field explicitly wipes a stored key.
//
//   - **Env-var overrides are flagged.** When `OPENAI_API_KEY` /
//     `ELEVENLABS_API_KEY` is set in the user's shell environment,
//     it wins over the on-disk value. The badge reads "from env"
//     and the input is disabled — typing in the dialog wouldn't
//     help, you'd need to `unset` the env var first.

import { useEffect, useState } from "react";
import { Check, ExternalLink, KeyRound, Loader2 } from "lucide-react";
import {
  getCredentialsStatus,
  setCredentials,
  type CredentialsStatus,
} from "../lib/tauri";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";

export function ApiKeysSection() {
  const setError = useApp((s) => s.setError);
  const [status, setStatus] = useState<CredentialsStatus | null>(null);
  const [openaiDraft, setOpenaiDraft] = useState("");
  const [elevenDraft, setElevenDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getCredentialsStatus()
      .then(setStatus)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [setError]);

  async function applyChanges(update: {
    openai_api_key?: string | null;
    elevenlabs_api_key?: string | null;
  }) {
    setSaving(true);
    try {
      const next = await setCredentials(update);
      setStatus(next);
      // Only clear drafts whose fields we just wrote — leaves the
      // other input's user-typed-but-not-yet-saved value alone.
      if (update.openai_api_key !== undefined) setOpenaiDraft("");
      if (update.elevenlabs_api_key !== undefined) setElevenDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!status) {
    return (
      <section className="flex items-center gap-2 text-xs text-fg-muted">
        <Loader2 size={14} strokeWidth={2} className="animate-spin" />
        Loading credentials status…
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded border border-border-subtle bg-bg-subtle p-3">
      <header className="flex items-center gap-2">
        <KeyRound size={14} strokeWidth={1.75} className="text-fg-subtle" />
        <h3 className="text-sm font-medium text-fg">API keys</h3>
        <span className="ml-auto rounded bg-bg-raised px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-fg-muted">
          app-wide
        </span>
      </header>
      <p className="text-[11px] text-fg-muted">
        Required to use OpenAI or ElevenLabs as a TTS provider. Stored
        at <span className="font-mono">{status.credentials_path}</span>{" "}
        (chmod 0600 — user-only). Environment variables{" "}
        <span className="font-mono">OPENAI_API_KEY</span> and{" "}
        <span className="font-mono">ELEVENLABS_API_KEY</span> override
        the on-disk values for headless / CI runs.
      </p>

      <KeyRow
        label="OpenAI"
        configured={status.has_openai_key}
        fromEnv={status.openai_key_from_env}
        draft={openaiDraft}
        setDraft={setOpenaiDraft}
        helpUrl="https://platform.openai.com/api-keys"
        saving={saving}
        onSave={() => applyChanges({ openai_api_key: openaiDraft })}
        onClear={() => applyChanges({ openai_api_key: "" })}
      />
      <KeyRow
        label="ElevenLabs"
        configured={status.has_elevenlabs_key}
        fromEnv={status.elevenlabs_key_from_env}
        draft={elevenDraft}
        setDraft={setElevenDraft}
        helpUrl="https://elevenlabs.io/app/settings/api-keys"
        saving={saving}
        onSave={() => applyChanges({ elevenlabs_api_key: elevenDraft })}
        onClear={() => applyChanges({ elevenlabs_api_key: "" })}
      />
    </section>
  );
}

function KeyRow({
  label,
  configured,
  fromEnv,
  draft,
  setDraft,
  helpUrl,
  saving,
  onSave,
  onClear,
}: {
  label: string;
  configured: boolean;
  fromEnv: boolean;
  draft: string;
  setDraft: (v: string) => void;
  helpUrl: string;
  saving: boolean;
  onSave: () => void;
  onClear: () => void;
}) {
  // When the env var wins, the dialog input is read-only and we
  // explain why. Typing into a disabled field wouldn't change
  // anything since the env var beats the file at resolution time.
  const lockedByEnv = fromEnv;
  return (
    <div className="flex flex-col gap-1.5 rounded border border-border-subtle bg-bg-inset p-2.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-fg">{label}</span>
        <a
          href={helpUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="flex items-center gap-0.5 text-[10px] text-fg-muted underline-offset-2 hover:text-fg hover:underline"
          title={`Open ${label} dashboard`}
        >
          get key
          <ExternalLink size={9} strokeWidth={2} />
        </a>
        <span className="ml-auto flex items-center gap-1">
          {configured ? (
            <span
              className={cn(
                "flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
                fromEnv
                  ? "bg-warn/20 text-warn"
                  : "bg-ok/20 text-ok",
              )}
              title={
                fromEnv
                  ? "Resolved from an environment variable, not the file."
                  : "Stored in credentials.json."
              }
            >
              <Check size={10} strokeWidth={2.5} />
              {fromEnv ? "from env" : "configured"}
            </span>
          ) : (
            <span className="rounded bg-bg-raised px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
              not configured
            </span>
          )}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          type="password"
          value={draft}
          disabled={lockedByEnv || saving}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            lockedByEnv
              ? "(env var is set — clear it to use file storage)"
              : configured
                ? "•••••• (type to replace, leave empty to keep)"
                : "paste your API key here"
          }
          className={cn(
            "flex-1 rounded border border-border-subtle bg-bg px-2 py-1 font-mono text-xs text-fg placeholder:text-fg-muted focus:focus-ring",
            (lockedByEnv || saving) && "cursor-not-allowed opacity-60",
          )}
        />
        <button
          type="button"
          onClick={onSave}
          disabled={lockedByEnv || saving || draft.trim() === ""}
          className={cn(
            "rounded bg-accent px-2 py-1 text-[11px] font-medium text-bg transition-colors hover:bg-accent-hover",
            (lockedByEnv || saving || draft.trim() === "") &&
              "cursor-not-allowed bg-bg-raised text-fg-muted",
          )}
        >
          Save
        </button>
        {configured && !fromEnv && (
          <button
            type="button"
            onClick={onClear}
            disabled={saving}
            title="Wipe the stored key from credentials.json"
            className="rounded px-2 py-1 text-[11px] text-fg-muted transition-colors hover:bg-bg-raised hover:text-warn disabled:opacity-50"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
