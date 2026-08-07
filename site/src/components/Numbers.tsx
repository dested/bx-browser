import type { ReactNode } from "react";
import { C } from "./Code";

type Bar = {
  name: string;
  value: number;
  display: string;
  tone: "acid" | "flare" | "fog";
  tag?: { text: string; tone: "acid" | "flare" };
};

type Chart = {
  title: string;
  unit: string;
  bars: Bar[];
  note: ReactNode;
};

/**
 * All values are real captured output (bench + race transcripts in the repo).
 * Bars are true-to-scale within a chart; a 3px floor keeps slivers visible.
 */
const CHARTS: Chart[] = [
  {
    title: "Same task, one clock",
    unit: "seconds to a verified result",
    bars: [
      {
        name: "Claude in Chrome",
        value: 193.5,
        display: "3.2 min",
        tone: "flare",
        tag: { text: "FAILED", tone: "flare" },
      },
      {
        name: "bx agent",
        value: 29.2,
        display: "25.9s",
        tone: "acid",
        tag: { text: "PASS", tone: "acid" },
      },
    ],
    note: "Log in and toggle a setting — the race above, unedited. The extension spent 3.2 minutes and never landed the navigation.",
  },
  {
    title: "One look at the page",
    unit: "tokens per observation",
    bars: [
      { name: "read_page dump", value: 2564, display: "2,564", tone: "fog" },
      { name: "screenshot", value: 1620, display: "1,620", tone: "flare" },
      { name: "bx els", value: 42, display: "42", tone: "acid" },
    ],
    note: (
      <>
        <C>bx els</C> is the numbered element list the model acts on — budgeted
        at the source, so a look at the page is never a context event.
      </>
    ),
  },
  {
    title: "What your session absorbs",
    unit: "tokens into your main context, same task",
    bars: [
      {
        name: "Claude in Chrome",
        value: 8000,
        display: "~8,000",
        tone: "flare",
      },
      { name: "bx report", value: 300, display: "~300", tone: "acid" },
    ],
    note: "Every screenshot and retry the extension takes lands in your context and stays there. bx hands back a verdict; the drive stays on Haiku.",
  },
];

const BAR_TONE: Record<Bar["tone"], string> = {
  acid: "bg-acid",
  flare: "bg-flare/80",
  fog: "bg-fog-dim",
};

const TAG_TONE = {
  acid: "border-acid/50 bg-acid/10 text-acid",
  flare: "border-flare/50 bg-flare/10 text-flare",
};

const FACTS = [
  ["730ms", "cold start — daemon up, Chrome attached"],
  ["1.2s · 0 tokens", "a saved flow, replayed"],
  ["4×", "more interactive elements surfaced than the extension's tools"],
  ["~18×", "more page text per read"],
  ["5", "agents driving one browser concurrently"],
] as const;

function BarRow({ bar, max }: { bar: Bar; max: number }) {
  const pct = (bar.value / max) * 100;
  return (
    <div className="mt-4 first:mt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-[13px] text-fog">{bar.name}</span>
        <span className="flex items-center gap-2">
          {bar.tag && (
            <span
              className={`rounded border px-1.5 py-px font-mono text-[10px] font-semibold tracking-wider ${TAG_TONE[bar.tag.tone]}`}
            >
              {bar.tag.text}
            </span>
          )}
          <span className="font-mono text-[13px] text-chalk tabular-nums">
            {bar.display}
          </span>
        </span>
      </div>
      <div className="mt-1.5 h-3 w-full rounded-r bg-line/40" title={`${bar.name}: ${bar.display}`}>
        <div
          className={`h-full rounded-r ${BAR_TONE[bar.tone]}`}
          style={{ width: `max(${pct}%, 3px)` }}
        />
      </div>
    </div>
  );
}

export function Numbers() {
  return (
    <div>
      <div className="grid gap-4 lg:grid-cols-3">
        {CHARTS.map((chart) => {
          const max = Math.max(...chart.bars.map((b) => b.value));
          return (
            <div key={chart.title} className="rounded-lg border border-line bg-panel p-6">
              <h3 className="text-base font-semibold text-chalk">{chart.title}</h3>
              <p className="mt-1 font-mono text-[11px] tracking-[0.14em] text-fog-dim uppercase">
                {chart.unit}
              </p>
              <div className="mt-5">
                {chart.bars.map((bar) => (
                  <BarRow key={bar.name} bar={bar} max={max} />
                ))}
              </div>
              <p className="mt-5 text-[13px] leading-relaxed text-fog">{chart.note}</p>
            </div>
          );
        })}
      </div>

      <ul className="mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {FACTS.map(([value, label]) => (
          <li
            key={label}
            className="rounded-md border border-line-soft px-4 py-3"
          >
            <span className="block font-mono text-lg font-semibold text-acid tabular-nums">
              {value}
            </span>
            <span className="mt-1 block text-[12px] leading-snug text-fog-dim">
              {label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
