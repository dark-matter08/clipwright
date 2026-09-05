"""Per-project recap preferences.

Lives at `<project>/.clipwright/recap-config.json`. Carries the knobs
the user can dial in once and have apply across every video they
generate from that project — most importantly the target duration
(so Claude doesn't compress a 3-min story into a 60s ceiling) and an
outro spec (so every video in the project ends the same way).

Why a separate file (not part of project.json):
  - Lets the v2 schema stay minimal and stable.
  - Mirrors the pattern of `.clipwright/claude-permissions.json`,
    `claude-model.json`, `claude-timeout.json` — runtime knobs are
    project-scoped sidecars; manifest stays the source of truth for
    the deliverable.
  - Easy for the user to nuke and start over without touching the
    project manifest.

The agent prompt reads this on every turn and injects a "Project
preferences" section, so changes take effect immediately without a
restart.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

CONFIG_REL_PATH = Path(".clipwright") / "recap-config.json"

# Sensible defaults — every recap project starts with 1:30 target
# duration and a 3-second outro. The user wanted a fixed default for
# both rather than the "0 = unset" sentinel we had before, so even an
# untouched project gives Claude an explicit target and the prompt
# injection ALWAYS runs.
DEFAULT_TARGET_DURATION = 90       # 1 min 30 sec
DEFAULT_OUTRO_DURATION = 3.0       # seconds
# When the user hasn't customized the outro description, we synthesize
# one referencing the project title in a cyberpunk visual idiom — see
# `effective_outro_description()` below.


@dataclass
class OutroSpec:
    """How the user wants every video in the project to end.

    `description` is plain natural-language — the agent reads it and
    composes a matching final segment. `duration_seconds` is the
    target outro length so the agent doesn't blow past it.

    An empty `description` is replaced at prompt-injection time with a
    cyberpunk-themed fallback that surfaces the project title — see
    `effective_outro_description()`.
    """

    description: str = ""
    duration_seconds: float = DEFAULT_OUTRO_DURATION


@dataclass
class PersonaDraft:
    """The desktop persona builder's field values.

    Pure UI state: `RecapConfig.persona` is the prose the agent prompt
    quotes, and these are the six blocks the builder composed it from
    (identity, tone, structural rules, vocabulary, pacing, and the
    forbidden failure mode). We persist them so reopening the persona
    panel resumes the build instead of stranding the user in free-text
    mode with prose they can no longer edit block-by-block. Nothing on
    the Python side reads these — they never reach the prompt.
    """

    role: str = ""
    voice: str = ""
    moves: str = ""
    vocabulary: str = ""
    pacing: str = ""
    avoid: str = ""


@dataclass
class RecapConfig:
    """User-tunable knobs that flow into the agent prompt.

    Defaults are deliberately non-zero/non-empty for the duration
    fields: every project should get a target duration and an outro
    duration even before the user opens settings. The agent prompt
    injection runs whenever any field deviates from a *pristine empty*
    state — which is always, given these defaults.
    """

    target_duration_seconds: int = DEFAULT_TARGET_DURATION
    narration_style: str = ""
    additional_notes: str = ""
    # Who Claude should BE when writing for this project — e.g. "an
    # expert manhwa scriptwriter who specializes in high-retention
    # hooks and dramatic pacing". Distinct from `narration_style`,
    # which describes the *voice actor* (timbre, delivery); the
    # persona describes the *writer* (expertise, editorial instincts).
    # Empty = no persona section in the prompt, so existing projects
    # keep behaving exactly as before.
    persona: str = ""
    # Builder state behind `persona` — see PersonaDraft. UI-only.
    persona_draft: PersonaDraft = field(default_factory=PersonaDraft)
    outro: OutroSpec = field(default_factory=OutroSpec)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> RecapConfig:
        """Tolerant parse — unknown fields ignored, missing fields
        defaulted. Outro is upgraded from string-only legacy shape if
        we ever see it (defensive — we ship the structured shape from
        day one, but future-proof the loader)."""
        outro_raw = d.get("outro") or {}
        if isinstance(outro_raw, str):
            outro = OutroSpec(description=outro_raw)
        elif isinstance(outro_raw, dict):
            outro = OutroSpec(
                description=str(outro_raw.get("description", "")),
                duration_seconds=float(outro_raw.get("duration_seconds", 5.0)),
            )
        else:
            outro = OutroSpec()
        return cls(
            target_duration_seconds=int(d.get("target_duration_seconds", 0)),
            narration_style=str(d.get("narration_style", "")),
            additional_notes=str(d.get("additional_notes", "")),
            persona=str(d.get("persona", "")),
            persona_draft=_parse_persona_draft(d.get("persona_draft")),
            outro=outro,
        )

    def has_overrides(self) -> bool:
        """True when at least one field carries actionable content.

        With the new defaults (target=90s, outro=3s), this is
        effectively always True for a constructed `RecapConfig` —
        the prompt section is always emitted, which is what the
        user wanted ("video duration should always default to 1:30").
        Kept as a method so future fields can opt out of injection
        when truly unset.

        `persona` is deliberately NOT counted here: it renders as its
        own `## Persona` section with its own emptiness gate, so a
        persona-only config must not resurrect an otherwise-empty
        "Project preferences" block.
        """
        return (
            self.target_duration_seconds > 0
            or bool(self.narration_style.strip())
            or bool(self.additional_notes.strip())
            or bool(self.outro.description.strip())
            or self.outro.duration_seconds > 0
        )

    def effective_outro_description(self, project_title: str) -> str:
        """Resolve the outro description for prompt injection.

        When the user has typed nothing, fall back to a cyberpunk-
        themed description featuring the project title — that's the
        product's house style. The user can override anytime via the
        Project Settings dialog; an explicit description short-circuits
        this fallback.
        """
        if self.outro.description.strip():
            return self.outro.description.strip()
        title = project_title.strip() or "Clipwright"
        return (
            f"Cyberpunk-themed outro card. Project title \"{title}\" appears "
            "center-screen in a neon-accented sans-serif over a deep blue/violet "
            "background with subtle scanline/glitch. Voiceover (short, 1 line): "
            "tease the next chapter and prompt a follow."
        )


def _parse_persona_draft(raw: object) -> PersonaDraft:
    """Tolerant parse — anything that isn't a dict of strings yields an
    empty draft. This is UI state written by the desktop; a malformed
    value must never break loading the rest of the config."""
    if not isinstance(raw, dict):
        return PersonaDraft()
    return PersonaDraft(
        role=str(raw.get("role", "") or ""),
        voice=str(raw.get("voice", "") or ""),
        moves=str(raw.get("moves", "") or ""),
        vocabulary=str(raw.get("vocabulary", "") or ""),
        pacing=str(raw.get("pacing", "") or ""),
        avoid=str(raw.get("avoid", "") or ""),
    )


def config_path(project_dir: Path) -> Path:
    return Path(project_dir) / CONFIG_REL_PATH


def load_recap_config(project_dir: Path) -> RecapConfig:
    """Read the per-project recap config. Returns defaults when
    missing or malformed — never raises (this is a soft preferences
    file, not a manifest)."""
    path = config_path(Path(project_dir))
    if not path.exists():
        return RecapConfig()
    try:
        return RecapConfig.from_dict(json.loads(path.read_text()))
    except (json.JSONDecodeError, OSError, TypeError, ValueError):
        return RecapConfig()


def save_recap_config(project_dir: Path, cfg: RecapConfig) -> Path:
    """Atomic write — temp file + rename so a half-write doesn't
    leave the file corrupted on disk."""
    path = config_path(Path(project_dir))
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cfg.to_dict(), indent=2) + "\n")
    tmp.replace(path)
    return path
