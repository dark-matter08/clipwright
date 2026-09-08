"""Structured error type for Clipwright — carries fix hint and docs link."""
from __future__ import annotations


class ClipwrightError(Exception):
    def __init__(self, message: str, *, fix: str = "", docs: str = "") -> None:
        super().__init__(message)
        self.fix = fix
        self.docs = docs

    def rich_message(self) -> str:
        parts = [f"[red]Error:[/red] {self}"]
        if self.fix:
            parts.append(f"[yellow]Fix:[/yellow]   {self.fix}")
        if self.docs:
            parts.append(f"[blue]Docs:[/blue]  {self.docs}")
        return "\n".join(parts)
