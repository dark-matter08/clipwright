#!/usr/bin/env bash
# Install Remotion's official agent skill for Claude Code, idempotently.
#
# Wraps `npx skills add remotion-dev/skills` and records the upstream commit
# SHA in `<target>/.skill-version` so re-runs can no-op when already current.
#
# Env:
#   CLIPWRIGHT_SKILL_TARGET        Dir to install into (default: ~/.claude/skills/remotion-best-practices)
#   CLIPWRIGHT_REMOTION_SKILL_REF  Upstream ref to pin (default: main)
#
# Flags:
#   --project <dir>   Install into <dir>/.claude/skills/remotion-best-practices (per-project scope)
#   --force           Overwrite even if the target exists without a .skill-version stamp
#   --quiet           Suppress informational output

set -euo pipefail

GLOBAL=1
PROJECT_DIR=""
FORCE=0
QUIET=0

while [ $# -gt 0 ]; do
    case "$1" in
        --project) PROJECT_DIR="${2:-}"; GLOBAL=0; shift 2 ;;
        --force)   FORCE=1; shift ;;
        --quiet)   QUIET=1; shift ;;
        -h|--help)
            sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

log() { [ "$QUIET" = 1 ] || echo "[remotion-skill] $*"; }
die() { echo "[remotion-skill] ERROR: $*" >&2; exit 1; }

if ! command -v npx >/dev/null 2>&1; then
    die "npx not found — install Node.js 18+ first."
fi

REF="${CLIPWRIGHT_REMOTION_SKILL_REF:-main}"

if [ -n "$PROJECT_DIR" ]; then
    PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
    TARGET="${CLIPWRIGHT_SKILL_TARGET:-$PROJECT_DIR/.claude/skills/remotion-best-practices}"
else
    TARGET="${CLIPWRIGHT_SKILL_TARGET:-$HOME/.claude/skills/remotion-best-practices}"
fi

# Resolve upstream SHA (gh API is cheap; fall back to raw endpoint).
resolve_sha() {
    if command -v gh >/dev/null 2>&1; then
        gh api "repos/remotion-dev/skills/commits/$REF" --jq .sha 2>/dev/null && return
    fi
    curl -fsSL -H 'Accept: application/vnd.github+json' \
        "https://api.github.com/repos/remotion-dev/skills/commits/$REF" 2>/dev/null \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha"])' 2>/dev/null
}

UPSTREAM_SHA="$(resolve_sha || true)"
if [ -z "$UPSTREAM_SHA" ]; then
    # Offline: if an install already exists, no-op. Else fail.
    if [ -f "$TARGET/SKILL.md" ]; then
        log "offline; keeping existing skill at $TARGET"
        exit 0
    fi
    die "cannot reach GitHub to resolve remotion-dev/skills@$REF"
fi

STAMP="$TARGET/.skill-version"
if [ -f "$STAMP" ]; then
    CURRENT="$(cat "$STAMP" 2>/dev/null || true)"
    if [ "$CURRENT" = "$UPSTREAM_SHA" ]; then
        log "already up to date ($UPSTREAM_SHA) at $TARGET"
        exit 0
    fi
    log "upgrading from ${CURRENT:0:12} → ${UPSTREAM_SHA:0:12}"
elif [ -d "$TARGET" ] && [ "$FORCE" != 1 ]; then
    die "$TARGET exists but has no .skill-version stamp; re-run with --force to replace"
fi

# Back up an existing installation before replacing.
if [ -d "$TARGET" ]; then
    TS="$(date +%Y%m%d-%H%M%S)"
    BAK="$TARGET.bak-$TS"
    mv "$TARGET" "$BAK"
    log "backed up to $BAK"
    # Prune older backups, keep 2 newest.
    PARENT="$(dirname "$TARGET")"
    BASENAME="$(basename "$TARGET")"
    # shellcheck disable=SC2012  # ls -t is fine here; names are controlled
    ls -1dt "$PARENT/$BASENAME".bak-* 2>/dev/null | tail -n +3 | xargs -I{} rm -rf {}
fi

# Stage into a fresh temp dir, then swap into place.
STAGE="$(mktemp -d -t clipwright-remotion-skill.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/.claude/skills"

# `skills add` installs into $cwd/.claude/skills/<slug> by default.
# Using --copy to avoid symlinks that break when the cache is cleared.
(
    cd "$STAGE"
    npx -y skills add remotion-dev/skills \
        --skill remotion-best-practices \
        --agent claude-code \
        --copy \
        --yes \
        >/dev/null 2>&1
)

SRC="$STAGE/.claude/skills/remotion-best-practices"
if [ ! -f "$SRC/SKILL.md" ]; then
    die "skills CLI did not produce $SRC/SKILL.md"
fi

mkdir -p "$(dirname "$TARGET")"
mv "$SRC" "$TARGET"
echo "$UPSTREAM_SHA" > "$STAMP"

log "installed remotion skill @ ${UPSTREAM_SHA:0:12} → $TARGET"
