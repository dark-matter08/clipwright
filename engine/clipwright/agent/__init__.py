"""Claude Code agent integration.

Phase 0 ships only the prompt builder (P0.5). The subprocess-spawning Mode A
(persistent chat) and Mode B (one-shot scoped invocation) from SRS §9.1 land
in Phase 1 alongside the Tauri shell.

The split is intentional: by isolating the prompt construction here we can
iterate on what Claude sees without ever spawning a real `claude` binary,
which keeps the inner loop tight and the tests fast.
"""
from __future__ import annotations

from .prompt import (
    PromptError,
    build_project_prompt,
    build_segment_prompt,
)

__all__ = [
    "PromptError",
    "build_project_prompt",
    "build_segment_prompt",
]
