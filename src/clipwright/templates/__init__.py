"""Project templates — behavioral + visual presets for one kind of video.

A template bundles together:

- a **system_prompt** appended to every Claude turn for the project, so
  the agent knows the genre (manhwa recap, product demo, …), the typical
  segment structure, and the editorial rules of the format;
- **default project settings** (aspect, fps, tts_provider, voice_id)
  pre-filled into the New Project dialog when the template is chosen;
- a **render_preset** name (P2 — pointer for a future Remotion preset)
  so the rendered look matches the template's identity.

Templates are JSON files under `src/clipwright/templates/data/*.json`
shipped with the package. Loading is purely-from-disk so users can drop
a new template into the directory and it shows up next launch.
"""
from __future__ import annotations

from .registry import (
    SOURCE_SHIPPED,
    SOURCE_USER,
    Template,
    TemplateError,
    TemplateMeta,
    get_template,
    list_templates,
    load_template_for_project,
    user_templates_dir,
)

__all__ = [
    "SOURCE_SHIPPED",
    "SOURCE_USER",
    "Template",
    "TemplateError",
    "TemplateMeta",
    "get_template",
    "list_templates",
    "load_template_for_project",
    "user_templates_dir",
]
