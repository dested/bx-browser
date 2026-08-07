import type { ReactNode } from "react";
import { C } from "./Code";

type Stat = {
  value: string;
  unit?: string;
  label: string;
  detail: ReactNode;
  compare?: { value: string; label: string };
};

const STATS: Stat[] = [
  {
    value: "42",
    unit: "tokens",
    label: "One observation",
    detail: (
      <>
        <C>bx els</C> — the numbered element list the model actually acts on.
      </>
    ),
    compare: { value: "1,620", label: "one screenshot · 2,564 raw DOM dump" },
  },
  {
    value: "$0.037",
    label: "A delegated task",
    detail:
      "Haiku drives end to end. Across seven real tasks on a production app: $0.025–$0.061, 12–75s, 7/7 correct.",
  },
  {
    value: "1.2s",
    unit: "· 0 tokens",
    label: "A saved flow, replayed",
    detail: (
      <>
        Typed TypeScript, checked by <C>tsc</C>, in version control. Re-running
        costs no model at all.
      </>
    ),
  },
  {
    value: "730ms",
    label: "Cold start",
    detail: (
      <>
        Daemon up and Chrome attached. An <C>els</C> scan is 2.3ms, a click 187ms
        after that.
      </>
    ),
  },
];

const FACTS = [
  "4× more interactive elements surfaced than the extension's tools",
  "~18× more page text per read",
  "5 agents driving one browser concurrently",
];

export function Numbers() {
  return (
    <div>
      <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2">
        {STATS.map((stat) => (
          <div key={stat.label} className="bg-panel p-6 md:p-7">
            <p className="font-mono text-[11px] tracking-[0.16em] text-fog-dim uppercase">
              {stat.label}
            </p>
            <p className="mt-3 flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-4xl font-semibold tracking-tight text-acid tabular-nums md:text-5xl">
                {stat.value}
              </span>
              {stat.unit && (
                <span className="font-mono text-sm text-fog">{stat.unit}</span>
              )}
            </p>
            {stat.compare && (
              <p className="mt-2 font-mono text-sm text-fog">
                vs{" "}
                <span className="text-flare line-through decoration-flare/40">
                  {stat.compare.value}
                </span>{" "}
                <span className="text-fog-dim">{stat.compare.label}</span>
              </p>
            )}
            <p className="mt-4 text-sm leading-relaxed text-fog">{stat.detail}</p>
          </div>
        ))}
      </div>

      <ul className="mt-6 grid gap-2 sm:grid-cols-3">
        {FACTS.map((fact) => (
          <li
            key={fact}
            className="rounded-md border border-line-soft px-4 py-3 text-[13px] leading-snug text-fog-dim"
          >
            {fact}
          </li>
        ))}
      </ul>
    </div>
  );
}
