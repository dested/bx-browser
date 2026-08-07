import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";

type Os = "unix" | "windows";

const OsContext = createContext<{ os: Os; setOs: (os: Os) => void } | null>(null);

function detectOs(): Os {
  if (typeof navigator !== "undefined" && /Win/.test(navigator.userAgent)) {
    return "windows";
  }
  return "unix";
}

export function OsProvider({ children }: { children: ReactNode }) {
  const [os, setOs] = useState<Os>(detectOs);
  return <OsContext.Provider value={{ os, setOs }}>{children}</OsContext.Provider>;
}

export function useOs() {
  const ctx = useContext(OsContext);
  if (!ctx) throw new Error("useOs outside OsProvider");
  return ctx;
}

/** The skill's install path, rendered in the reader's own OS dialect. */
export function skillPath(os: Os): string {
  return os === "windows"
    ? "%USERPROFILE%\\.claude\\skills\\bx"
    : "~/.claude/skills/bx";
}

export function OsToggle({ className = "" }: { className?: string }) {
  const { os, setOs } = useOs();
  return (
    <div
      className={`flex overflow-hidden rounded border border-line font-mono text-[11px] ${className}`}
      role="group"
      aria-label="Operating system"
    >
      {(
        [
          ["unix", "macos / linux"],
          ["windows", "windows"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={os === value}
          onClick={() => setOs(value)}
          className={`px-2.5 py-1 transition-colors ${
            os === value ? "bg-panel-2 text-chalk" : "text-fog-dim hover:text-fog"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
