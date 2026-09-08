"""Browse-plan schema.

A browse-plan is a declarative list of actions the recorder should perform.
Each action type corresponds to a camera-zoom pattern at render time.

Schema:

    {
      "viewport": {"width": 540, "height": 960, "mobile": true},
      "base_url": "https://app.example.com",
      "auth": {"helper": "_auth:silent_signin"},
      "actions": [
        {"type": "navigate", "label": "Open discover", "chapter": "library",
         "fields": {"url": "/discover"}, "wait": 3.0},
        {"type": "type", "label": "Search Blue Lock", "chapter": "library",
         "fields": {"selector": "input[placeholder*='search' i]", "text": "blue lock"},
         "wait": 2.5},
        {"type": "click", "label": "Open the title", "chapter": "library",
         "fields": {"role": "button", "name": "Blue Lock"}, "wait": 3.0},
        {"type": "click", "label": "Add to library", "chapter": "library",
         "fields": {"selector": "button:has-text('ADD TO LIBRARY')"}, "wait": 4.0}
      ]
    }

Each action declares a `chapter` — contiguous same-chapter actions collapse
into ONE segment (one narrated clip). `wait` is seconds to dwell after the
action; default 2.5s. `fields` is action-specific; the executor validates
required keys. `label` drives auto-generated voiceover hint copy.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

ActionType = Literal["navigate", "click", "type", "hover", "scroll", "wait", "key"]

REQUIRED_FIELDS: dict[str, set[str]] = {
    "navigate": {"url"},
    "click": set(),        # one of: selector | role+name | test_id | text
    "type": {"text"},      # plus one selector-form
    "hover": set(),
    "scroll": set(),       # defaults to by_y=600
    "wait": set(),
    "key": {"press"},
}

VALID_TYPES = set(REQUIRED_FIELDS.keys())


@dataclass
class Action:
    type: str
    label: str = ""
    fields: dict[str, Any] = field(default_factory=dict)
    wait: float = 2.5
    chapter: str = ""

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Action:
        t = d.get("type")
        if t not in VALID_TYPES:
            raise ValueError(f"action.type must be one of {sorted(VALID_TYPES)}, got {t!r}")
        a = cls(
            type=t,
            label=str(d.get("label", "")),
            fields=dict(d.get("fields", {})),
            wait=float(d.get("wait", 2.5)),
            chapter=str(d.get("chapter", "")),
        )
        missing = REQUIRED_FIELDS[t] - set(a.fields.keys())
        if missing:
            raise ValueError(f"action {t!r} missing fields: {sorted(missing)}")
        if t in ("click", "type", "hover") and not _has_selector(a.fields):
            raise ValueError(
                f"action {t!r} needs a selector, role+name, test_id, or text in fields"
            )
        return a


def _has_selector(f: dict[str, Any]) -> bool:
    if f.get("selector") or f.get("test_id") or f.get("text"):
        return True
    return bool(f.get("role") and f.get("name"))


@dataclass
class Viewport:
    width: int = 540
    height: int = 960
    mobile: bool = True


@dataclass
class Auth:
    helper: str = ""  # "module_path:func" — resolved relative to plan dir


@dataclass
class BrowsePlan:
    viewport: Viewport
    base_url: str
    actions: list[Action]
    auth: Auth | None = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> BrowsePlan:
        v = d.get("viewport") or {}
        vp = Viewport(
            width=int(v.get("width", 540)),
            height=int(v.get("height", 960)),
            mobile=bool(v.get("mobile", True)),
        )
        auth_d = d.get("auth")
        auth = Auth(helper=str(auth_d.get("helper", ""))) if auth_d else None
        actions = [Action.from_dict(a) for a in d.get("actions") or []]
        if not actions:
            raise ValueError("browse-plan must include at least one action")
        return cls(
            viewport=vp,
            base_url=str(d.get("base_url", "")),
            actions=actions,
            auth=auth,
        )


def load_plan(path: Path) -> BrowsePlan:
    return BrowsePlan.from_dict(json.loads(path.read_text()))
