import { useState } from "react";
import type { ReactNode } from "react";
import { C } from "./Code";
import { SkillModal } from "./SkillModal";
import { skillPath, useOs } from "../lib/os";

type Example = {
  prompt: string;
  commands: string[];
  outcome: ReactNode;
};

const EXAMPLES: Example[] = [
  {
    prompt: "Use bx to verify your changes.",
    commands: [
      "bx open https://myapp.localhost",
      'bx expect text "Saved"',
      "bx console",
      "bx net --failed",
    ],
    outcome: (
      <>
        The default verification trio: an assertion, console errors, failed
        requests. <C>expect</C> exits 1 on failure — the agent gets a hard
        signal, not a screenshot to squint at.
      </>
    ),
  },
  {
    prompt: "Test the login flow with bx and keep it as a regression.",
    commands: [
      'bx agent "log in as demo@taskbox.test',
      '  and verify the task list loads" \\',
      "  --save login",
    ],
    outcome: (
      <>
        Haiku drives on your Claude Code subscription — escalating to Sonnet
        (and Opus, if you allow it) only when it has to. Your session gets a
        ~300-token report, and <C>flows/login.flow.ts</C> replays forever at
        zero model tokens.
      </>
    ),
  },
  {
    prompt: "Fill out the signup form and tell me what the error toast says.",
    commands: [
      "bx els --filter signup",
      'bx fill "Email" "qa@test.dev"',
      'bx click "Create account"',
      'bx text ".toast"',
    ],
    outcome: (
      <>
        Hand-driving, for when each intermediate state matters. Targets are
        text or selectors, every read is budgeted, and nothing here costs an
        image.
      </>
    ),
  },
  {
    prompt: "Record a walkthrough of the checkout bug for the PR.",
    commands: [
      "bx record start checkout-bug",
      "bx run flows/checkout.flow.ts --record",
      "bx record stop",
    ],
    outcome: (
      <>
        Produces <C>recordings/checkout-bug/report.md</C> — deduped keyframes,
        contact sheets, narrated by bx's own action log. Drop it straight into
        the PR.
      </>
    ),
  },
];

export function ClaudeCode() {
  const [showSkill, setShowSkill] = useState(false);
  const { os } = useOs();

  return (
    <div>
      <div className="grid gap-4 md:grid-cols-2">
        {EXAMPLES.map((ex) => (
          <div
            key={ex.prompt}
            className="flex flex-col overflow-hidden rounded-lg border border-line bg-panel"
          >
            <div className="border-b border-line-soft px-5 py-4 sm:px-6">
              <p className="font-mono text-[11px] tracking-[0.16em] text-fog-dim uppercase">
                you say
              </p>
              <p className="mt-2 text-[15px] leading-snug font-medium text-chalk">
                &ldquo;{ex.prompt}&rdquo;
              </p>
            </div>
            <div className="flex-1 px-5 py-4 sm:px-6">
              <p className="font-mono text-[11px] tracking-[0.16em] text-acid uppercase">
                claude code runs
              </p>
              <pre className="bx-scroll mt-3 overflow-x-auto font-mono text-[12.5px] leading-relaxed">
                <code>
                  {ex.commands.map((line, i) => (
                    <span key={i} className="block whitespace-pre">
                      {line.startsWith(" ") ? (
                        <span className="select-none">{"  "}</span>
                      ) : (
                        <span className="text-acid-deep select-none">$ </span>
                      )}
                      <span className="text-chalk">{line.trimStart()}</span>
                    </span>
                  ))}
                </code>
              </pre>
            </div>
            <p className="border-t border-line-soft px-5 py-4 text-[13px] leading-relaxed text-fog sm:px-6">
              {ex.outcome}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-lg border border-line bg-panel p-6 md:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-3xl">
            <p className="font-mono text-[11px] tracking-[0.16em] text-fog-dim uppercase">
              the entire integration
            </p>
            <h3 className="mt-3 text-base font-semibold text-chalk">
              One markdown file teaches Claude Code all of it
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-fog">
              <C>bx install-skill</C> writes a ~130-line skill file to{" "}
              <C>{skillPath(os)}</C>. It covers every verb and, more
              importantly, when to reach for them: "verify in the browser",
              "check the console", "test the game", any local dev URL. It loads
              only when a browser task actually shows up — compare that to ~24
              MCP tool schemas sitting resident in every context you ever open,
              whether or not the browser is touched.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowSkill(true)}
            className="shrink-0 rounded-md border border-acid/40 bg-acid/10 px-4 py-2.5 font-mono text-sm text-acid transition-colors hover:bg-acid/20"
          >
            read the skill — right here
          </button>
        </div>
      </div>

      {showSkill && <SkillModal onClose={() => setShowSkill(false)} />}
    </div>
  );
}
