import type { ReactNode } from "react";
import { C } from "./Code";
import { REPO_URL } from "../lib/constants";

const COLUMNS: { n: string; title: string; body: ReactNode }[] = [
  {
    n: "01",
    title: "A daemon holds your real Chrome",
    body: (
      <>
        One background process per profile owns a real Chrome instance over
        playwright-core — persistent user-data-dirs, so you sign in by hand once
        and the session survives every run. The CLI talks to it over localhost
        HTTP. Nothing is a bundled headless browser unless you ask for one.
      </>
    ),
  },
  {
    n: "02",
    title: "Verbs act on distilled text",
    body: (
      <>
        <C>open</C>, <C>els</C>, <C>click</C>, <C>fill</C>, <C>expect</C>,{" "}
        <C>console</C>, <C>net</C>. Every read is budgeted at the source — the
        element list caps around 800 tokens, page text at 2,000, console and
        network at 30 entries — so output can never blow up a context window, and
        the model never has to ration a look at the page.
      </>
    ),
  },
  {
    n: "03",
    title: "Flows replay for free",
    body: (
      <>
        A path that works becomes a typed TypeScript file. <C>tsc</C> checks it,
        git versions it, and re-running it costs zero model tokens — which makes
        the same artifact a regression test you can drop into CI or a pre-push
        hook.
      </>
    ),
  },
];

const EXTRAS: { label: string; title: string; body: ReactNode }[] = [
  {
    label: "agent mode",
    title: "The cheap model does the clicking",
    body: (
      <>
        <C>bx agent</C> takes a natural-language task, runs it on Haiku through
        the same verbs, and escalates once to Sonnet if the first attempt fails.
        What comes back to your main session is a ~300-token report — pass/fail, a
        summary, evidence lines, turns and usage — not a transcript. Add{" "}
        <C>--save</C> and the actions taken are synthesized into a flow file with
        replay-stable targets.
      </>
    ),
  },
  {
    label: "recordings",
    title: "Video becomes something a model can read",
    body: (
      <>
        <C>bx record start</C> captures Chrome's own video, then distills it into
        deduped keyframes, 3×3 contact sheets, and a <C>report.md</C>. There is no
        audio track, so bx's own action log — clicked Save changes, filled Email —
        becomes the timed transcript, and the report reads as a narrated
        walkthrough.
      </>
    ),
  },
];

export function HowItWorks() {
  return (
    <div>
      <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-3">
        {COLUMNS.map((col) => (
          <div key={col.n} className="bg-panel p-6 md:p-7">
            <p className="font-mono text-xs text-acid">{col.n}</p>
            <h3 className="mt-3 text-base font-semibold text-chalk">{col.title}</h3>
            <p className="mt-3 text-sm leading-relaxed text-fog">{col.body}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {EXTRAS.map((extra) => (
          <div key={extra.label} className="rounded-lg border border-line bg-panel p-6 md:p-7">
            <p className="font-mono text-[11px] tracking-[0.16em] text-fog-dim uppercase">
              {extra.label}
            </p>
            <h3 className="mt-3 text-base font-semibold text-chalk">{extra.title}</h3>
            <p className="mt-3 text-sm leading-relaxed text-fog">{extra.body}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-lg border border-line bg-panel p-6 md:p-7">
        <p className="font-mono text-[11px] tracking-[0.16em] text-fog-dim uppercase">
          the whole prompt surface
        </p>
        <h3 className="mt-3 text-base font-semibold text-chalk">
          The model learns all of this from one file
        </h3>
        <p className="mt-3 max-w-4xl text-sm leading-relaxed text-fog">
          Everything above is taught by a single ~130-line skill file —{" "}
          <a
            href={`${REPO_URL}/blob/main/skill/SKILL.md`}
            className="font-mono text-[0.92em] whitespace-nowrap text-acid underline decoration-acid/30 underline-offset-2 hover:decoration-acid"
          >
            skill/SKILL.md
          </a>{" "}
          — and it is loaded only when a browser task actually shows up. Compare
          that to ~24 MCP tool schemas sitting resident in every context you ever
          open, whether or not the browser is ever touched.
        </p>
      </div>
    </div>
  );
}
