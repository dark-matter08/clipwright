"""Persona definitions and the library that stores them.

One JSON document per persona under `<clipwright home>/personas/`. The
id is the filename stem and the stable handle everything else uses:
projects store `persona_id`, memory rows key off it, and clones get a
fresh one.

Live reference, by design: a project records the id and nothing else, so
editing a persona takes effect in every project that uses it on the next
turn. That's the point — you tune a voice once and everything inherits
it. The cost is that changing a persona changes work you may consider
finished, which is why `clone_persona` exists: diverge under a new id
rather than mutating the shared one.
"""
from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .paths import persona_path, personas_dir

PERSONA_ID_RE = re.compile(r"^[a-z][a-z0-9_-]*$")


class PersonaError(Exception):
    """Failure loading, saving or resolving a persona, with a fix hint."""

    def __init__(self, message: str, fix: str = "") -> None:
        super().__init__(message)
        self.fix = fix


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Voice
# ---------------------------------------------------------------------------


@dataclass
class VoiceConfig:
    """How a persona sounds.

    Voice belongs to the persona rather than the project: a persona *is*
    a narrator, and the same narrator shouldn't sound different because
    it's working on a different project.

    Fields split into three groups by how far they reach:

      * `provider` / `voice_id` — every backend.
      * `speed` — every backend supports it natively.
      * `pitch_semitones` — NO backend supports it. Applied after
        synthesis by resampling in ffmpeg (see `tts_segment`). Kept here
        anyway because it's the control users reach for first, and doing
        it ourselves is the only way to offer it at all.
      * The rest are provider-specific and ignored elsewhere:
        `instructions` steers delivery on OpenAI's `gpt-4o-mini-tts`;
        `stability` / `similarity_boost` / `style` are ElevenLabs knobs.
    """

    provider: str = "kokoro"
    voice_id: str = ""
    # 1.0 = the provider's natural rate. Clamped on apply, not here, so
    # a hand-edited file with 3.0 loads rather than refusing to open.
    speed: float = 1.0
    # Semitones, applied post-synthesis. ±2 is the honest usable range;
    # past that resampling artifacts become audible.
    pitch_semitones: float = 0.0
    # OpenAI only — free-text delivery steering ("gravelly, unhurried,
    # drop to a near-whisper on the last line"). The single strongest
    # tone lever any provider exposes.
    instructions: str = ""
    # ElevenLabs only.
    stability: float = 0.45
    similarity_boost: float = 0.75
    style: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict | None) -> VoiceConfig:
        d = d or {}

        def _f(key: str, default: float) -> float:
            try:
                return float(d.get(key, default))
            except (TypeError, ValueError):
                return default

        return cls(
            provider=str(d.get("provider", "kokoro") or "kokoro"),
            voice_id=str(d.get("voice_id", "") or ""),
            speed=_f("speed", 1.0),
            pitch_semitones=_f("pitch_semitones", 0.0),
            instructions=str(d.get("instructions", "") or ""),
            stability=_f("stability", 0.45),
            similarity_boost=_f("similarity_boost", 0.75),
            style=_f("style", 0.0),
        )


# ---------------------------------------------------------------------------
# Definition
# ---------------------------------------------------------------------------


@dataclass
class PersonaDraft:
    """The six blocks the builder composes prose from.

    Mirrors the desktop's guided fields. Kept structured rather than
    prose-only so the builder can round-trip and so a clone can be
    tweaked block-by-block instead of by re-reading a paragraph.
    """

    role: str = ""
    voice: str = ""
    moves: str = ""
    vocabulary: str = ""
    pacing: str = ""
    avoid: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict | None) -> PersonaDraft:
        d = d or {}
        return cls(**{f: str(d.get(f, "") or "") for f in
                      ("role", "voice", "moves", "vocabulary", "pacing", "avoid")})


def compose_prose(draft: PersonaDraft) -> str:
    """Compose the six blocks into the text the agent prompt quotes.

    Mirrors `composePersona` in the desktop's PersonaBuilder — labelled
    bullets rather than markdown headers, because the prompt nests this
    under `## Persona` and blockquotes it line by line, and a `> ## Role`
    would read as a sibling section instead of part of the quote.
    """
    role = draft.role.strip()
    blocks = [
        ("Voice & tone", draft.voice.strip()),
        ("Structural rules", draft.moves.strip()),
        ("Vocabulary", draft.vocabulary.strip()),
        ("Pacing", draft.pacing.strip()),
        ("Never", draft.avoid.strip()),
    ]
    body = [
        f"- {label}: {v if v.endswith(('.', '!', '?')) else v + '.'}"
        for label, v in blocks
        if v
    ]
    if not role and not body:
        return ""
    lines: list[str] = []
    if role:
        lines.append(role if role.endswith((".", "!", "?")) else role + ".")
    if body:
        if lines:
            lines.append("")
        lines.extend(body)
    return "\n".join(lines)


@dataclass
class Persona:
    persona_id: str
    name: str = ""
    draft: PersonaDraft = field(default_factory=PersonaDraft)
    # The composed prose. Stored rather than derived so a hand-written
    # persona (one that never went through the builder) is representable
    # — `draft` is empty and `prose` carries everything.
    prose: str = ""
    voice: VoiceConfig = field(default_factory=VoiceConfig)
    created_at: str = ""
    updated_at: str = ""
    # Provenance for clones. Not a live link — the clone is independent
    # the moment it's made — but it answers "where did this come from?"
    # months later, and the graph view draws the lineage from it.
    cloned_from: str = ""

    def effective_prose(self) -> str:
        """What the prompt should quote.

        Prefers stored prose; falls back to composing the draft, so a
        persona edited via the CLI (draft only) still works.
        """
        if self.prose.strip():
            return self.prose.strip()
        return compose_prose(self.draft)

    def to_dict(self) -> dict:
        return {
            "persona_id": self.persona_id,
            "name": self.name,
            "draft": self.draft.to_dict(),
            "prose": self.prose,
            "voice": self.voice.to_dict(),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "cloned_from": self.cloned_from,
        }

    @classmethod
    def from_dict(cls, d: dict) -> Persona:
        pid = str(d.get("persona_id", "") or "")
        return cls(
            persona_id=pid,
            name=str(d.get("name", "") or pid),
            draft=PersonaDraft.from_dict(d.get("draft")),
            prose=str(d.get("prose", "") or ""),
            voice=VoiceConfig.from_dict(d.get("voice")),
            created_at=str(d.get("created_at", "") or ""),
            updated_at=str(d.get("updated_at", "") or ""),
            cloned_from=str(d.get("cloned_from", "") or ""),
        )


# ---------------------------------------------------------------------------
# Library
# ---------------------------------------------------------------------------


def slugify(name: str) -> str:
    """Human name -> persona id. Must satisfy PERSONA_ID_RE."""
    norm = unicodedata.normalize("NFKD", name)
    ascii_only = norm.encode("ascii", "ignore").decode("ascii").lower()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_only).strip("-")
    slug = re.sub(r"-{2,}", "-", slug)
    if not slug or not slug[0].isalpha():
        slug = f"persona-{slug}" if slug else "persona"
    return slug


def new_persona_id(name: str) -> str:
    """A slug for `name` that isn't taken yet — `x`, `x-2`, `x-3`…"""
    base = slugify(name)
    if not persona_path(base).exists():
        return base
    n = 2
    while persona_path(f"{base}-{n}").exists():
        n += 1
    return f"{base}-{n}"


def list_personas() -> list[Persona]:
    """Every persona in the library, newest-updated first.

    Malformed files are skipped rather than raising: one bad hand-edit
    shouldn't make the whole picker unopenable.
    """
    d = personas_dir()
    if not d.exists():
        return []
    out: list[Persona] = []
    for path in sorted(d.glob("*.json")):
        try:
            payload = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        payload.setdefault("persona_id", path.stem)
        out.append(Persona.from_dict(payload))
    out.sort(key=lambda p: (p.updated_at or p.created_at or ""), reverse=True)
    return out


def load_persona(persona_id: str) -> Persona:
    path = persona_path(persona_id)
    if not path.exists():
        raise PersonaError(
            f"persona {persona_id!r} not found",
            fix="Run `clipwright persona list` to see the library.",
        )
    try:
        payload = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as e:
        raise PersonaError(
            f"persona {persona_id!r} is unreadable: {e}",
            fix=f"Fix or delete {path}.",
        ) from e
    payload.setdefault("persona_id", persona_id)
    return Persona.from_dict(payload)


def save_persona(p: Persona) -> Path:
    if not PERSONA_ID_RE.match(p.persona_id):
        raise PersonaError(
            f"invalid persona id {p.persona_id!r}",
            fix="Ids must match [a-z][a-z0-9_-]* — lowercase, no spaces.",
        )
    now = _now()
    if not p.created_at:
        p.created_at = now
    p.updated_at = now
    if not p.name:
        p.name = p.persona_id

    path = persona_path(p.persona_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(p.to_dict(), indent=2) + "\n")
    tmp.replace(path)
    return path


def clone_persona(persona_id: str, new_name: str = "") -> Persona:
    """Copy a persona under a fresh id.

    The whole point of the library being live-reference is that edits
    propagate; the whole point of clone is to escape that when you want
    a variant. The copy carries the definition and voice but NOT the
    memory — a clone hasn't done the work the original did, and
    inheriting its lessons would be a lie about provenance. `cloned_from`
    records the lineage so the graph can draw it.
    """
    src = load_persona(persona_id)
    name = new_name.strip() or f"{src.name} (copy)"
    clone = Persona(
        persona_id=new_persona_id(name),
        name=name,
        draft=PersonaDraft.from_dict(src.draft.to_dict()),
        prose=src.prose,
        voice=VoiceConfig.from_dict(src.voice.to_dict()),
        cloned_from=src.persona_id,
    )
    save_persona(clone)
    return clone


def delete_persona(persona_id: str) -> None:
    path = persona_path(persona_id)
    if not path.exists():
        raise PersonaError(
            f"persona {persona_id!r} not found",
            fix="Run `clipwright persona list` to see the library.",
        )
    path.unlink()
