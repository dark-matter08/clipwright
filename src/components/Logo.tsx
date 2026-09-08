// The Clipwright mark, as SVG.
//
// Same geometry as the app icon (`src-tauri/icons/logo.py`) minus the
// squircle plate, so the two read as one brand. Kept in sync by hand —
// it's a dozen numbers, and generating TSX from the Python would be a
// build step to maintain for no gain.
//
// Colors come from the design tokens rather than being baked in: the
// clips use `currentColor` at low opacity so the mark inherits whatever
// text color it sits next to, and only the selected clip and playhead
// take the accent. That means it works on any surface, in either theme,
// without a second asset.

export function Logo({
  size = 20,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      role="img"
      aria-label="Clipwright"
      className={className}
    >
      {/* Three clips on three lanes, unequal widths. */}
      <rect x="8" y="24" width="43" height="14" rx="3" fill="currentColor" opacity="0.32" />
      <rect x="8" y="43" width="69" height="14" rx="3" fill="hsl(var(--accent))" />
      <rect x="8" y="62" width="33" height="14" rx="3" fill="currentColor" opacity="0.32" />

      {/* Playhead, crossing every lane. The dark casing from the icon is
       *  dropped here — on an arbitrary background there's no single
       *  correct color to knock out with, so the head reads on its own. */}
      <path
        d="M53 12 L67 12 L60 22 Z"
        fill="hsl(var(--accent))"
      />
      <rect x="58.5" y="18" width="3" height="66" rx="1.5" fill="hsl(var(--accent))" />
    </svg>
  );
}
