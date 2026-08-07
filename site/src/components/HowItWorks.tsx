import type { ReactNode } from "react";
import { C } from "./Code";

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
    label: "real-time mode",
    title: "For 60fps canvases, the model ships code into the page",
    body: (
      <>
        A read→decide→click loop is seconds per decision; a game runs at 60fps.
        So <C>bx drive</C> installs an agent-authored controller that runs
        inside the page every frame, while the daemon polls a win condition —
        zero model tokens while it plays. Games, drag physics, anything the DOM
        can't describe.
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

    </div>
  );
}
