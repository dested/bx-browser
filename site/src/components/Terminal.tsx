import { useEffect, useRef, useState } from "react";
import { demos } from "../data/demos";
import type { Demo, DemoLine, Tone } from "../data/demos";
import { useInViewOnce, useReducedMotion } from "../lib/hooks";

type Rendered = { line: DemoLine; text: string; typing: boolean };

const TONE: Record<Tone, string> = {
  plain: "text-chalk",
  ok: "text-acid",
  dim: "text-fog",
  accent: "text-acid",
  fail: "text-flare",
};

function useTypedDemo(demo: Demo, instant: boolean, enabled: boolean) {
  const [shown, setShown] = useState<Rendered[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    if (instant) {
      setShown(demo.lines.map((line) => ({ line, text: lineText(line), typing: false })));
      setDone(true);
      return;
    }

    let cancelled = false;
    const timers: number[] = [];
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        timers.push(window.setTimeout(resolve, ms));
      });

    setShown([]);
    setDone(false);

    const run = async () => {
      for (const line of demo.lines) {
        if (cancelled) return;

        if (line.kind === "cmd") {
          setShown((prev) => [...prev, { line, text: "", typing: true }]);
          for (let i = 1; i <= line.text.length; i++) {
            await wait(i === 1 ? 90 : 14);
            if (cancelled) return;
            setShown((prev) => {
              const next = prev.slice(0, -1);
              return [...next, { line, text: line.text.slice(0, i), typing: true }];
            });
          }
          await wait(240);
          if (cancelled) return;
          setShown((prev) => {
            const next = prev.slice(0, -1);
            return [...next, { line, text: line.text, typing: false }];
          });
          continue;
        }

        await wait(line.kind === "blank" ? 60 : 150);
        if (cancelled) return;
        setShown((prev) => [...prev, { line, text: lineText(line), typing: false }]);
      }
      if (!cancelled) setDone(true);
    };

    void run();
    return () => {
      cancelled = true;
      for (const t of timers) window.clearTimeout(t);
    };
  }, [demo, instant, enabled]);

  return { shown, done };
}

function lineText(line: DemoLine): string {
  return line.kind === "blank" ? "" : line.text;
}

export function Terminal() {
  const reduced = useReducedMotion();
  const [wrapRef, seen] = useInViewOnce<HTMLDivElement>(0.25);
  const [active, setActive] = useState<Demo>(demos[0]);
  const [touched, setTouched] = useState(false);
  const { shown, done } = useTypedDemo(active, reduced, seen || touched);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = bodyRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [shown]);

  return (
    <div ref={wrapRef}>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Terminal demos">
        {demos.map((demo) => {
          const on = demo.id === active.id;
          return (
            <button
              key={demo.id}
              type="button"
              aria-pressed={on}
              onClick={() => {
                setActive(demo);
                setTouched(true);
              }}
              className={`rounded-md border px-3 py-2 font-mono text-[13px] transition-colors ${
                on
                  ? "border-acid/50 bg-acid/10 text-acid"
                  : "border-line bg-panel text-fog hover:border-fog/40 hover:text-chalk"
              }`}
            >
              {demo.label}
            </button>
          );
        })}
      </div>

      <div className="mt-5 overflow-hidden rounded-lg border border-line bg-panel">
        <div className="flex items-center gap-3 border-b border-line-soft bg-panel-2 px-4 py-2.5">
          <div className="flex gap-1.5" aria-hidden="true">
            <span className="size-2.5 rounded-full bg-line" />
            <span className="size-2.5 rounded-full bg-line" />
            <span className="size-2.5 rounded-full bg-line" />
          </div>
          <span className="font-mono text-[11px] tracking-[0.14em] text-fog-dim uppercase">
            {active.label}
          </span>
          <span
            className={`ml-auto rounded border px-2 py-0.5 font-mono text-[11px] transition-opacity ${
              done ? "opacity-100" : "opacity-0"
            } border-acid/40 bg-acid/10 text-acid`}
            aria-hidden={!done}
          >
            {active.badge}
          </span>
        </div>

        <div
          ref={bodyRef}
          aria-live="polite"
          className="h-[19rem] overflow-y-auto px-4 py-4 font-mono text-[13px] leading-[1.65] sm:h-[17.5rem] sm:text-sm"
        >
          {shown.map((row, i) => {
            if (row.line.kind === "blank") return <div key={i} className="h-3" />;
            if (row.line.kind === "cmd") {
              return (
                <div key={i} className="whitespace-pre-wrap">
                  <span className="text-acid-deep select-none">$ </span>
                  <span className="text-chalk">{row.text}</span>
                  {row.typing && <span className="bx-cursor ml-0.5" aria-hidden="true" />}
                </div>
              );
            }
            return (
              <div
                key={i}
                className={`whitespace-pre-wrap ${TONE[row.line.tone ?? "plain"]}`}
              >
                {row.text}
              </div>
            );
          })}
          {done && !reduced && <span className="bx-cursor" aria-hidden="true" />}
        </div>
      </div>

      <p className="mt-4 font-mono text-xs text-fog-dim">
        {done
          ? active.note
          : touched
            ? active.blurb
            : "Pick a task above — the output is what the CLI actually prints."}
      </p>
    </div>
  );
}
