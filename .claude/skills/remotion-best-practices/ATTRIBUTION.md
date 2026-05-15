# Attribution

This skill is a vendored snapshot of the upstream `@remotion/skills`
package, specifically the `skills/remotion/` directory.

- **Upstream repo**: https://github.com/remotion-dev/skills
- **Upstream tree URL**: https://github.com/remotion-dev/remotion/tree/main/packages/skills
- **Snapshot commit**: `277510e78245ac0fa275d7cb6520d52e0ac2e212` (2026-05-07)
- **Maintained by**: the Remotion team

## Why vendored

Clipwright Studio's Claude rail auto-invokes the
`remotion-best-practices` skill on every turn (the render backend is
Remotion and the skill carries the domain knowledge for how to write
correct compositions, captions, audio, etc.). Vendoring guarantees:

- The skill ships with the repo — every contributor's rail picks it
  up automatically without a separate install step.
- The skill stays at a known revision; an upstream change won't
  silently affect existing projects.

## Updating

To refresh against upstream:

```bash
TMP=$(mktemp -d)
git clone --depth 1 https://github.com/remotion-dev/skills "$TMP"
rm -rf .claude/skills/remotion-best-practices/SKILL.md \
       .claude/skills/remotion-best-practices/rules
cp -R "$TMP/skills/remotion/"* .claude/skills/remotion-best-practices/
# Update the snapshot commit + date in this file.
( cd "$TMP" && git log -1 --format='%H %ci' )
rm -rf "$TMP"
```

## Local override

A `CLIPWRIGHT_NOTES.md` next to this file (alongside `SKILL.md`)
carries project-specific overrides that the agent prompt instructs
Claude to consult AFTER the upstream skill — chiefly: ignore the
upstream's "default to ElevenLabs" voiceover recommendation and use
the project's configured TTS provider (Kokoro / OpenAI / etc.)
instead. See `CLIPWRIGHT_NOTES.md` for the full list.
