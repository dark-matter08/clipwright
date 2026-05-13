// Project Workspace — SRS §8.5. Five regions:
//   left rail: Videos sidebar (NEW for v2 — switch between videos in
//   one project), then the four-region editor (preview + inspector +
//   timeline + Claude rail) + status bar.

import { useState } from "react";
import { useApp } from "../lib/store";
import { ClaudeRail } from "./ClaudeRail";
import { Inspector } from "./Inspector";
import { Preview } from "./Preview";
import { Timeline } from "./Timeline";
import { TopBar } from "./TopBar";
import { StatusBar } from "./StatusBar";
import { VideoSidebar } from "./VideoSidebar";

export function Workspace() {
  const project = useApp((s) => s.project);
  const railOpen = useApp((s) => s.claudeRailOpen);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  if (!project) return null;

  return (
    <div className="flex h-full w-full flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        {/* Far-left: Videos rail */}
        <div
          className={
            sidebarCollapsed
              ? "w-[44px] shrink-0 transition-[width] duration-slow"
              : "w-[200px] shrink-0 transition-[width] duration-slow"
          }
        >
          <VideoSidebar
            collapsed={sidebarCollapsed}
            onToggle={() => setSidebarCollapsed((v) => !v)}
          />
        </div>

        {/* Middle: preview (top) + inspector (bottom). */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-[2] border-b border-border-subtle">
            <Preview />
          </div>
          <div className="flex min-h-0 flex-1 overflow-y-auto">
            <Inspector />
          </div>
        </div>

        {/* Right: Claude rail. */}
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

      {/* Bottom: timeline full width. */}
      <div className="h-[160px] shrink-0 border-t border-border-subtle bg-bg-subtle">
        <Timeline />
      </div>

      <StatusBar />
    </div>
  );
}
