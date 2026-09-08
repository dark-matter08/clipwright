"""Ensure tests always import from this worktree's engine/, not the editable install."""
from __future__ import annotations

import sys
from pathlib import Path

# Insert the worktree's own engine/ at the front of sys.path so that `import
# clipwright` resolves here rather than via the editable install, which points
# at whichever checkout was installed last.
_engine = str(Path(__file__).parent / "engine")
if _engine not in sys.path:
    sys.path.insert(0, _engine)
