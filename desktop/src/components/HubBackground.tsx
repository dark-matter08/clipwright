// HubBackground — decorative editing-motif scaffolding for the
// landing view. Pure SVG, theme-aware via token classes (so the
// pattern fades gracefully between light + dark), pointer-events
// disabled so it never interferes with clicks on the cards above.
//
// Design intent: the Hub used to read like a settings dialog
// (white card on white surface). For a VIDEO EDITOR's landing,
// the bare canvas felt off-brand. This component lays down the
// visual vocabulary the rest of the app uses — film perforations,
// timeline ruler ticks, a faint waveform line, a scattering of
// keyframe diamonds — at low opacity so the foreground content
// still leads.
//
// Composition:
//   1. Top-left + bottom-right film strip — diagonal slabs with
//      circular perforations, the iconic 35mm-stock motif.
//   2. Bottom-edge timeline ruler — second/sub-second ticks
//      stretching across the viewport bottom.
//   3. Subtle waveform line — a single hand-curve through the
//      middle of the empty space below the recents list,
//      suggesting the audio track that an editor would see.
//   4. Floating keyframe diamonds — three rotated squares
//      scattered in the negative space, the editor's "keyframe"
//      icon repurposed as decoration.
//
// All colors use the design-system tokens directly via Tailwind
// utility classes (text-border-subtle, text-fg-muted, etc.) so
// the pattern shifts with the theme — vivid-but-restrained in
// light, near-invisible in dark (which already has its own
// chrome richness from the timeline lanes).

import { cn } from "../lib/cn";

interface HubBackgroundProps {
  /** Optional className passed through for layout overrides. */
  className?: string;
}

export function HubBackground({ className }: HubBackgroundProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden",
        className,
      )}
    >
      {/* ── Top-left film strip ─────────────────────────────────
       *  Two parallel rails framing six perforations, rotated
       *  slightly so the strip reads as "running off the edge."
       *  Lives in the upper-left corner, fades to nothing past
       *  the half-width. */}
      <FilmStrip
        className="absolute -left-12 -top-16 h-72 w-[420px] -rotate-[8deg] text-border-subtle opacity-70"
        perforations={7}
      />

      {/* ── Bottom-right film strip ─────────────────────────────
       *  Mirror of the top strip, rotated the opposite way so
       *  the two corners "frame" the content without bracketing
       *  it symmetrically (symmetry would feel decorative;
       *  asymmetry feels editorial). */}
      <FilmStrip
        className="absolute -bottom-20 -right-16 h-72 w-[460px] rotate-[10deg] text-border-subtle opacity-60"
        perforations={8}
      />

      {/* ── Bottom-edge timeline ruler ──────────────────────────
       *  Second-marker ticks running the full width of the
       *  viewport ~64px above the bottom edge. Long ticks every
       *  5 seconds; short ticks at every second. */}
      <TimelineRuler className="absolute bottom-16 left-0 right-0 h-6 text-border opacity-60" />

      {/* ── Waveform line ───────────────────────────────────────
       *  A single hand-tuned curve, suggesting an audio track
       *  drifting through the page. Lives in the negative space
       *  below the recents list. */}
      <Waveform className="absolute bottom-44 left-0 right-0 h-12 text-fg-muted opacity-40" />

      {/* ── Keyframe diamonds ───────────────────────────────────
       *  Three rotated squares scattered through the page's empty
       *  zones. Reads as "this is editing software" without
       *  spelling it out. */}
      <Diamond
        size={10}
        className="absolute left-[8%] top-[34%] text-accent opacity-70"
      />
      <Diamond
        size={8}
        className="absolute right-[12%] top-[22%] text-fg-muted opacity-50"
      />
      <Diamond
        size={12}
        className="absolute left-[14%] bottom-[26%] text-accent opacity-50"
      />
      <Diamond
        size={8}
        className="absolute right-[22%] bottom-[36%] text-fg-muted opacity-60"
      />

      {/* ── Soft accent glow ────────────────────────────────────
       *  A single radial gradient parked behind the header — a
       *  whisper of accent color so the page has a "direction"
       *  to the eye without anything visibly graphic. */}
      <div
        className="absolute -top-32 left-1/2 h-96 w-[640px] -translate-x-1/2 rounded-full opacity-25 blur-3xl"
        style={{
          background:
            "radial-gradient(ellipse at center, hsl(var(--accent) / 0.35), transparent 70%)",
        }}
      />
    </div>
  );
}

/* ── Building blocks ────────────────────────────────────────────
 *
 * Each piece is its own component because (a) they're naturally
 * parameterized (perforation count, tick spacing, etc.) and
 * (b) keeping them separate makes future iterations cheap — e.g.
 * a film-strip variant with sprocket holes that animate on
 * hover would just be a prop on FilmStrip.
 */

function FilmStrip({
  className,
  perforations,
}: {
  className?: string;
  perforations: number;
}) {
  // Each perforation is a circular cutout punched through the
  // strip's two rails. We render them as filled circles with a
  // currentColor stroke so the parent's `text-*` class controls
  // tint, and the perforations look like "holes" against a
  // lighter rail.
  const perfs = Array.from({ length: perforations }, (_, i) => i);
  return (
    <svg
      viewBox="0 0 420 200"
      preserveAspectRatio="none"
      className={className}
    >
      {/* Top rail */}
      <rect
        x="0"
        y="14"
        width="420"
        height="40"
        fill="currentColor"
        fillOpacity="0.5"
      />
      {/* Bottom rail */}
      <rect
        x="0"
        y="146"
        width="420"
        height="40"
        fill="currentColor"
        fillOpacity="0.5"
      />
      {/* Perforations — split between the two rails so the strip
       *  reads as proper 35mm stock with sprocket holes. */}
      {perfs.map((i) => {
        const cx = 24 + i * 56;
        return (
          <g key={i}>
            <rect
              x={cx - 10}
              y="22"
              width="20"
              height="24"
              rx="3"
              fill="hsl(var(--surface-base))"
            />
            <rect
              x={cx - 10}
              y="154"
              width="20"
              height="24"
              rx="3"
              fill="hsl(var(--surface-base))"
            />
          </g>
        );
      })}
      {/* Faint film body between the rails */}
      <rect
        x="0"
        y="54"
        width="420"
        height="92"
        fill="currentColor"
        fillOpacity="0.18"
      />
    </svg>
  );
}

function TimelineRuler({ className }: { className?: string }) {
  // Tick layout: 1 tick per 24px → ~50 ticks across a 1200px
  // viewport. Every 5th tick is taller, mimicking the
  // "every 5 seconds is a major mark" pattern in the actual
  // editor's TimeRuler.
  const ticks = Array.from({ length: 80 }, (_, i) => i);
  return (
    <svg
      viewBox="0 0 1920 24"
      preserveAspectRatio="none"
      className={className}
    >
      {/* Baseline */}
      <line
        x1="0"
        y1="22"
        x2="1920"
        y2="22"
        stroke="currentColor"
        strokeWidth="1"
        strokeOpacity="0.4"
      />
      {ticks.map((i) => {
        const x = i * 24;
        const major = i % 5 === 0;
        return (
          <line
            key={i}
            x1={x}
            y1="22"
            x2={x}
            y2={major ? 8 : 16}
            stroke="currentColor"
            strokeWidth="1"
            strokeOpacity={major ? "0.9" : "0.5"}
          />
        );
      })}
    </svg>
  );
}

function Waveform({ className }: { className?: string }) {
  // A single SVG path traced as a hand-tuned audio waveform —
  // peaks and troughs that suggest a voiceover track. The path
  // was sketched by hand at viewBox 0 0 1920 48; tweak the
  // coordinates here if you want a different shape, not a
  // generated wave function (a generated sine would feel
  // synthetic).
  return (
    <svg
      viewBox="0 0 1920 48"
      preserveAspectRatio="none"
      className={className}
    >
      <path
        d="
          M 0 24
          L 80 24 L 100 12 L 120 36 L 140 16 L 160 30 L 180 22
          L 240 22 L 260 8  L 280 40 L 300 14 L 320 32 L 340 20
          L 400 20 L 420 26 L 440 18 L 460 32 L 480 16 L 500 28
          L 560 24 L 600 10 L 640 38 L 680 16 L 720 30
          L 780 24 L 820 14 L 860 34 L 900 20 L 940 28
          L 1000 22 L 1040 32 L 1080 12 L 1120 36 L 1160 18
          L 1220 26 L 1260 14 L 1300 34 L 1340 20 L 1380 28
          L 1440 22 L 1480 30 L 1520 14 L 1560 36 L 1600 20
          L 1660 24 L 1700 16 L 1740 32 L 1780 20 L 1820 28
          L 1920 24
        "
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Diamond({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      className={cn("rotate-45", className)}
    >
      <rect
        x="1"
        y="1"
        width="10"
        height="10"
        rx="1"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="0.5"
      />
    </svg>
  );
}
