import type { ReactNode } from "react";
import { bx } from "../data/compare";
import type { TimelineEvent } from "../data/compare";
import { useReducedMotion } from "../lib/hooks";

/** The agent's own turns — the same captured run the race replays. */
const TURNS: TimelineEvent[] = bx.events.filter(
  (e) => e.kind === "say" || e.kind === "cmd" || e.kind === "out",
);

const SHAKEDOWN = [
  { task: "holidays count", turns: 11, wall: "26s", cost: "$0.025" },
  { task: "overview + all-tasks synthesis", turns: 37, wall: "75s", cost: "$0.061" },
  { task: "users + weekend schedule", turns: 18, wall: "23s", cost: "$0.034" },
  { task: "module types", turns: 11, wall: "16s", cost: "$0.028" },
  { task: "tags", turns: 13, wall: "20s", cost: "$0.029" },
  { task: "settings profile", turns: 13, wall: "12s", cost: "$0.028" },
  { task: "holidays + PTO", turns: 22, wall: "30s", cost: "$0.035" },
];

function TurnLine({ event }: { event: TimelineEvent }) {
  if (event.kind === "say") {
    return (
      <div className="truncate py-px text-fog-dim italic">
        <span className="select-none">› </span>
        {event.text}
      </div>
    );
  }
  if (event.kind === "cmd") {
    return (
      <div className="truncate py-px text-chalk">
        <span className="text-acid-deep select-none">$ </span>
        {event.text}
      </div>
    );
  }
  return <div className="truncate py-px text-fog">{event.text}</div>;
}

function Stage({
  n,
  label,
  children,
}: {
  n: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <p className="mb-3 font-mono text-[11px] tracking-[0.16em] text-fog-dim uppercase">
        <span className="text-acid">{n}</span> {label}
      </p>
      {children}
    </div>
  );
}

export function AgentMode() {
  const reduced = useReducedMotion();
  const preview = TURNS.slice(0, 8);

  return (
    <div>
      <div className="grid gap-8 lg:grid-cols-[1fr_1fr]">
        <Stage n="in" label="what you type">
          <pre className="rounded-lg border border-line bg-panel p-4 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap">
            <code>
              <span className="text-acid-deep select-none">$ </span>
              <span className="text-chalk">bx agent </span>
              <span className="text-acid">
                "log in as demo@taskbox.test, turn on dark mode in Settings, and
                verify it stuck"
              </span>
              <span className="text-chalk"> --save dark-mode</span>
            </code>
          </pre>
          <p className="mt-3 text-[13px] leading-relaxed text-fog">
            One instruction. No element refs, no coordinates, no screenshots on
            your side of the wire.
          </p>
        </Stage>

        <Stage n="during" label="what Haiku did (you never see this)">
          <div className="relative h-56 overflow-hidden rounded-lg border border-line bg-panel px-4 py-3 font-mono text-[11px] leading-[1.65]">
            {reduced ? (
              <div>
                {preview.map((event, i) => (
                  <TurnLine key={i} event={event} />
                ))}
                <div className="mt-2 text-fog-dim">…14 turns</div>
              </div>
            ) : (
              <div className="bx-marquee">
                {[0, 1].map((copy) => (
                  <div key={copy} aria-hidden={copy === 1}>
                    {TURNS.map((event, i) => (
                      <TurnLine key={`${copy}-${i}`} event={event} />
                    ))}
                  </div>
                ))}
              </div>
            )}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-panel to-transparent"
            />
          </div>
          <p className="mt-3">
            <span className="rounded border border-line px-2 py-1 font-mono text-[11px] text-fog">
              14 turns · 25.9s · stays on Haiku
            </span>
          </p>
        </Stage>
      </div>

      <div className="mt-10">
        <p className="mb-3 font-mono text-[11px] tracking-[0.16em] text-fog-dim uppercase">
          <span className="text-acid">out</span> what your context receives
        </p>
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <div className="min-w-0">
            <pre className="rounded-lg border border-line bg-panel p-4 font-mono text-[11.5px] leading-[1.75] whitespace-pre-wrap">
              <code>
                <span className="text-acid">PASS</span>
                <span className="text-chalk">
                  {" — Logged in, enabled dark mode in Settings, verified.\n"}
                </span>
                <span className="text-chalk">
                  {'Evidence: expect text "Dark mode on" ✓ · final url #/settings\n'}
                </span>
                <span className="text-fog">
                  {"tier=haiku turns=14 wall=25.9s tokens=31551/948 cost=$0.062"}
                </span>
              </code>
            </pre>
            <p className="mt-3 text-[13px] leading-relaxed text-fog">
              The report — roughly 300 tokens. The 14-turn transcript above never
              enters your session.
            </p>
          </div>

          <div className="min-w-0">
            <pre className="bx-scroll overflow-x-auto rounded-lg border border-line bg-panel p-4 font-mono text-[11.5px] leading-[1.75]">
              <code>
                <span className="text-chalk">import</span>
                {" { flow } "}
                <span className="text-chalk">from</span>{" "}
                <span className="text-acid">"bx/flow"</span>;{"\n\n"}
                <span className="text-chalk">export default</span>{" "}
                <span className="text-amber/80">flow</span>(
                <span className="text-acid">"dark-mode"</span>,{" "}
                <span className="text-chalk">async</span> (b) ={">"} {"{"}
                {"\n  "}
                <span className="text-chalk">await</span> b.
                <span className="text-amber/80">open</span>(
                <span className="text-acid">"http://127.0.0.1:8000/fixture"</span>);
                {"\n  "}
                <span className="text-chalk">await</span> b.
                <span className="text-amber/80">fill</span>(
                <span className="text-acid">"Email"</span>,{" "}
                <span className="text-acid">"demo@taskbox.test"</span>);{"\n  "}
                <span className="text-chalk">await</span> b.
                <span className="text-amber/80">fill</span>(
                <span className="text-acid">"Password"</span>,{" "}
                <span className="text-acid">""</span>);{"  "}
                <span className="text-fog-dim italic">
                  {"// redacted at record time"}
                </span>
                {"\n  "}
                <span className="text-chalk">await</span> b.
                <span className="text-amber/80">click</span>(
                <span className="text-acid">"Sign in"</span>);{"\n  "}
                <span className="text-chalk">await</span> b.
                <span className="text-amber/80">click</span>(
                <span className="text-acid">"Settings"</span>);{"\n  "}
                <span className="text-chalk">await</span> b.
                <span className="text-amber/80">click</span>(
                <span className="text-acid">"Dark mode"</span>);{"\n  "}
                <span className="text-chalk">await</span> b.
                <span className="text-amber/80">expectText</span>(
                <span className="text-acid">"Dark mode on"</span>);{"\n"}
                {"});"}
              </code>
            </pre>
            <p className="mt-3 text-[13px] leading-relaxed text-fog">
              Run it tomorrow:{" "}
              <span className="font-mono text-[0.92em] whitespace-nowrap text-chalk">
                bx run flows/dark-mode.flow.ts
              </span>{" "}
              — 1.2s, zero model tokens. The agent run is the authoring cost; every
              run after is free.
            </p>
          </div>
        </div>
      </div>

      <div className="mt-12 overflow-hidden rounded-lg border border-line">
        <p className="border-b border-line-soft bg-panel-2 px-4 py-3 font-mono text-[11px] tracking-[0.16em] text-fog-dim uppercase">
          measured on a real production app
        </p>
        <div className="bx-scroll overflow-x-auto">
          <table className="w-full min-w-[30rem] border-collapse text-left">
            <thead>
              <tr className="border-b border-line-soft">
                <th className="px-4 py-2.5 font-mono text-[11px] font-normal text-fog-dim">
                  task
                </th>
                <th className="px-4 py-2.5 text-right font-mono text-[11px] font-normal text-fog-dim">
                  turns
                </th>
                <th className="px-4 py-2.5 text-right font-mono text-[11px] font-normal text-fog-dim">
                  wall
                </th>
                <th className="px-4 py-2.5 text-right font-mono text-[11px] font-normal text-fog-dim">
                  cost
                </th>
              </tr>
            </thead>
            <tbody>
              {SHAKEDOWN.map((row) => (
                <tr key={row.task} className="border-b border-line-soft last:border-b-0">
                  <td className="px-4 py-2.5 text-[13px] text-chalk">{row.task}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-[12px] text-fog tabular-nums">
                    {row.turns}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-[12px] text-fog tabular-nums">
                    {row.wall}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-[12px] text-acid tabular-nums">
                    {row.cost}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line-soft px-4 py-3 text-[13px] leading-relaxed text-fog">
          7/7 correct, independently verified. 5 agents ran concurrently against
          one browser — each pinned to its own tab.
        </p>
      </div>

      <p className="mt-8 text-base leading-relaxed text-chalk">
        Your context pays for the verdict, not the drive.
      </p>
    </div>
  );
}
