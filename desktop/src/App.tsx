import { Hub } from "./components/Hub";
import { Workspace } from "./components/Workspace";
import { useGlobalKeys } from "./lib/keyboard";
import { useApp } from "./lib/store";

export function App() {
  const view = useApp((s) => s.view);
  const error = useApp((s) => s.error);
  const setError = useApp((s) => s.setError);

  useGlobalKeys();

  return (
    <div className="flex h-full w-full flex-col">
      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-danger/10 px-4 py-2 text-sm text-danger">
          <span className="font-medium">Error:</span>
          <span className="text-fg">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-auto text-fg-muted hover:text-fg"
          >
            dismiss
          </button>
        </div>
      )}
      {view === "hub" ? <Hub /> : <Workspace />}
    </div>
  );
}
