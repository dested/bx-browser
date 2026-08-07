import { useCopy } from "../lib/hooks";
import { REPO_URL } from "../lib/constants";

const INSTALL = `git clone ${REPO_URL} && cd claude-browser && bun install && bun link`;

const INSTALL_LINES = [
  `git clone ${REPO_URL}`,
  "cd claude-browser",
  "bun install",
  "bun link",
];

export function Hero() {
  const [copied, copy] = useCopy(INSTALL);

  return (
    <header className="relative overflow-hidden px-5 pt-16 pb-20 sm:px-8 sm:pt-24 md:pb-28">
      <div
        aria-hidden="true"
        className="grid-lines pointer-events-none absolute inset-0 opacity-[0.55] [mask-image:radial-gradient(ellipse_75%_55%_at_50%_0%,#000_20%,transparent_75%)]"
      />
      <div className="relative mx-auto w-full max-w-5xl">
        <div className="flex items-center gap-3">
          <span className="font-mono text-5xl leading-none font-bold tracking-tight text-acid sm:text-6xl">
            bx
          </span>
          <span className="bx-cursor translate-y-[2px]" aria-hidden="true" />
        </div>

        <h1 className="mt-8 max-w-3xl text-3xl leading-[1.15] font-semibold tracking-tight text-balance sm:text-4xl md:text-5xl">
          Browser automation for Claude Code — text-first, token-budgeted, and
          the cheap model drives.
        </h1>

        <p className="mt-6 max-w-2xl text-base leading-relaxed text-fog text-pretty sm:text-lg">
          A CLI over real Chrome that replaces the screenshot loop. The model
          reads a distilled element list instead of a 1,620-token image, issues
          one-line commands, and once a path works it becomes a typed flow file
          that never needs a model again.
        </p>

        <div className="mt-10 max-w-2xl">
          <div className="overflow-hidden rounded-lg border border-line bg-panel">
            <div className="flex items-center justify-between border-b border-line-soft px-4 py-2">
              <span className="font-mono text-[11px] tracking-[0.18em] text-fog-dim uppercase">
                install
              </span>
              <button
                type="button"
                onClick={copy}
                className="rounded border border-line px-2.5 py-1 font-mono text-[11px] text-fog transition-colors hover:border-acid/60 hover:text-acid"
              >
                {copied ? "copied" : "copy"}
              </button>
            </div>
            <pre className="overflow-x-auto px-4 py-4 font-mono text-[13px] leading-relaxed">
              <code>
                {INSTALL_LINES.map((line) => (
                  <span key={line} className="block whitespace-pre">
                    <span className="text-acid-deep select-none">$ </span>
                    <span className="text-chalk">{line}</span>
                  </span>
                ))}
              </code>
            </pre>
          </div>
          <p className="mt-3 font-mono text-xs text-fog-dim">
            Requires Chrome and Bun. <span className="text-fog">bun link</span> puts{" "}
            <span className="text-fog">bx</span> on your PATH.
          </p>
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <a
            href={REPO_URL}
            className="rounded-md border border-acid/40 bg-acid/10 px-4 py-2.5 font-mono text-sm text-acid transition-colors hover:bg-acid/20"
          >
            GitHub — dested/claude-browser
          </a>
          <a
            href="#race"
            className="rounded-md border border-line px-4 py-2.5 font-mono text-sm text-fog transition-colors hover:border-fog/50 hover:text-chalk"
          >
            Watch it beat the extension
          </a>
        </div>
      </div>
    </header>
  );
}
