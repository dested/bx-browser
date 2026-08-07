import { useCopy } from "../lib/hooks";
import { OsToggle, skillPath, useOs } from "../lib/os";
import { REPO_URL } from "../lib/constants";

const INSTALL_LINES = ["bun add -g bx-browser", "bx install-skill"];
const INSTALL = INSTALL_LINES.join(" && ");

export function Hero() {
  const [copied, copy] = useCopy(INSTALL);
  const { os } = useOs();

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
          Claude in Chrome burns tokens, minutes, and sometimes the task.
          <span className="text-acid"> bx replaces it.</span>
        </h1>

        <p className="mt-6 max-w-2xl text-base leading-relaxed text-fog text-pretty sm:text-lg">
          The screenshot loop sends your frontier model a ~1,600-token image to
          find one button, round-trips every click through it, and still loses
          the thread. bx is a CLI over real Chrome built for exactly one user:
          a coding agent. Distilled text instead of pixels, hard budgets at the
          source, a cheap model doing the driving — and a path that works
          becomes a typed flow that never needs a model again.
        </p>

        <div className="mt-10 max-w-2xl">
          <div className="overflow-hidden rounded-lg border border-line bg-panel">
            <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2">
              <span className="font-mono text-[11px] tracking-[0.18em] text-fog-dim uppercase">
                install
              </span>
              <div className="flex items-center gap-2">
                <OsToggle />
                <button
                  type="button"
                  onClick={copy}
                  className="rounded border border-line px-2.5 py-1 font-mono text-[11px] text-fog transition-colors hover:border-acid/60 hover:text-acid"
                >
                  {copied ? "copied" : "copy"}
                </button>
              </div>
            </div>
            <pre className="bx-scroll overflow-x-auto px-4 py-4 font-mono text-[13px] leading-relaxed">
              <code>
                {INSTALL_LINES.map((line) => (
                  <span key={line} className="block whitespace-pre">
                    <span className="text-acid-deep select-none">
                      {os === "windows" ? "> " : "$ "}
                    </span>
                    <span className="text-chalk">{line}</span>
                  </span>
                ))}
              </code>
            </pre>
          </div>
          <p className="mt-3 font-mono text-xs leading-relaxed text-fog-dim">
            Same two lines on macOS, Linux, and Windows. Requires Bun and
            Chrome. The second line drops the Claude Code skill into{" "}
            <span className="text-fog">{skillPath(os)}</span> — then tell Claude
            Code:{" "}
            <span className="text-acid">&ldquo;use bx to verify your changes.&rdquo;</span>
          </p>
        </div>

        <div className="mt-6 max-w-2xl rounded-lg border border-acid/25 bg-acid/[0.06] px-4 py-3">
          <p className="text-sm leading-relaxed text-fog">
            <span className="font-semibold text-chalk">
              Runs on your Claude Code subscription.
            </span>{" "}
            Delegated drives go through the Agent SDK with the same auth Claude
            Code itself uses — Haiku by default, escalating to Sonnet, Opus if
            you allow it. Signed in with a Max plan, that's your subscription:
            no API key, no separate bill. What it saves you is time, context,
            and wasted runs.
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-fog-dim">
            One honest caveat: if <span className="font-mono">ANTHROPIC_API_KEY</span>{" "}
            is set in your environment, Claude Code — and therefore bx — bills
            the API instead. That's how Claude Code's auth resolution works,
            not a bx decision; unset the variable and you're back on the
            subscription.
          </p>
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <a
            href="#claude-code"
            className="rounded-md border border-acid/40 bg-acid/10 px-4 py-2.5 font-mono text-sm text-acid transition-colors hover:bg-acid/20"
          >
            How you use it
          </a>
          <a
            href="#race"
            className="rounded-md border border-line px-4 py-2.5 font-mono text-sm text-fog transition-colors hover:border-fog/50 hover:text-chalk"
          >
            Watch it beat the extension
          </a>
          <a
            href={REPO_URL}
            className="rounded-md border border-line px-4 py-2.5 font-mono text-sm text-fog transition-colors hover:border-fog/50 hover:text-chalk"
          >
            GitHub
          </a>
        </div>
      </div>
    </header>
  );
}
