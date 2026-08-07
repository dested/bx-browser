import { useEffect } from "react";
import { skillSource } from "../data/skill-source";

/**
 * The actual skill file, verbatim — the entire integration surface between
 * Claude Code and bx, viewable without leaving the page.
 */
export function SkillModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="skill/SKILL.md"
    >
      <div
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line-soft bg-panel-2 px-4 py-3">
          <span className="font-mono text-[12px] text-chalk">
            skill/SKILL.md
            <span className="ml-3 text-fog-dim">
              — the entire integration, verbatim
            </span>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-line px-2.5 py-1 font-mono text-[11px] text-fog transition-colors hover:border-acid/60 hover:text-acid"
          >
            close · esc
          </button>
        </div>
        <pre className="bx-scroll min-h-0 flex-1 overflow-auto px-5 py-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-fog">
          {skillSource}
        </pre>
      </div>
    </div>
  );
}
