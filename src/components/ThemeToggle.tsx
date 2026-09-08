// Theme toggle — three-state segmented control: System / Light / Dark.
//
// Lives in the TopBar between the templates chip and the source
// button. Compact (matches the surrounding icon buttons) but
// labeled — the user shouldn't have to mouse over to learn what a
// sun-icon does. The active segment uses the accent background so
// the current choice reads at a glance.
//
// Choice persists to localStorage via theme.ts. "System" is the
// default and reactive — flipping the OS theme while in system mode
// flips the app theme without the user touching this control.

import { Laptop, Moon, Sun } from "lucide-react";
import { useTheme, type ThemeChoice } from "../lib/theme";
import { cn } from "../lib/cn";

const OPTIONS: { value: ThemeChoice; label: string; icon: typeof Sun; hint: string }[] = [
  {
    value: "system",
    label: "System",
    icon: Laptop,
    hint: "Follow the OS preference. Flips automatically when you switch your system theme.",
  },
  {
    value: "light",
    label: "Light",
    icon: Sun,
    hint: "Soft warm-white surfaces. Good for daytime / well-lit rooms.",
  },
  {
    value: "dark",
    label: "Dark",
    icon: Moon,
    hint: "Deep neutrals with a single cyan accent. The original Clipwright look.",
  },
];

export function ThemeToggle() {
  const { choice, setChoice } = useTheme();
  return (
    <div
      role="group"
      aria-label="Theme"
      className="flex items-center rounded border border-border-subtle bg-bg-inset p-0.5"
    >
      {OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const active = choice === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => setChoice(opt.value)}
            title={opt.hint}
            aria-pressed={active}
            aria-label={`Theme: ${opt.label}`}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded transition-colors",
              active
                ? "bg-accent text-bg shadow-sm"
                : "text-fg-muted hover:bg-bg-raised hover:text-fg",
            )}
          >
            <Icon size={12} strokeWidth={2} />
          </button>
        );
      })}
    </div>
  );
}
