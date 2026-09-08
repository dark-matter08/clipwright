"""Load + look up project templates.

Templates ship as JSON files in `engine/clipwright/templates/data/*.json`.
Each describes a video genre / format with its own behavioral system
prompt and default settings. Loading is read-from-disk every call so
the desktop sees user-added templates without a restart.

Shape (matches the JSON files):

    {
      "template_id": "manhwa-recap-single",
      "name": "Manhwa Recap — Single Chapter",
      "category": "recap",
      "summary": "One-chapter deep dive with panel-level zooms.",
      "defaults": {
        "aspect": "9:16",
        "fps": 30,
        "tts_provider": "kokoro",
        "voice_id": ""
      },
      "render_preset": "manhwa-recap-single",
      "system_prompt": "...long markdown..."
    }

The `system_prompt` is the heart of a template — it's appended to the
Claude rail's Mode A / Mode B system prompts as a `## Template guidance`
section.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


class TemplateError(Exception):
    """Failure looking up or parsing a template."""


# Templates live in two places, in lookup-priority order:
#   1. **User dir** — `~/.clipwright/templates/data/*.json`. Read-write
#      from the desktop's "save as template" / "new template" flows.
#      User templates with the same `template_id` as a shipped template
#      win, so a user can locally override a shipped one without editing
#      the install.
#   2. **Shipped dir** — `<package>/templates/data/*.json`. Ships with
#      the wheel; read-only at runtime.
_SHIPPED_DIR = Path(__file__).parent / "data"


def user_templates_dir() -> Path:
    """Return `~/.clipwright/templates/data/`.

    Honors `$CLIPWRIGHT_HOME` (when set, points at a custom config root)
    and `$XDG_CONFIG_HOME` for Linux-style installs. Falls back to
    `~/.clipwright/templates/data` everywhere else. Idempotent — does
    NOT create the directory; callers needing to write into it should
    `mkdir(parents=True, exist_ok=True)` first.
    """
    if env := os.environ.get("CLIPWRIGHT_HOME"):
        return Path(env).expanduser() / "templates" / "data"
    if xdg := os.environ.get("XDG_CONFIG_HOME"):
        return Path(xdg).expanduser() / "clipwright" / "templates" / "data"
    return Path.home() / ".clipwright" / "templates" / "data"


# `Template.source` values — see `_load_one`.
SOURCE_SHIPPED = "shipped"
SOURCE_USER = "user"


@dataclass
class TemplateMeta:
    """Catalog-card view of a template — what the picker shows."""

    template_id: str
    name: str
    category: str
    summary: str
    render_preset: str = ""
    # Defaults travel on the meta payload too — the desktop picker needs
    # them to show recommended aspect next to the AspectPicker and the
    # New Project flow uses them to seed form fields. Cheaper than a
    # second `templates show` round-trip per card.
    defaults: dict[str, Any] = field(default_factory=dict)
    # "shipped" (ships with the package) or "user" (lives under
    # `~/.clipwright/templates/`). The desktop picker badges user
    # templates so they're visually distinguishable from the built-in
    # catalog.
    source: str = SOURCE_SHIPPED

    def to_dict(self) -> dict[str, Any]:
        return {
            "template_id": self.template_id,
            "name": self.name,
            "category": self.category,
            "summary": self.summary,
            "render_preset": self.render_preset,
            "defaults": dict(self.defaults),
            "source": self.source,
        }


@dataclass
class Template:
    """Full template payload — what the agent prompt + new-project flow uses."""

    template_id: str
    name: str
    category: str
    summary: str
    system_prompt: str
    render_preset: str = ""
    defaults: dict[str, Any] = field(default_factory=dict)
    source: str = SOURCE_SHIPPED
    # Filesystem path the template was loaded from. Set by the loader,
    # never persisted to disk. Lets the CLI's `templates edit` and
    # `templates path <id>` commands point users at the right file.
    source_path: Path | None = None

    def meta(self) -> TemplateMeta:
        return TemplateMeta(
            template_id=self.template_id,
            name=self.name,
            category=self.category,
            summary=self.summary,
            render_preset=self.render_preset,
            defaults=dict(self.defaults),
            source=self.source,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "template_id": self.template_id,
            "name": self.name,
            "category": self.category,
            "summary": self.summary,
            "render_preset": self.render_preset,
            "defaults": dict(self.defaults),
            "system_prompt": self.system_prompt,
            "source": self.source,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Template:
        try:
            return cls(
                template_id=str(d["template_id"]),
                name=str(d["name"]),
                category=str(d.get("category", "")),
                summary=str(d.get("summary", "")),
                system_prompt=str(d.get("system_prompt", "")),
                render_preset=str(d.get("render_preset", "")),
                defaults=dict(d.get("defaults", {})),
            )
        except KeyError as e:
            raise TemplateError(f"template missing required field: {e!s}") from e


def _iter_paths_in(dirpath: Path) -> list[Path]:
    """Sorted list of `*.json` files in one directory, or [] if missing."""
    if not dirpath.exists():
        return []
    return sorted(p for p in dirpath.iterdir() if p.suffix == ".json")


def _load_one(path: Path, source: str) -> Template | None:
    """Read + parse one template file. Returns None on any failure.

    Failure modes (all swallowed):
      - file unreadable / non-JSON   → None
      - JSON missing required fields → None

    Tagging happens here: every successfully-loaded template gets its
    `source` and `source_path` set so downstream code (CLI badges,
    desktop picker) can render provenance without re-deriving it.
    """
    try:
        payload = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    try:
        t = Template.from_dict(payload)
    except TemplateError:
        return None
    t.source = source
    t.source_path = path
    return t


def _iter_all_templates() -> list[Template]:
    """Merge user + shipped templates, user-wins on `template_id` collision.

    The merge is deliberately user-priority so a developer can locally
    customize a shipped template (e.g. tweak the manhwa-recap-single
    system prompt) by dropping a same-id file in their user dir — no
    fork required. Iteration order is stable: user dir first (sorted),
    then shipped dir (sorted), with id-dedupe favoring whatever loaded
    first.
    """
    seen: set[str] = set()
    out: list[Template] = []
    for path in _iter_paths_in(user_templates_dir()):
        t = _load_one(path, SOURCE_USER)
        if t is None or t.template_id in seen:
            continue
        seen.add(t.template_id)
        out.append(t)
    for path in _iter_paths_in(_SHIPPED_DIR):
        t = _load_one(path, SOURCE_SHIPPED)
        if t is None or t.template_id in seen:
            continue
        seen.add(t.template_id)
        out.append(t)
    # Sort by category, then name — same stable order regardless of
    # which dir contributed which entries.
    out.sort(key=lambda t: (t.category, t.name.lower(), t.template_id))
    return out


def list_templates() -> list[TemplateMeta]:
    """Catalog view — one entry per available template (user + shipped)."""
    return [t.meta() for t in _iter_all_templates()]


def get_template(template_id: str) -> Template:
    """Look up one template by id. User dir wins on collision."""
    for t in _iter_all_templates():
        if t.template_id == template_id:
            return t
    raise TemplateError(f"no template with id {template_id!r}")


def load_template_for_project(project_dir: Path) -> Template | None:
    """Read `project.json` and return its bound template, if any.

    Returns `None` when the project has no `template_id` set or when the
    referenced template no longer exists (gracefully — a missing template
    shouldn't block project load). Caller can re-bind via the desktop UI.
    """
    project_path = Path(project_dir) / "project.json"
    if not project_path.exists():
        return None
    try:
        payload = json.loads(project_path.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    template_id = payload.get("template_id")
    if not template_id or not isinstance(template_id, str):
        return None
    try:
        return get_template(template_id)
    except TemplateError:
        return None
