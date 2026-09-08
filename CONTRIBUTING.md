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

The repo holds three pieces: the desktop app (`desktop/`), the Python engine
it drives (`src/clipwright/`), and the Remotion compositions used for
panel/recap renders (`remotion/`).

```
git clone https://github.com/dark-matter08/clipwright
cd clipwright
./install.sh                 # engine + Playwright + fonts + remotion deps
source .venv/bin/activate
```

For the desktop app you also need [Bun](https://bun.sh) and a Rust toolchain
(Tauri):

```
cd desktop
bun install
bun run tauri:dev
```

## Checks

CI runs the first two; run them before pushing. The desktop and Remotion
checks aren't in CI yet, so run them when you touch those trees.

```
ruff check src tests         # lint the engine
pytest                       # engine tests
cd desktop && npx tsc -b     # typecheck the app (frontend)
cd desktop/src-tauri && cargo check
cd remotion && npx tsc --noEmit
```

`ffmpeg` / `ffprobe` must be on PATH. Playwright's browser is only needed for
`record-project`; unit tests don't require it.

## Pull requests

- Keep changes focused. One concern per PR.
- Preserve the Hard Rules in `SKILL.md`. Changes that touch the render
  pipeline must explain how each rule is still honored.
- Add a test for any caption / trim / chunking change.
- No new runtime dependencies without discussion. The Pillow + Playwright +
  Typer + requests + rich set is the surface we want to keep.
