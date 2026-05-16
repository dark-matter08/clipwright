"""Migration scaffolding.

For v1 there is nothing to migrate. This module defines the pattern future
versions will follow:

    payload = json.loads(path.read_text())
    payload = upgrade(payload, target=SCHEMA_VERSION)
    model = Model.from_dict(payload)

Each future version registers a step `upgrade_N_to_N1(payload) -> payload`
keyed by source version. `upgrade()` composes them in order.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

# version N -> N+1 upgraders, keyed by source version
_STEPS: dict[int, Callable[[dict[str, Any]], dict[str, Any]]] = {}


def register(from_version: int, fn: Callable[[dict[str, Any]], dict[str, Any]]) -> None:
    """Register an upgrade step from `from_version` to `from_version + 1`."""
    if from_version in _STEPS:
        raise RuntimeError(f"upgrade step from v{from_version} already registered")
    _STEPS[from_version] = fn


def upgrade(payload: dict[str, Any], *, target: int) -> dict[str, Any]:
    """Compose upgrade steps until `payload["schema_version"] == target`.

    Raises ValueError if the payload version is newer than `target` (forward
    compat is not supported — newer files require a newer clipwright).
    """
    current = int(payload.get("schema_version", 1))
    if current == target:
        return payload
    if current > target:
        raise ValueError(
            f"file schema_version={current} is newer than supported version {target}"
        )
    while current < target:
        step = _STEPS.get(current)
        if step is None:
            raise ValueError(
                f"no upgrade path from schema_version={current} to {target}"
            )
        payload = step(payload)
        current = int(payload.get("schema_version", current + 1))
    return payload
