// HubBackground — decorative editing-motif scaffolding for the
// landing view.
//
// v3 design (after feedback that v2 still read monochromatic):
// the pattern pieces are no longer gray. The film strips wear
// the timeline lane tints — one blue, one purple — so the
// corners of the page carry actual color. The keyframe diamonds
// mix accent + lane palette instead of accent+muted. A new
// "lane stack" element near the bottom evokes three concurrent
// timeline tracks. A larger accent glow gives the page real
// visual gravity.
//
// What's still restrained: opacity. Each piece sits at 25-60%
// so the foreground content still leads. The composition is
// "colorful but quiet" — a video editor should feel chromatic,
// not a marketing splash page.
//
// Theme-aware via design-system tokens: in dark mode the
// pattern thins out (saturation in dark theme is already vivid
// in the timeline lanes, so the bg doesn't need to compete).

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
      {/* ── Accent + lane radial glows ──────────────────────────
       *  Two large soft-light blobs anchor the page chromatically.
       *  The cyan one sits behind the header (where the eye lands
       *  first); the purple one sits low-right (rebalancing the
       *  composition's center of mass away from the title).
       *  blur-3xl + opacity-30 keeps them as "atmosphere," not
       *  shapes. */}
      <div
        className="absolute -top-40 left-1/2 h-[480px] w-[760px] -translate-x-1/2 rounded-full opacity-40 blur-3xl"
        style={{
          background:
            "radial-gradient(ellipse at center, hsl(var(--accent) / 0.55), transparent 70%)",
        }}
      />
      <div
        className="absolute -bottom-32 right-[8%] h-[420px] w-[560px] rounded-full opacity-30 blur-3xl"
        style={{
          background:
            "radial-gradient(ellipse at center, hsl(var(--lane-audio) / 0.45), transparent 70%)",
        }}
      />
      <div
        className="absolute top-[30%] -left-32 h-[360px] w-[520px] rounded-full opacity-25 blur-3xl"
        style={{
          background:
            "radial-gradient(ellipse at center, hsl(var(--lane-video) / 0.45), transparent 70%)",
        }}
      />

      {/* ── Top-left film strip — video-lane blue ───────────────
       *  Was text-border-subtle; now wears the video-lane hue so
       *  the corner reads as "this is editing software" instead
       *  of "this is a card with a gray edge." */}
      <FilmStrip
        className="absolute -left-12 -top-16 h-72 w-[420px] -rotate-[8deg] text-lane-video opacity-50"
        perforations={7}
      />

      {/* ── Bottom-right film strip — audio-lane purple ─────────
       *  Mirrors the top strip in the opposite corner with a
       *  different color so the two strips read as a coherent
       *  "editing chrome" set, not duplicates. */}
      <FilmStrip
        className="absolute -bottom-20 -right-16 h-72 w-[460px] rotate-[10deg] text-lane-audio opacity-45"
        perforations={8}
      />

      {/* ── Lane stack — three thin colored tracks ──────────────
       *  Evokes the timeline view's Video / Audio / Captions
       *  lanes. Stretched across the full viewport just above
       *  the timeline ruler. Each lane is its own color so even
       *  on a quick glance the page carries the editor's
       *  three-lane vocabulary. */}
      <LaneStack className="absolute bottom-28 left-0 right-0 h-12" />

      {/* ── Bottom-edge timeline ruler ──────────────────────────
       *  Tinted with the accent so the ticks aren't gray-on-gray.
       *  Lower opacity than v2 (50%) because the lane stack
       *  above already carries weight. */}
      <TimelineRuler className="absolute bottom-16 left-0 right-0 h-6 text-accent opacity-50" />

      {/* ── Waveform line — accent-tinted ───────────────────────
       *  Same hand-tuned path as v2, but accent-tinted so it
       *  reads as the audio-track motif it's meant to evoke. */}
      <Waveform className="absolute bottom-44 left-0 right-0 h-12 text-accent opacity-55" />

      {/* ── Keyframe diamonds — mixed palette ───────────────────
       *  Five diamonds in four colors. Two are accent (cyan,
       *  bright), one is video-lane (blue), one is audio-lane
       *  (purple), one is captions-lane (amber). Reads as
       *  "everything's here" without being busy. */}
      <Diamond
        size={12}
        className="absolute left-[10%] top-[34%] text-accent opacity-90"
      />
      <Diamond
        size={10}
        className="absolute right-[12%] top-[22%] text-lane-video opacity-75"
      />
      <Diamond
        size={12}
        className="absolute left-[16%] bottom-[28%] text-accent opacity-70"
      />
      <Diamond
        size={9}
        className="absolute right-[22%] bottom-[40%] text-lane-audio opacity-75"
      />
      <Diamond
        size={10}
        className="absolute left-[42%] top-[14%] text-lane-captions opacity-70"
      />
    </div>
  );
}

/* ── Building blocks ─────────────────────────────────────────── */

function FilmStrip({
  className,
  perforations,
}: {
  className?: string;
  perforations: number;
}) {
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
        fillOpacity="0.55"
      />
      {/* Bottom rail */}
      <rect
        x="0"
        y="146"
        width="420"
        height="40"
        fill="currentColor"
        fillOpacity="0.55"
      />
      {/* Perforations — punched through with the page bg color
       *  so the "holes" read as actual cutouts. */}
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
      {/* Film body between the rails */}
      <rect
        x="0"
        y="54"
        width="420"
        height="92"
        fill="currentColor"
        fillOpacity="0.22"
      />
    </svg>
  );
}

/** Three thin colored horizontal bars evoking the editor's
 *  Video / Audio / Captions lanes. Each lane has a tinted body
 *  + ~6 segment-shaped tick marks to read as "this lane has
 *  clips on it." Pure decoration; the marks don't map to any
 *  real data. */
function LaneStack({ className }: { className?: string }) {
  // Segment x-positions per lane. Slightly offset so the three
  // lanes don't look like a single block of color (which would
  // read as a stripe, not three lanes).
  const videoSegs = [40, 200, 360, 540, 720, 940, 1180, 1400, 1620];
  const audioSegs = [40, 230, 420, 600, 820, 1040, 1220, 1440, 1640];
  const captionSegs = [40, 220, 400, 560, 740, 920, 1120, 1320, 1520, 1740];

  return (
    <svg
      viewBox="0 0 1920 96"
      preserveAspectRatio="none"
      className={className}
    >
      {/* Video lane */}
      <g opacity="0.35">
        <rect
          x="0"
          y="4"
          width="1920"
          height="24"
          fill="hsl(var(--lane-video-bg))"
        />
        {videoSegs.map((x, i) => {
          const next = videoSegs[i + 1] ?? 1900;
          return (
            <rect
              key={`v-${i}`}
              x={x}
              y="6"
              width={next - x - 14}
              height="20"
              rx="2"
              fill="hsl(var(--lane-video))"
              fillOpacity="0.55"
              stroke="hsl(var(--lane-video))"
              strokeOpacity="0.8"
              strokeWidth="1"
            />
          );
        })}
      </g>
      {/* Audio lane — waveform-style bars instead of solid blocks
       *  so the visual rhythm differs from the video lane above. */}
      <g opacity="0.35">
        <rect
          x="0"
          y="34"
          width="1920"
          height="20"
          fill="hsl(var(--lane-audio-bg))"
        />
        {audioSegs.flatMap((startX, i) => {
          const next = audioSegs[i + 1] ?? 1900;
          const segWidth = next - startX - 14;
          const bars = Math.floor(segWidth / 8);
          return Array.from({ length: bars }, (_, j) => {
            const h = 4 + ((j * 7) % 14); // pseudo-random bar height
            return (
              <rect
                key={`a-${i}-${j}`}
                x={startX + j * 8}
                y={44 - h / 2}
                width="3"
                height={h}
                fill="hsl(var(--lane-audio))"
                fillOpacity="0.75"
              />
            );
          });
        })}
      </g>
      {/* Captions lane */}
      <g opacity="0.4">
        <rect
          x="0"
          y="60"
          width="1920"
          height="20"
          fill="hsl(var(--lane-captions-bg))"
        />
        {captionSegs.map((x, i) => {
          const next = captionSegs[i + 1] ?? 1900;
          return (
            <rect
              key={`c-${i}`}
              x={x}
              y="62"
              width={next - x - 14}
              height="16"
              rx="2"
              fill="hsl(var(--lane-captions))"
              fillOpacity="0.45"
              stroke="hsl(var(--lane-captions))"
              strokeOpacity="0.75"
              strokeWidth="1"
            />
          );
        })}
      </g>
    </svg>
  );
}

function TimelineRuler({ className }: { className?: string }) {
  const ticks = Array.from({ length: 80 }, (_, i) => i);
  return (
    <svg
      viewBox="0 0 1920 24"
      preserveAspectRatio="none"
      className={className}
    >
      <line
        x1="0"
        y1="22"
        x2="1920"
        y2="22"
        stroke="currentColor"
        strokeWidth="1"
        strokeOpacity="0.6"
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
            y2={major ? 6 : 16}
            stroke="currentColor"
            strokeWidth="1"
            strokeOpacity={major ? "1" : "0.55"}
          />
        );
      })}
    </svg>
  );
}

function Waveform({ className }: { className?: string }) {
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
        strokeWidth="1.75"
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
