import type { ReactNode } from "react";
import { C } from "./Code";

type Step = { n: string; title: string; body: ReactNode; data?: ReactNode };

const STEPS: Step[] = [
  {
    n: "1",
    title: "Read the live state",
    body: (
      <>
        Grouped <C>runner.getInstances()</C> by <C>defId</C>.
      </>
    ),
    data: `[["def_olf3g1x2", 1], ["def_oqkglpag", 5], ["def_os8y9zob", 3]]`,
  },
  {
    n: "2",
    title: "Inferred the roles from counts",
    body: (
      <>
        1-of = the hero, 5-of = flowers to collect, 3-of = bees to avoid. No
        pixels involved.
      </>
    ),
  },
  {
    n: "3",
    title: "Authored a controller and injected it",
    body: (
      <>
        Set <C>window.__play.override</C> to a per-frame function: steer to the
        nearest flower, add a repulsion vector from any bee within 200px.
      </>
    ),
  },
  {
    n: "4",
    title: "Polled the win signal",
    body: (
      <>
        <C>runner.status</C> went <C>playing</C> → <C>won</C> in ~4 seconds of
        play.
      </>
    ),
  },
];

const CONTRAST: { title: string; body: string }[] = [
  {
    title: "The honest way failed",
    body:
      "A control run played by the rules a screenshot agent must: read state, decide, press an arrow key, repeat. It reached the game, steered — and ran out of budget mid-game without winning ($0.21, 223 turns). Turn-based play cannot keep 60fps pace. No model fixes that; the loop is the wall.",
  },
  {
    title: "The pattern is the win",
    body:
      "Read state programmatically, inject a controller through the app's own per-frame hook, poll a deterministic win signal. Ground-truthed across three genres: the mechanism drove every game frame-perfectly. Winning still takes a per-game controller — a flight game whose lift is a button is unwinnable by joystick axes alone.",
  },
];

function Label({ children }: { children: ReactNode }) {
  return (
    <p className="mb-3 font-mono text-[11px] tracking-[0.16em] text-fog-dim uppercase">
      {children}
    </p>
  );
}

export function GameWin() {
  return (
    <div>
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <Label>
            <span className="text-acid">the run</span>
          </Label>
          <pre className="bx-scroll overflow-x-auto rounded-lg border border-line bg-panel p-4 font-mono text-[12px] leading-relaxed">
            <code>
              <span className="text-acid-deep select-none">$ </span>
              <span className="text-chalk">bx agent </span>
              <span className="text-acid">"win Bee Dodge"</span>
              <span className="text-chalk">{" \\\n    --url "}</span>
              <span className="text-acid">http://localhost:5183</span>
              <span className="text-chalk">{" \\\n    --enter "}</span>
              <span className="text-acid">
                {
                  "\"window.__studio.getState().openProject('proj_oo07cige');\n             window.__studio.getState().setPlaying(true)\""
                }
              </span>
              <span className="text-chalk">{" \\\n    --win "}</span>
              <span className="text-acid">
                {"\"window.__play.runner.status === 'won'\""}
              </span>
              <span className="text-chalk">{" \\\n    --budget 0.30"}</span>
            </code>
          </pre>
          <p className="mt-3 text-[13px] leading-relaxed text-fog">
            <C>--enter</C> kills the discovery tax: the same task without it
            burned its whole budget just finding how to open the game. <C>--win</C>{" "}
            is verified by the driver before a pass is accepted.
          </p>
        </div>

        <div className="min-w-0">
          <Label>
            <span className="text-acid">what the agent did</span>
          </Label>
          <ol className="grid gap-px overflow-hidden rounded-lg border border-line bg-line">
            {STEPS.map((step) => (
              <li key={step.n} className="flex gap-4 bg-panel p-4 md:p-5">
                <span className="font-mono text-[13px] text-acid tabular-nums">
                  {step.n}
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-chalk">
                    {step.title}
                  </h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-fog">
                    {step.body}
                  </p>
                  {step.data && (
                    <p className="bx-scroll mt-2 overflow-x-auto font-mono text-[11.5px] leading-relaxed whitespace-pre text-fog-dim">
                      {step.data}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <pre className="mt-8 rounded-lg border border-line bg-panel p-4 font-mono text-[11.5px] leading-[1.75] whitespace-pre-wrap">
        <code>
          <span className="text-acid">✓ PASS</span>
          <span className="text-chalk">
            {" — won Bee Dodge: 5/5 flowers, 0 hearts lost\n"}
          </span>
          <span className="text-fog">
            {"tier=sonnet turns=72 wall=134s cost=$0.16"}
          </span>
        </code>
      </pre>

      <ul className="mt-10 grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-2">
        {CONTRAST.map((card) => (
          <li key={card.title} className="bg-panel p-6 md:p-7">
            <h3 className="text-base font-semibold text-chalk">{card.title}</h3>
            <p className="mt-3 text-sm leading-relaxed text-fog">{card.body}</p>
          </li>
        ))}
      </ul>

      <div className="mt-10">
        <Label>
          <span className="text-acid">then make it a regression test</span>
        </Label>
        <pre className="bx-scroll overflow-x-auto rounded-lg border border-line bg-panel p-4 font-mono text-[12px] leading-relaxed">
          <code>
            <span className="text-acid-deep select-none">$ </span>
            <span className="text-chalk">bx drive --install </span>
            <span className="text-acid">
              {
                '"window.__play.override = (r, gi) => { /* seek goal, avoid hazards */ }"'
              }
            </span>
            <span className="text-chalk">{" \\\n           --until "}</span>
            <span className="text-acid">
              {"\"window.__play.runner.status === 'won'\""}
            </span>
            <span className="text-chalk">{" --timeout 15000\n"}</span>
            <span className="text-acid">{"✓ satisfied"}</span>
            <span className="text-fog">{" after 4.1s (9 polls)"}</span>
          </code>
        </pre>
        <p className="mt-3 text-[13px] leading-relaxed text-fog">
          <C>bx drive</C> installs the controller and polls the predicate
          entirely in-page — zero model tokens during play. It synthesizes into a
          flow: "level 3 still winnable" is now part of the test suite.
        </p>
      </div>

      <p className="mt-8 text-base leading-relaxed text-chalk">
        Where bx wins, honestly: apps that expose state and hooks — your own
        instrumented app. On an opaque third-party canvas, a vision agent sees
        pixels and bx does not.
      </p>
    </div>
  );
}
