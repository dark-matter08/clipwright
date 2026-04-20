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

PYTHON="${PYTHON:-python3}"
if ! "$PYTHON" -c 'import sys; assert sys.version_info >= (3, 10)' 2>/dev/null; then
    echo "ERROR: Python 3.10+ required. Set PYTHON=/path/to/python3." >&2
    exit 1
fi

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

echo
echo "Clipwright installed. Activate with: source .venv/bin/activate"
echo "Try:                                 clipwright --help"
