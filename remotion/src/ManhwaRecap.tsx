// Top-level composition for the manhwa-recap-single (and -multi, later)
// templates. Renders a series of panel segments back-to-back with a
// theme-driven background; chapter chips overlay per-segment via
// ChapterChip; each segment carries its own Ken Burns motion and audio.
//
// Distinct from `ClipwrightVideo` (legacy recording-based composition)
// because the manhwa workflow has no shared source video — each segment
// is a different still image. Both compositions live side-by-side in
// Root.tsx and the Python backend picks the right one by template_id.

import React from "react";
import { AbsoluteFill, Series } from "remotion";
import { PanelSegment } from "./PanelSegment";
import type { ManhwaInputs } from "./schema";
import { getTheme } from "./themes";

export const ManhwaRecap: React.FC<ManhwaInputs> = ({
  fps,
  segments,
  theme: themeName,
  show_chapter_chips,
}) => {
  const theme = getTheme(themeName);
  return (
    <AbsoluteFill style={{ backgroundColor: theme.background }}>
      <Series>
        {segments.map((seg) => {
          const frames = Math.max(1, Math.round(seg.duration * fps));
          return (
            <Series.Sequence key={seg.id} durationInFrames={frames}>
              <PanelSegment
                source={seg.source}
                durationSeconds={seg.duration}
                audioPath={seg.audio_path}
                camera={seg.camera}
                captions={seg.captions}
                chapter={seg.chapter}
                theme={theme}
                showChip={show_chapter_chips && Boolean(seg.chapter)}
              />
            </Series.Sequence>
          );
        })}
      </Series>
    </AbsoluteFill>
  );
};
