"""Ensure tests always import from this worktree's src/, not the editable install."""
from __future__ import annotations

import sys
from pathlib import Path

# Insert the worktree's own src/ at the front of sys.path so that `import
# clipwright` resolves here rather than via the editable install which points
# at the main project's src/.
_src = str(Path(__file__).parent / "src")
if _src not in sys.path:
    sys.path.insert(0, _src)
