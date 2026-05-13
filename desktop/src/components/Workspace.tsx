// Project Workspace — SRS §8.5. Four regions: preview / inspector
// (top-right column), timeline (bottom), Claude rail (right edge), plus
// the top bar and status bar.
//
// P1.1 wires the static layout + reads the loaded project from the store.
// Interactions land incrementally in P1.4–P1.9.

import { useApp } from "../lib/store";
import { ClaudeRail } from "./ClaudeRail";
import { Inspector } from "./Inspector";
import { Preview } from "./Preview";
import { Timeline } from "./Timeline";
import { TopBar } from "./TopBar";
import { StatusBar } from "./StatusBar";

export function Workspace() {
  const project = useApp((s) => s.project);
  const railOpen = useApp((s) => s.claudeRailOpen);

  if (!project) return null;

  return (
    <div className="flex h-full w-full flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        {/* Left column: preview (top) + inspector (bottom).
            Preview takes more vertical room because the 9:16 frame is the
            common case and most of the height is "tall canvas" pillarboxed
            into the available width. Inspector stays scrollable so the
            accordion never runs off the screen. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-[2] border-b border-border-subtle">
            <Preview />
          </div>
          <div className="flex min-h-0 flex-1 overflow-y-auto">
            <Inspector />
          </div>
        </div>

        {/* Right column: Claude rail (collapsible). Width animates per §8.5.5. */}
        <aside
          className={
            railOpen
              ? "w-[340px] border-l border-border-subtle bg-bg-subtle transition-[width] duration-slow"
              : "w-[36px] border-l border-border-subtle bg-bg-subtle transition-[width] duration-slow"
          }
        >
          <ClaudeRail collapsed={!railOpen} />
        </aside>
      </div>

      {/* Bottom: timeline (full width) */}
      <div className="h-[160px] shrink-0 border-t border-border-subtle bg-bg-subtle">
        <Timeline />
      </div>

      <StatusBar />
    </div>
  );
}
