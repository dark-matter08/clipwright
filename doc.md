# Clipwright — PMF Synthesis & Roadmap

## Context

Clipwright today is a Python CLI + Claude Code skill that turns a declarative `browse-plan.json` (Playwright actions) into a vertical short-form MP4 with TTS voiceover, character-aligned 2-word UPPERCASE captions, and a branded outro. It works. The pipeline is correct ([SKILL.md](SKILL.md) hard rules: subs LAST, per-segment extract, 30ms fades, word-boundary cuts) and the architecture (one artifact per stage) is sound.

What it lacks is product-market fit. Three independent audits — PM, technical-writer, UX — converge on the same gaps: the iteration loop is brutal, the `script.json` authoring wall locks out non-Claude-Code users, install friction silently disqualifies the broader audience, and the CLI surface (8 commands, naming drift, silent failure modes) leaks cognitive load at every step. The codebase has the right primitives; the product layer on top of those primitives is missing.

This plan picks a positioning (**agent-first, with CLI escape hatch**) and a bullseye (**indie devs / DevRel shipping launch reels**) and lists the moves that close the PMF gap, ranked.

---

## Part 1 — Strategic Synthesis

### Positioning (one line)

> *The only short-form demo video tool you can `git commit` and an agent can drive end-to-end.*

Frame Clipwright as a **Claude Code skill that produces social-ready vertical demos**, with the CLI as the engine underneath. The standalone CLI is the second audience, not the first. This matches how [SKILL.md](SKILL.md) is already written (it's the most detailed product spec in the repo) and how `script init` already defers copy-writing to the agent ([cli.py:266](src/clipwright/cli.py:266)).

### Bullseye user & JTBD

**Who:** Indie devs, founders, and DevRel producing TikTok/X/LinkedIn vertical clips for feature launches, OSS releases, and AI-tool reveals. They live in CLIs, are comfortable with JSON, and increasingly in Claude Code.

**Job:** *"I shipped a feature this morning. I want a 30-second vertical reel for X/LinkedIn by lunch — and a regenerable one I can `git commit` so when the UI changes, the reel updates without re-recording from scratch."*

This is the only segment where Clipwright's design choices (9:16 default, 2-word UPPERCASE captions, 10–16s chapters, ~2.5 wps, branded outro) **all** point the same direction. Every other plausible segment (investor demos, support docs, app store previews, internal training, agency client work) requires either a different format, a producer/engineer handoff surface, or a polish pass that Clipwright today doesn't have and shouldn't try to add.

### What credibly beats the alternatives

| vs. | Wins on | Loses on |
|---|---|---|
| Arcade / Supademo | Real MP4 output for social, agent-driveable, repo-checked-in | Polish, no-code authoring, embed analytics |
| Screen Studio | Free, automation, regeneratable on UI change | Mac polish, ease, zoom UX |
| Tella / Loom | Vertical short-form fit, no talking head | Speed-to-first-video, sharing |
| Descript / Veed | Free, local, agent-native authoring | Editing affordances, stock library, music |
| Bespoke ffmpeg | The production-correctness rules in SKILL.md are hard-won knowledge | (decisively wins) |

### Convergent PMF gaps (the core problem)

The three audits converge on these. In severity order:

1. **Iteration is punishing.** Changing one word of voiceover re-runs full TTS ([cli.py:266–297](src/clipwright/cli.py:266) has no hash check), then full caption regen, then full render. Per-stage artifacts are *built* for caching; the policy isn't there.
2. **`script.json` is a wall for non-Claude users.** `script init` writes empty `text` fields ([plan/script_skeleton.py](src/clipwright/plan/script_skeleton.py)) and the README explicitly says the agent fills them. CLI-only users are stuck.
3. **No preview before TTS spend.** The only review checkpoint is `clipwright edit-plan`, which is a `print` to stdout ([cli.py:220–247](src/clipwright/cli.py:220)) — it doesn't *edit* anything despite the name. Caption timing, voice tone, zoom feel are only visible after the full render.
4. **Install + onboarding floor is high.** Python 3.10–3.12 ceiling (3.13 is now default on `brew install python`), Node ≥ 18, ffmpeg, ~2GB Kokoro/PyTorch lazily downloaded on first `tts` run. Silently disqualifies a large swath of would-be users.
5. **Surface area sprawls.** 8 separate commands, two `init` scaffolding paths (`browse-plan.json` AND legacy `demo.py` at [cli.py:84–92](src/clipwright/cli.py:84)), `edit-plan` mis-named, no `clipwright status`/`doctor`, no resumability ("I closed the laptop after `tts`, what now?").
6. **Documentation gaps for the strangers.** README never shows a `browse-plan.json` example, never defines *chapter* / *moment* / *segment*, [examples/hello-world/README.md](examples/hello-world/README.md) is stale (uses deprecated `clipwright trim`, old config field names like `pre_roll`/`post_roll` instead of `lead`/`trail`).
7. **Silent failure modes.** Missing chapter labels, sub-2s waits, run-on script copy, wrong render backend prerequisites — all produce bad videos or `typer.BadParameter` strings rather than structured errors with fix hints.

### What NOT to do

These look tempting but dilute the wedge.

- **Don't build a GUI.** It moves you off the "checked-in, agent-driven, regeneratable" position and into the Screen Studio fight you lose. CLI + watch loop + Remotion Studio preview is enough.
- **Don't add talking-head / webcam / screen-share import.** That's Loom/Tella territory; the design (2-word caps, 10–16s chapters) is wrong for it.
- **Don't generalize beyond browser flows.** OS-level capture pulls you away from Playwright's deterministic, re-runnable, agent-friendly recording — which is the actual moat.
- **Don't host or ship analytics / SaaS dashboard.** Hosting kills the `git commit`-able promise.
- **Don't expand TTS providers.** Three (Kokoro/Piper/ElevenLabs) is the right number — adding OpenAI/Cartesia/PlayHT is decision fatigue, not differentiation.
- **Don't fork SKILL.md prosody rules into a "creative engine."** Those rules *are* the product knowledge; codify them into a deterministic `script suggest` rather than letting each agent re-derive them.

---

## Part 2 — Roadmap (ranked)

Each move lists: the friction it removes, the files to touch, the exit criterion. Ordered for highest-leverage-first; later moves depend on earlier ones being solid.

### Move 1 — Per-clip TTS + caption caching (the iteration unlock)

**Friction removed:** ~80% of the iteration cost. One-word edits go from "5 minutes and $0.40" to "5 seconds and $0.04."

**Change:**
- In [src/clipwright/cli.py:266](src/clipwright/cli.py:266) (`tts` command), before calling `tts_provider.synthesize`, hash `(clip.text, voice, provider_name, target_seconds)`. Persist to `out/audio/<id>.cache.json`. Skip synth + stretch when the hash matches.
- Mirror in [src/clipwright/cli.py:300](src/clipwright/cli.py:300) (`caption` command): hash the timestamps file content; skip PNG regen on match.
- Add `--force` flag on both for explicit invalidation.
- Render side ([src/clipwright/render/](src/clipwright/render/)): per-segment `ffmpeg` extract output is already cacheable by `(source_start, source_end, video.mp4 mtime)` — wire that in if cheap.

**Exit:** running `tts` twice in a row with no `script.json` change makes zero provider calls and prints `[cached]` per clip. ElevenLabs spend on a 2nd render of the same script == $0.

### Move 2 — `clipwright build` orchestrator + structured errors

**Friction removed:** 8 commands, no progress UI, "what do I run next?", silent typer.BadParameter strings.

**Change:**
- New top-level command in [src/clipwright/cli.py](src/clipwright/cli.py) that runs `record? → segments → keyframes → script init → tts → caption → outro → render` in sequence with a Rich progress bar per stage and an explicit confirm gate before TTS spend (replacing today's implicit `edit-plan` review).
- Stage skipping when artifact hashes match the previous run (leverages Move 1).
- Replace the `typer.BadParameter("missing X — run Y first")` pattern (e.g. [cli.py:230](src/clipwright/cli.py:230)) with a `ClipwrightError(cause, fix_command, docs_link)` exception class. Centralize formatting via Rich.
- Add `clipwright status` that prints the current pipeline state (which artifacts exist, which are stale).
- Existing per-stage commands stay as the power-user surface.

**Exit:** `clipwright build` from a fresh `init` produces `out/final.mp4` with one command and one confirm prompt before TTS. Failures print "X failed because Y. Fix: run Z. See: docs/troubleshooting.md#anchor."

### Move 3 — `clipwright preview` (Remotion Studio integration)

**Friction removed:** voiceover-authored-blind, no pre-render preview, the "render-the-whole-thing-to-see-it" cycle.

**Change:**
- `remotion/node_modules` is already installed by `install.sh`. Wire a new `clipwright preview [--segment N]` command that launches Remotion Studio against the current `segments.json` + `camera.json` + `script.json`.
- Hot reload on `script.json` save — devs see the timing of their copy without paying TTS.
- Use Piper (free, offline, 200MB) as the *preview* TTS regardless of `tts_provider` config, so previews are zero-cost.