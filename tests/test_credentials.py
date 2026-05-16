"""Tests for the user-scoped API credentials module.

Verifies the env-over-file resolution, atomic write, chmod 0600,
and the `is_provider_configured` accessor used by other modules.
"""
from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from clipwright.credentials import (
    Credentials,
    credentials_path,
    get_elevenlabs_api_key,
    get_openai_api_key,
    is_provider_configured,
    load_credentials,
    save_credentials,
)


@pytest.fixture
def isolated_home(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Path:
    """Redirect `~/.clipwright/credentials.json` to a tmp_path so
    tests don't touch real user state. Also clears the env vars
    we resolve against — individual tests opt back into env mode."""
    monkeypatch.setenv("CLIPWRIGHT_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    return tmp_path


def test_load_returns_empty_when_file_missing(isolated_home: Path) -> None:
    creds = load_credentials()
    assert creds.openai_api_key == ""
    assert creds.elevenlabs_api_key == ""


def test_save_and_load_roundtrip(isolated_home: Path) -> None:
    save_credentials(Credentials(openai_api_key="sk-test", elevenlabs_api_key="el-x"))
    loaded = load_credentials()
    assert loaded.openai_api_key == "sk-test"
    assert loaded.elevenlabs_api_key == "el-x"


def test_save_chmod_0600_on_unix(isolated_home: Path) -> None:
    """File should be user-only readable so other accounts on a
    shared machine can't scrape API keys."""
    if os.name != "posix":
        pytest.skip("POSIX permissions only meaningful on Unix")
    save_credentials(Credentials(openai_api_key="sk-x"))
    path = credentials_path()
    mode = path.stat().st_mode
    # 0o600 = -rw-------. We mask off the file-type bits when asserting.
    assert stat.S_IMODE(mode) == 0o600


def test_load_tolerates_malformed_json(
    isolated_home: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A corrupted credentials.json shouldn't crash the loader —
    it returns defaults so the settings dialog opens cleanly."""
    path = credentials_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ not valid json")
    creds = load_credentials()
    assert creds.openai_api_key == ""


def test_env_override_wins(
    isolated_home: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    save_credentials(Credentials(openai_api_key="sk-from-file"))
    monkeypatch.setenv("OPENAI_API_KEY", "sk-from-env")
    assert get_openai_api_key() == "sk-from-env"


def test_env_blank_falls_through_to_file(
    isolated_home: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An exported-but-empty env var (`export OPENAI_API_KEY=`)
    shouldn't shadow the file value. This matches shell convention:
    empty env is how some shells signal "I don't have one" without
    a full `unset`. We treat it as "no env override, fall through"."""
    save_credentials(Credentials(openai_api_key="sk-from-file"))
    monkeypatch.setenv("OPENAI_API_KEY", "")
    assert get_openai_api_key() == "sk-from-file"


def test_get_elevenlabs_key_resolves_from_file(isolated_home: Path) -> None:
    save_credentials(Credentials(elevenlabs_api_key="el-test"))
    assert get_elevenlabs_api_key() == "el-test"


def test_is_provider_configured(isolated_home: Path) -> None:
    # Local providers — always configured.
    assert is_provider_configured("kokoro") is True
    assert is_provider_configured("piper") is True
    # Paid providers — false until keys are set.
    assert is_provider_configured("openai") is False
    assert is_provider_configured("elevenlabs") is False
    save_credentials(Credentials(openai_api_key="sk-x", elevenlabs_api_key="el-x"))
    assert is_provider_configured("openai") is True
    assert is_provider_configured("elevenlabs") is True
    # Unknown — false so the user gets a clear surface.
    assert is_provider_configured("vibevoice") is False


def test_provider_name_case_insensitive(isolated_home: Path) -> None:
    """Case shouldn't matter — `OPENAI` from a config file
    written by hand should still resolve."""
    save_credentials(Credentials(openai_api_key="sk-x"))
    assert is_provider_configured("OpenAI") is True
    assert is_provider_configured("OPENAI") is True
