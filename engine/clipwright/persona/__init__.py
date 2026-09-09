"""Reusable writing personas: definition, library, and memory.

A persona is "who Claude is when it writes" — identity, voice, structural
rules, vocabulary, pacing, the failure mode to avoid — plus the voice it
speaks in and the memory it accumulates.

Personas are user-level and referenced by id, so one persona serves many
projects and editing it takes effect everywhere immediately (live
reference, not a snapshot). Cloning copies the definition under a new id
so you can diverge from a persona without disturbing the original.
"""
from __future__ import annotations

from .library import (
    Persona,
    PersonaDraft,
    PersonaError,
    VoiceConfig,
    clone_persona,
    compose_prose,
    delete_persona,
    list_personas,
    load_persona,
    new_persona_id,
    save_persona,
)
from .memory import (
    MemoryEntry,
    MemoryError,
    add_memory,
    delete_memory,
    graph_data,
    list_memory,
    memory_overview,
    search_memory,
)

__all__ = [
    "Persona",
    "PersonaDraft",
    "PersonaError",
    "VoiceConfig",
    "clone_persona",
    "compose_prose",
    "delete_persona",
    "list_personas",
    "load_persona",
    "new_persona_id",
    "save_persona",
    "MemoryEntry",
    "MemoryError",
    "add_memory",
    "delete_memory",
    "graph_data",
    "list_memory",
    "memory_overview",
    "search_memory",
]
