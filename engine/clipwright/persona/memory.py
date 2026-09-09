"""Persona memory — what a persona has learned, and what it worked on.

SQLite because this is a log that gets queried, ranked and joined, not a
document. FTS5 gives full-text search with no embedding model and no
extra dependency, which matters: the retrieval contract here is "the
agent is told to go and look", so search has to be cheap and available
on a bare install rather than gated behind a 40 MB model download.

Four kinds of entry, matching the four ways a persona learns:

  ``note``      You wrote a rule down. Highest trust — it's a direct
                instruction, not an inference.
  ``edit``      You rewrote a line the persona produced. The highest
                *signal* available: a correction on its own work.
  ``reference`` Style extracted from a transcript you fed it.
  ``video``     A video it produced. This is the "what they've worked
                on shapes their identity" record — provenance more than
                instruction, and weighted accordingly.

`weight` is what separates them at read time. A note you typed outranks
an observation inferred from a finished render, and the overview surfaces
them in that order.
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .paths import memory_db_path

KINDS = ("note", "edit", "reference", "video")

# Default trust per kind. Explicit instruction > correction on real work
# > extracted style > provenance.
DEFAULT_WEIGHT = {
    "note": 1.0,
    "edit": 0.9,
    "reference": 0.6,
    "video": 0.3,
}


class MemoryError(Exception):
    """Failure reading or writing persona memory, with a fix hint."""

    def __init__(self, message: str, fix: str = "") -> None:
        super().__init__(message)
        self.fix = fix


@dataclass
class MemoryEntry:
    id: int
    persona_id: str
    kind: str
    title: str
    body: str
    source: str
    weight: float
    created_at: str

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "persona_id": self.persona_id,
            "kind": self.kind,
            "title": self.title,
            "body": self.body,
            "source": self.source,
            "weight": self.weight,
            "created_at": self.created_at,
        }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _connect(path: Path | None = None) -> sqlite3.Connection:
    p = path or memory_db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p)
    conn.row_factory = sqlite3.Row
    _migrate(conn)
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    """Create the schema if absent. Idempotent — called on every open."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS memory (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            persona_id  TEXT NOT NULL,
            kind        TEXT NOT NULL,
            title       TEXT NOT NULL DEFAULT '',
            body        TEXT NOT NULL DEFAULT '',
            source      TEXT NOT NULL DEFAULT '',
            weight      REAL NOT NULL DEFAULT 0.5,
            created_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_persona
            ON memory(persona_id, created_at DESC);

        -- Contentless FTS mirror. `content=memory` keeps the text in one
        -- place; the triggers below keep the index in step, which SQLite
        -- does NOT do for you on a contentless table.
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
            title, body, content='memory', content_rowid='id'
        );
        CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
            INSERT INTO memory_fts(rowid, title, body)
            VALUES (new.id, new.title, new.body);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, title, body)
            VALUES ('delete', old.id, old.title, old.body);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, title, body)
            VALUES ('delete', old.id, old.title, old.body);
            INSERT INTO memory_fts(rowid, title, body)
            VALUES (new.id, new.title, new.body);
        END;
        """
    )
    conn.commit()


def _row(r: sqlite3.Row) -> MemoryEntry:
    return MemoryEntry(
        id=int(r["id"]),
        persona_id=r["persona_id"],
        kind=r["kind"],
        title=r["title"],
        body=r["body"],
        source=r["source"],
        weight=float(r["weight"]),
        created_at=r["created_at"],
    )


def add_memory(
    persona_id: str,
    kind: str,
    body: str,
    *,
    title: str = "",
    source: str = "",
    weight: float | None = None,
    db_path: Path | None = None,
) -> MemoryEntry:
    if kind not in KINDS:
        raise MemoryError(
            f"unknown memory kind {kind!r}",
            fix=f"Use one of: {', '.join(KINDS)}.",
        )
    if not body.strip():
        raise MemoryError(
            "memory body is empty",
            fix="Write what the persona should remember.",
        )
    w = DEFAULT_WEIGHT[kind] if weight is None else float(weight)
    created = _now()
    with _connect(db_path) as conn:
        cur = conn.execute(
            "INSERT INTO memory(persona_id, kind, title, body, source, weight, created_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (persona_id, kind, title.strip(), body.strip(), source, w, created),
        )
        conn.commit()
        rid = int(cur.lastrowid or 0)
    return MemoryEntry(rid, persona_id, kind, title.strip(), body.strip(), source, w, created)


def list_memory(
    persona_id: str,
    *,
    kind: str = "",
    limit: int = 200,
    db_path: Path | None = None,
) -> list[MemoryEntry]:
    sql = "SELECT * FROM memory WHERE persona_id = ?"
    args: list = [persona_id]
    if kind:
        sql += " AND kind = ?"
        args.append(kind)
    sql += " ORDER BY created_at DESC, id DESC LIMIT ?"
    args.append(int(limit))
    with _connect(db_path) as conn:
        return [_row(r) for r in conn.execute(sql, args).fetchall()]


def search_memory(
    persona_id: str,
    query: str,
    *,
    limit: int = 12,
    db_path: Path | None = None,
) -> list[MemoryEntry]:
    """Full-text search within one persona's memory.

    Ranked by FTS relevance *modulated by weight*, so a note you wrote
    outranks an equally-matching line inferred from a render. An empty
    or unparseable query degrades to "most recent, highest weight"
    rather than raising — this is called from an agent turn, and a
    stray quote in a query shouldn't fail the turn.
    """
    q = query.strip()
    with _connect(db_path) as conn:
        if q:
            try:
                rows = conn.execute(
                    """
                    SELECT m.*, bm25(memory_fts) AS rank
                    FROM memory_fts
                    JOIN memory m ON m.id = memory_fts.rowid
                    WHERE memory_fts MATCH ? AND m.persona_id = ?
                    -- bm25() is NEGATIVE, more-negative = better match.
                    -- So weight is applied by MULTIPLYING: a high-trust
                    -- note pushes further negative and sorts first.
                    -- Dividing (the obvious-looking choice) inverts the
                    -- boost and ranks provenance above your own notes.
                    ORDER BY (rank * m.weight) ASC
                    LIMIT ?
                    """,
                    (_fts_query(q), persona_id, int(limit)),
                ).fetchall()
                return [_row(r) for r in rows]
            except sqlite3.OperationalError:
                pass  # Malformed MATCH expression — fall through.
        rows = conn.execute(
            "SELECT * FROM memory WHERE persona_id = ?"
            " ORDER BY weight DESC, created_at DESC LIMIT ?",
            (persona_id, int(limit)),
        ).fetchall()
        return [_row(r) for r in rows]


def _fts_query(raw: str) -> str:
    """Turn user text into a safe FTS5 MATCH expression.

    FTS5 treats bare punctuation as syntax, so `pacing?` or `don't` blow
    up a query typed by a human. Each word is quoted and OR-ed, which
    also makes partial matches useful instead of requiring every term.
    """
    words = [w for w in "".join(c if c.isalnum() else " " for c in raw).split() if w]
    if not words:
        return '""'
    return " OR ".join(f'"{w}"' for w in words)


def delete_memory(entry_id: int, *, db_path: Path | None = None) -> None:
    with _connect(db_path) as conn:
        conn.execute("DELETE FROM memory WHERE id = ?", (entry_id,))
        conn.commit()


def memory_overview(
    persona_id: str,
    *,
    top: int = 6,
    db_path: Path | None = None,
) -> dict:
    """A compact digest for the agent prompt.

    The prompt can't carry a persona's whole memory — that's the point
    of making the agent search. What it CAN carry is proof that memory
    exists and a sense of its shape: how many entries of each kind, and
    the highest-trust few verbatim. Without that, an instruction to
    "consult your memory" is an instruction to search for nothing.
    """
    with _connect(db_path) as conn:
        counts = {
            r["kind"]: int(r["n"])
            for r in conn.execute(
                "SELECT kind, COUNT(*) AS n FROM memory WHERE persona_id = ? GROUP BY kind",
                (persona_id,),
            ).fetchall()
        }
        rows = conn.execute(
            "SELECT * FROM memory WHERE persona_id = ?"
            " ORDER BY weight DESC, created_at DESC LIMIT ?",
            (persona_id, int(top)),
        ).fetchall()
    return {
        "persona_id": persona_id,
        "total": sum(counts.values()),
        "counts": counts,
        "top": [_row(r).to_dict() for r in rows],
    }


def graph_data(persona_id: str, *, db_path: Path | None = None) -> dict:
    """Nodes and edges for the in-app knowledge graph.

    Shape: the persona sits at the centre, each memory kind is a hub, and
    entries hang off their hub. Entries that share a `source` (the same
    project, the same reference URL) are linked to each other, which is
    what makes clusters appear — a run of lessons from one series ends
    up visibly adjacent instead of scattered by date.
    """
    entries = list_memory(persona_id, limit=1000, db_path=db_path)
    nodes: list[dict] = [
        {"id": f"persona:{persona_id}", "kind": "persona", "label": persona_id, "weight": 1.0}
    ]
    edges: list[dict] = []

    kinds_present = sorted({e.kind for e in entries})
    for k in kinds_present:
        nodes.append({"id": f"kind:{k}", "kind": "kind", "label": k, "weight": 0.8})
        edges.append({"source": f"persona:{persona_id}", "target": f"kind:{k}", "relation": "has"})

    by_source: dict[str, list[str]] = {}
    for e in entries:
        nid = f"entry:{e.id}"
        nodes.append(
            {
                "id": nid,
                "kind": e.kind,
                "label": e.title or (e.body[:60] + ("…" if len(e.body) > 60 else "")),
                "body": e.body,
                "source": e.source,
                "weight": e.weight,
                "created_at": e.created_at,
            }
        )
        edges.append({"source": f"kind:{e.kind}", "target": nid, "relation": "contains"})
        if e.source:
            by_source.setdefault(e.source, []).append(nid)

    for source, ids in by_source.items():
        if len(ids) < 2:
            continue
        # Chain rather than clique: a fully-connected group of 30 entries
        # is an unreadable hairball, and a chain conveys the same
        # "these belong together" without the edge explosion.
        for a, b in zip(ids, ids[1:], strict=False):
            edges.append({"source": a, "target": b, "relation": "same-source", "label": source})

    return {"persona_id": persona_id, "nodes": nodes, "edges": edges}


def export_graph_json(persona_id: str, out: Path, *, db_path: Path | None = None) -> Path:
    data = graph_data(persona_id, db_path=db_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, indent=2) + "\n")
    return out
