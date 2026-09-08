# Attribution

This skill — and its eleven siblings under `.claude/skills/remotion-*`
— are a vendored snapshot of the Remotion team's agent-skill set.

- **Upstream repo**: https://github.com/remotion-dev/skills
- **Upstream docs**: https://www.remotion.dev/docs/ai/skills
- **Snapshot commit**: `54e9b19a612897171e0b3b242e01c2badba4a272` (2026-09-01)
- **Skill version**: `4.0.520`
- **Maintained by**: the Remotion team

## The twelve skills

`remotion-best-practices` is the **router**: it carries no rules of its
own beyond a dispatch table, and delegates to the other eleven via
relative links (`./remotion-markup/REFERENCE.md`, etc.). To make those
links resolve, upstream nests a copy of each sibling inside the router
directory — so `remotion-markup/` exists both at the top level (as an
independently invocable `/remotion-markup` skill, entry point
`SKILL.md`) and under `remotion-best-practices/remotion-markup/`
(entry point `REFERENCE.md`). The two copies are otherwise identical.
Don't "deduplicate" them; the router's links break if you do.

| Skill | Covers |
| --- | --- |
| `remotion-best-practices` | Router — start here, it dispatches to the rest |
| `remotion-markup` | Compositions, animation, layout, typography, media, effects, audio, fonts, timing |
| `remotion-create` | Scaffolding a new project or composition |
| `remotion-studio` | Launching Studio for a preview |
| `remotion-render` | Rendering to a video or a still |
| `remotion-captions` | Transcribing, displaying, animating captions |
| `remotion-maps` | Map animations — Mapbox, MapLibre, MapTiler, GeoJSON, 3D flyovers |
| `remotion-multimedia` | Browser-side media handling via Mediabunny |
| `remotion-interactivity` | Structuring markup so Studio can edit it back into code |
| `remotion-saas` | `<Player>`, Lambda/Vercel/Cloudflare rendering, app architecture |
| `remotion-docs` | Searching and fetching Remotion docs as Markdown |
| `remotion-upgrade` | Upgrading Remotion, Mediabunny, and these skills |

## Why vendored

Clipwright Studio's render backend is Remotion, and the Claude rail
auto-invokes `remotion-best-practices` on every turn that touches
composition code. Vendoring guarantees:

- The skills ship with the repo — every contributor's rail picks them
  up automatically, with no separate install step.
- They stay at a known revision; an upstream change won't silently
  alter how existing projects get edited.
- They appear in the desktop app's "+ New video" skill picker as
  `project`-scoped entries, so a video can be created with a specific
  Remotion skill pre-selected as a default.

## Updating

Upstream ships an installer (`npx skills add remotion-dev/skills`),
but it writes to the *user's* skill directory. Clipwright vendors into
the repo instead, so refresh with:

```bash
TMP=$(mktemp -d)
git clone --depth 1 https://github.com/remotion-dev/skills "$TMP"

# Router: replace upstream content, keep the two local files.
rm -rf .claude/skills/remotion-best-practices/SKILL.md
cp -R "$TMP/skills/remotion-best-practices/." .claude/skills/remotion-best-practices/

# The eleven siblings, wholesale.
for d in "$TMP"/skills/*/; do
  n=$(basename "$d")
  [ "$n" = "remotion-best-practices" ] && continue
  rm -rf ".claude/skills/$n"
  cp -R "$d" ".claude/skills/$n"
done

# Record the new snapshot commit + date in this file.
( cd "$TMP" && git log -1 --format='%H %ci' )
rm -rf "$TMP"
```

Then re-check `CLIPWRIGHT_NOTES.md`: it cites upstream files by path,
and upstream reorganizes them between releases (the 4.0.520 release
deleted the old flat `rules/` directory and split it across the eleven
sibling skills).

## Local override

`CLIPWRIGHT_NOTES.md`, next to this file, carries the project-specific
overrides that the agent prompt instructs Claude to consult AFTER the
upstream skills — chiefly: ignore upstream's "default to ElevenLabs"
voiceover recommendation and use the project's configured TTS provider
(Kokoro / OpenAI / …) instead. See that file for the full list. It is
the only Clipwright-authored content in this tree; everything else is
upstream verbatim.
