# Contributing to Clipwright

Thank you for your interest. Clipwright is MIT-licensed and uses the
Developer Certificate of Origin (DCO) rather than a CLA.

## Developer Certificate of Origin

Every commit must be signed off. `git commit -s` appends a line like:

```
Signed-off-by: Your Name <you@example.com>
```

By signing off you agree to the DCO (https://developercertificate.org/).
Pull requests with unsigned commits will fail CI.

## Dev setup

```
git clone https://github.com/dark-matter08/clipwright
cd clipwright
./install.sh
source .venv/bin/activate
pip install -e ".[dev]"
```

`ffmpeg` / `ffprobe` must be on PATH. Playwright's browser is only needed for
the `record` subcommand; unit tests don't require it.

## Tests

```
pytest
ruff check src tests
```

## Pull requests

- Keep changes focused. One concern per PR.
- Preserve the Hard Rules in `SKILL.md`. Changes that touch the render
  pipeline must explain how each rule is still honored.
- Add a test for any caption / trim / chunking change.
- No new runtime dependencies without discussion. The Pillow + Playwright +
  Typer + requests + rich set is the surface we want to keep.
