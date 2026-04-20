#!/usr/bin/env bash
set -euo pipefail

if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "ERROR: ffmpeg not found on PATH." >&2
    echo "  macOS:  brew install ffmpeg" >&2
    echo "  Debian: sudo apt install ffmpeg" >&2
    exit 1
fi

if ! command -v ffprobe >/dev/null 2>&1; then
    echo "ERROR: ffprobe not found on PATH (usually bundled with ffmpeg)." >&2
    exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "ERROR: Node.js >=18 and npm are required (for the Remotion render backend)." >&2
    echo "  macOS:  brew install node" >&2
    echo "  Debian: sudo apt install nodejs npm" >&2
    echo "  Or use nvm: https://github.com/nvm-sh/nvm" >&2
    exit 1
fi

NODE_MAJOR=$(node -p 'parseInt(process.versions.node.split(".")[0], 10)' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo "ERROR: Node $NODE_MAJOR.x detected; Remotion needs Node >=18." >&2
    echo "  Upgrade (macOS): brew upgrade node" >&2
    exit 1
fi

find_python() {
    # Honor explicit override first.
    if [ -n "${PYTHON:-}" ]; then
        if ! command -v "$PYTHON" >/dev/null 2>&1; then
            echo "ERROR: PYTHON=$PYTHON not found on PATH (and not an existing file)." >&2
            exit 1
        fi
        if ! "$PYTHON" -c 'import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] < (3, 13) else 1)' 2>/dev/null; then
            ver=$("$PYTHON" -c 'import sys; print(".".join(map(str, sys.version_info[:3])))' 2>/dev/null || echo unknown)
            echo "ERROR: PYTHON=$PYTHON is $ver — need 3.10, 3.11, or 3.12 (ML deps lack 3.13+ wheels)." >&2
            exit 1
        fi
        echo "$PYTHON"
        return
    fi
    # Auto-discover a usable interpreter.
    for candidate in python3.12 python3.11 python3.10 python3 \
        /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11 /opt/homebrew/bin/python3.10 \
        /usr/local/bin/python3.12 /usr/local/bin/python3.11 /usr/local/bin/python3.10; do
        if command -v "$candidate" >/dev/null 2>&1 && \
           "$candidate" -c 'import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] < (3, 13) else 1)' 2>/dev/null; then
            echo "$candidate"
            return
        fi
    done
    echo "ERROR: no Python 3.10-3.12 found. Install one (e.g. 'brew install python@3.12') or set PYTHON=/path/to/python3.x." >&2
    exit 1
}

PYTHON=$(find_python)
echo "Using $PYTHON ($("$PYTHON" --version))"

if [ ! -d ".venv" ]; then
    "$PYTHON" -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate

pip install --upgrade pip
pip install -e ".[dev]"

playwright install chromium

FONT_DIR="templates/fonts"
mkdir -p "$FONT_DIR"
if [ ! -f "$FONT_DIR/DejaVuSans.ttf" ] || [ ! -f "$FONT_DIR/DejaVuSans-Bold.ttf" ]; then
    echo "Fetching DejaVu fonts..."
    TARBALL="https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.tar.bz2"
    TMP=$(mktemp -d)
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$TARBALL" -o "$TMP/dejavu.tar.bz2"
    else
        wget -q "$TARBALL" -O "$TMP/dejavu.tar.bz2"
    fi
    tar -xjf "$TMP/dejavu.tar.bz2" -C "$TMP"
    cp "$TMP"/dejavu-fonts-ttf-*/ttf/DejaVuSans.ttf "$FONT_DIR/"
    cp "$TMP"/dejavu-fonts-ttf-*/ttf/DejaVuSans-Bold.ttf "$FONT_DIR/"
    rm -rf "$TMP"
fi

REMOTION_DIR="remotion"
if [ -f "$REMOTION_DIR/package.json" ]; then
    if [ ! -d "$REMOTION_DIR/node_modules" ]; then
        echo "Installing Remotion backend deps..."
        if ! (cd "$REMOTION_DIR" && npm install --no-fund --no-audit); then
            echo >&2
            echo "########################################################################" >&2
            echo "# ERROR: Remotion backend install FAILED." >&2
            echo "# The ffmpeg backend will still work, but --backend remotion will not." >&2
            echo "# Fix the npm error above, then run:  cd $REMOTION_DIR && npm install" >&2
            echo "########################################################################" >&2
            exit 1
        fi
    fi
    if [ ! -f "$REMOTION_DIR/public/gradient.jpg" ]; then
        echo "Generating default gradients..."
        python scripts/make_gradients.py
    fi
fi

echo
echo "Clipwright installed. Activate with: source .venv/bin/activate"
echo "Try:                                 clipwright --help"
