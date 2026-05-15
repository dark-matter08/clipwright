// Global keyboard shortcut map — SRS §8.6.
//
// Each binding is `(key, modifiers) -> action`. Modifiers use the
// Mac-style `meta`; Ctrl on Linux/Windows is treated the same so the
// shortcuts feel native everywhere.

import { useEffect } from "react";
import { useApp } from "./store";

type Modifier = "meta" | "shift";

interface Binding {
  key: string;          // case-insensitive match against `event.key`
  modifiers?: Modifier[]; // required modifiers (any others must be absent)
  when?: () => boolean;
  action: () => void | Promise<void>;
}

function eventModifiers(e: KeyboardEvent): Set<Modifier> {
  const out = new Set<Modifier>();
  if (e.metaKey || e.ctrlKey) out.add("meta");
  if (e.shiftKey) out.add("shift");
  return out;
}

function matches(e: KeyboardEvent, b: Binding): boolean {
  if (e.key.toLowerCase() !== b.key.toLowerCase()) return false;
  const required = new Set(b.modifiers ?? []);
  const present = eventModifiers(e);
  // every required mod present + no extra mods
  if (required.size !== present.size) return false;
  for (const m of required) if (!present.has(m)) return false;
  return true;
}

/** Returns true if the keyboard event originated inside a text input. We
 *  don't intercept shortcuts there so the user can type normally. */
function isInTextField(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

export function useGlobalKeys(): void {
  const store = useApp();

  useEffect(() => {
    const bindings: Binding[] = [
      // Hub ↔ Workspace navigation
      { key: "Escape", when: () => !!store.error, action: () => store.setError(null) },

      // Claude rail
      { key: "\\", modifiers: ["meta"], action: store.toggleClaudeRail },

      // Segment navigation
      { key: "ArrowLeft",  when: workspaceOpen, action: () => store.selectRelative(-1) },
      { key: "ArrowRight", when: workspaceOpen, action: () => store.selectRelative(+1) },

      // Mutations
      {
        key: "b", modifiers: ["meta"],
        when: workspaceOpen,
        action: () => store.splitSelected(),
      },
      {
        key: "d", modifiers: ["meta"],
        when: workspaceOpen,
        action: () => store.duplicateSelected(),
      },
      {
        key: "Backspace", when: workspaceOpen,
        action: async () => {
          // Per F-TL-4, confirm only when undo isn't available. Otherwise
          // the user has a backstop and the friction isn't worth it.
          if (!store.canUndo()) {
            const ok = window.confirm(
              "Delete this segment? Undo is unavailable for this action.",
            );
            if (!ok) return;
          }
          await store.deleteSelected();
        },
      },

      // Reorder
      {
        key: "ArrowLeft", modifiers: ["meta"],
        when: workspaceOpen,
        action: () => store.moveSelected("prev"),
      },
      {
        key: "ArrowRight", modifiers: ["meta"],
        when: workspaceOpen,
        action: () => store.moveSelected("next"),
      },

      // History
      { key: "z", modifiers: ["meta"], when: workspaceOpen, action: () => store.undo() },
      {
        key: "z", modifiers: ["meta", "shift"],
        when: workspaceOpen,
        action: () => store.redo(),
      },

      // Zoom
      { key: "=", modifiers: ["meta"], when: workspaceOpen, action: store.zoomIn },
      { key: "+", modifiers: ["meta"], when: workspaceOpen, action: store.zoomIn },
      { key: "-", modifiers: ["meta"], when: workspaceOpen, action: store.zoomOut },
      { key: "0", modifiers: ["meta"], when: workspaceOpen, action: store.zoomReset },

      // Playback transport — Space toggles play/pause on whichever
      // video the Preview pane is currently showing. CapCut-style.
      {
        key: " ",
        when: workspaceOpen,
        action: () => {
          const s = useApp.getState();
          s.requestPlayPause(!s.playbackPlaying);
        },
      },

      // Inspector — Enter on a selected segment opens the drawer.
      // Plain Enter so it doesn't fight with shortcut conventions;
      // text-field guard prevents interference while typing.
      {
        key: "Enter",
        when: () => {
          const s = useApp.getState();
          return s.view === "workspace" && s.selectedSegmentId != null;
        },
        action: () => useApp.getState().setInspectorOpen(true),
      },
    ];

    function onKey(e: KeyboardEvent) {
      if (isInTextField(e)) return;
      for (const b of bindings) {
        if (!matches(e, b)) continue;
        if (b.when && !b.when()) continue;
        e.preventDefault();
        void b.action();
        return;
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);
}

function workspaceOpen(): boolean {
  return useApp.getState().view === "workspace" && useApp.getState().project != null;
}
