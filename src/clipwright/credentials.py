"""User-scoped API credentials for paid TTS providers.

ElevenLabs and OpenAI both require API keys, and unlike per-project
recap settings these keys are USER-level: the same key drives every
project you open on this machine. So they live under
`~/.clipwright/credentials.json` (or `$CLIPWRIGHT_HOME/credentials.json`
when set, matching the user-templates dir convention).

Resolution order when a provider asks for a key:

    1. Environment variable — `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`.
       Set in your shell / CI env, this overrides the on-disk file.
       Useful for dev / scripted runs without touching the GUI's
       persisted state.
    2. `~/.clipwright/credentials.json` — written by the desktop's
       Project Settings → API Keys panel.
    3. None — caller must surface a clear "missing key" error.

We deliberately do NOT use the system keyring (macOS Keychain etc.)
for now: extra dependency, cross-platform packaging cost, and limited
upside given the file is mode-0600 user-only. Could add a keyring
backend later behind a feature flag.

We NEVER round-trip the keys back through stdout / logs — the loader
exposes them only via `get_*_api_key()` calls that return the literal
secret to the caller. The desktop's get-credentials Tauri command
masks values in transit (returns presence-only) so a stray React
console.log can't leak them to dev tools.
"""
from __future__ import annotations

import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path

CONFIG_REL_PATH = Path("credentials.json")


def _base_dir() -> Path:
    """Resolve where credentials.json lives. Matches the user-
    templates dir's resolution order so a single
    `$CLIPWRIGHT_HOME` override moves everything together."""
    env = os.environ.get("CLIPWRIGHT_HOME")
    if env:
        return Path(env).expanduser()
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        return Path(xdg).expanduser() / "clipwright"
    return Path.home() / ".clipwright"


def credentials_path() -> Path:
    return _base_dir() / CONFIG_REL_PATH


@dataclass
class Credentials:
    """Plain bag of secrets. Empty string ⇒ "not set"."""

    openai_api_key: str = ""
    elevenlabs_api_key: str = ""

    def to_dict(self) -> dict:
        return {
            "openai_api_key": self.openai_api_key,
            "elevenlabs_api_key": self.elevenlabs_api_key,
        }

    @classmethod
    def from_dict(cls, d: dict) -> Credentials:
        return cls(
            openai_api_key=str(d.get("openai_api_key", "") or ""),
            elevenlabs_api_key=str(d.get("elevenlabs_api_key", "") or ""),
        )


def load_credentials() -> Credentials:
    """Read the on-disk credentials file. Returns an empty
    `Credentials` instance when the file is missing or malformed —
    never raises, because a "no keys yet" project should still open
    cleanly. Environment-variable overrides are applied on top via
    `get_*_api_key()` accessors below."""
    path = credentials_path()
    if not path.exists():
        return Credentials()
    try:
        return Credentials.from_dict(json.loads(path.read_text()))
    except (json.JSONDecodeError, OSError, TypeError, ValueError):
        return Credentials()


def save_credentials(creds: Credentials) -> Path:
    """Write to disk atomically (temp + rename) and chmod 0600 so
    other users on a shared machine can't read the file. Returns the
    written path so the caller can surface it for "stored at ..."
    feedback."""
    path = credentials_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(creds.to_dict(), indent=2) + "\n")
    # Best-effort chmod — Windows ignores POSIX bits; on Unix this
    # makes the file user-only. We set this BEFORE the rename so
    # there's never a window where the final path is world-readable.
    try:
        os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass
    tmp.replace(path)
    return path


def get_openai_api_key() -> str:
    """Resolve the OpenAI key — env wins, file fallback."""
    env = os.environ.get("OPENAI_API_KEY")
    if env:
        return env
    return load_credentials().openai_api_key


def get_elevenlabs_api_key() -> str:
    """Resolve the ElevenLabs key — env wins, file fallback."""
    env = os.environ.get("ELEVENLABS_API_KEY")
    if env:
        return env
    return load_credentials().elevenlabs_api_key


def is_provider_configured(provider: str) -> bool:
    """True when the given TTS provider has the credentials it needs
    to run. Kokoro and Piper are local — always considered configured.
    OpenAI and ElevenLabs need a non-empty key."""
    p = provider.lower()
    if p in ("kokoro", "piper"):
        return True
    if p == "openai":
        return bool(get_openai_api_key())
    if p == "elevenlabs":
        return bool(get_elevenlabs_api_key())
    # Unknown provider — treat as misconfigured so the user gets a
    # clear surface; better than silently succeeding then failing
    # mid-render.
    return False
