import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bx, eventTime, oldway, raceDuration } from "../data/compare";
import type { Timeline, TimelineEvent } from "../data/compare";
import { useInViewOnce, useReducedMotion } from "../lib/hooks";
import { REPO_URL } from "../lib/constants";

const SPEEDS = [1, 6, 20] as const;
type Speed = (typeof SPEEDS)[number];

/** A stretch of a timeline with nothing happening — the extension's dead air. */
const DEAD_AIR_MS = 10_000;

function clock(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  if (total < 60) return `${total.toFixed(1)}s`;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function useRaceClock(playing: boolean, speed: Speed, duration: number) {
  const [t, setT] = useState(0);
  const frame = useRef(0);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) * speed;
      last = now;
      setT((prev) => Math.min(duration, prev + dt));
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [playing, speed, duration]);

  return [t, setT] as const;
}

type Shot = { src: string; label: string; alt: string };
type ScreenCue = { at: number; shot: Shot };

const SHOTS: Record<string, Shot> = {
  login: { src: "/shots/login.png", label: "#/login", alt: "TaskBox login screen" },
  tasks: { src: "/shots/tasks.png", label: "#/tasks", alt: "TaskBox tasks screen" },
  settings: {
    src: "/shots/settings.png",
    label: "#/settings",
    alt: "TaskBox settings screen",
  },
  dark: {
    src: "/shots/settings-dark.png",
    label: "#/settings · dark",
    alt: "TaskBox settings dark screen",
  },
};

function cue(at: number, key: string): ScreenCue {
  const shot = SHOTS[key];
  if (!shot) throw new Error(`unknown shot "${key}"`);
  return { at, shot };
}

/** Screen changes derived from each transcript, not from hand-set timings. */
const BX_SCREENS: ScreenCue[] = [
  cue(0, "login"),
  cue(eventTime(bx, "clicked 3"), "tasks"),
  cue(eventTime(bx, "clicked 2"), "settings"),
  cue(eventTime(bx, "clicked 4"), "dark"),
];

const OLDWAY_SCREENS: ScreenCue[] = [
  cue(0, "login"),
  cue(eventTime(oldway, "Clicked at (488, 257)"), "tasks"),
];

function ScreenView({
  cues,
  t,
  stuck,
}: {
  cues: ScreenCue[];
  t: number;
  stuck: boolean;
}) {
  let index = 0;
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (c && c.at <= t) index = i;
  }
  const current = cues[index];

  return (
    <div className="border-b border-line-soft bg-panel-2 px-3 pt-3 pb-2">
      <div className="relative aspect-[16/5] w-full overflow-hidden rounded border border-line">
        {cues.map((c, i) => (
          <img
            key={c.shot.src}
            src={c.shot.src}
            alt={c.shot.alt}
            loading="lazy"
            width={1024}
            height={640}
            className={`absolute inset-0 h-full w-full object-cover object-top transition-opacity duration-300 ${
              i === index ? "opacity-100" : "opacity-0"
            }`}
          />
        ))}
        {stuck && (
          <span className="absolute bottom-2 left-2 rounded border border-flare/60 bg-ink/85 px-2 py-1 font-mono text-[10px] text-flare">
            never left this screen
          </span>
        )}
      </div>
      <p className="mt-2 font-mono text-[11px] text-fog-dim">{current?.shot.label}</p>
    </div>
  );
}

function Gap({ prev, t }: { prev: TimelineEvent; t: number }) {
  const stalled = prev.kind === "err";
  return (
    <div className="mt-2 flex items-center gap-2.5 rounded border border-flare/25 bg-flare/[0.06] px-2.5 py-2">
      <span className="bx-waiting size-2 shrink-0 rounded-full bg-flare" aria-hidden="true" />
      <span className="font-mono text-[11px] text-flare/90">
        {stalled ? "waiting on CDP" : "waiting"} — {clock(t - prev.at)}
      </span>
      <span
        aria-hidden="true"
        className="bx-sweep relative ml-auto hidden h-[3px] w-20 overflow-hidden rounded bg-flare/10 sm:block"
      />
    </div>
  );
}

function EventRow({ event }: { event: TimelineEvent }) {
  if (event.kind === "note") {
    return (
      <div className="my-1.5 border-l-2 border-amber/40 py-0.5 pl-2.5 text-[11px] leading-snug text-amber/80 italic">
        {event.text}
      </div>
    );
  }
  if (event.kind === "say") {
    return (
      <div className="truncate py-0.5 text-[11px] text-fog-dim italic">
        <span className="select-none">› </span>
        {event.text}
      </div>
    );
  }
  if (event.kind === "cmd") {
    return (
      <div className="py-0.5 break-all text-chalk">
        <span className="text-acid-deep select-none">$ </span>
        {event.text}
      </div>
    );
  }
  const failed = event.kind === "err";
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span
        className={`min-w-0 flex-1 truncate ${failed ? "text-flare" : "text-fog"}`}
        title={event.text}
      >
        {event.text}
      </span>
      {event.tok > 0 && (
        <span
          className={`shrink-0 rounded px-1 text-[10px] tabular-nums ${
            event.tok >= 1000 ? "bg-flare/15 text-flare" : "bg-line text-fog-dim"
          }`}
        >
          +{event.tok.toLocaleString()}
        </span>
      )}
    </div>
  );
}

function Pane({
  data,
  t,
  accent,
  screens,
}: {
  data: Timeline;
  t: number;
  accent: "flare" | "acid";
  screens: ScreenCue[];
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => data.events.filter((e) => e.at <= t), [data.events, t]);
  const finished = t >= data.outcome.at;
  const tokens = useMemo(() => shown.reduce((sum, e) => sum + e.tok, 0), [shown]);

  const last = shown.length > 0 ? shown[shown.length - 1] : undefined;
  const next = data.events[shown.length];
  const gapEnd = next ? next.at : data.outcome.at;
  const inDeadAir =
    !finished && last !== undefined && gapEnd - last.at > DEAD_AIR_MS && t > last.at;

  useEffect(() => {
    const node = bodyRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [shown.length, inDeadAir]);

  const isFail = accent === "flare";

  return (
    <div
      className={`flex min-w-0 flex-col overflow-hidden rounded-lg border bg-panel ${
        finished ? (isFail ? "border-flare/40" : "border-acid/40") : "border-line"
      }`}
    >
      <div className="border-b border-line-soft bg-panel-2 px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="font-mono text-sm font-medium text-chalk">{data.title}</h3>
          <span
            className={`shrink-0 font-mono text-[11px] tabular-nums ${
              tokens >= 1000 ? "text-flare" : "text-fog-dim"
            }`}
          >
            {tokens.toLocaleString()} tok
          </span>
        </div>
        <p className="mt-1 truncate text-[11px] text-fog-dim">{data.driver}</p>
      </div>

      <ScreenView cues={screens} t={t} stuck={isFail && finished} />

      <div
        ref={bodyRef}
        className="h-64 overflow-y-auto px-3 py-3 font-mono text-[12px] leading-relaxed sm:h-80"
      >
        {shown.map((event, i) => (
          <EventRow key={`${event.at}-${i}`} event={event} />
        ))}
        {inDeadAir && last && <Gap prev={last} t={t} />}
        {shown.length === 0 && (
          <p className="text-[11px] text-fog-dim">idle — press play</p>
        )}
      </div>

      <div className="border-t border-line-soft px-4 py-3">
        {finished ? (
          <div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span
                className={`rounded border px-2 py-0.5 font-mono text-xs font-semibold tracking-wider ${
                  isFail
                    ? "border-flare/50 bg-flare/10 text-flare"
                    : "border-acid/50 bg-acid/10 text-acid"
                }`}
              >
                {data.outcome.status}
              </span>
              <span className="font-mono text-xs text-fog tabular-nums">
                {data.outcome.wall}
              </span>
              <span className="font-mono text-xs text-fog-dim tabular-nums">
                {data.outcome.cost}
              </span>
            </div>
            <p className="mt-2 text-[11px] leading-snug text-fog-dim">
              {data.outcome.detail} · {data.outcome.tokens}
            </p>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span
              className="bx-waiting size-2 rounded-full bg-fog-dim"
              aria-hidden="true"
            />
            <span className="font-mono text-xs text-fog-dim tabular-nums">
              running — {clock(Math.min(t, data.outcome.at))}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export function Race() {
  const reduced = useReducedMotion();
  const [ref, inView] = useInViewOnce<HTMLDivElement>(0.3);
  const [speed, setSpeed] = useState<Speed>(6);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useRaceClock(playing && !reduced, speed, raceDuration);

  useEffect(() => {
    if (inView && !reduced) setPlaying(true);
  }, [inView, reduced]);

  const ended = t >= raceDuration;
  useEffect(() => {
    if (ended) setPlaying(false);
  }, [ended]);

  const reset = useCallback(() => {
    setT(0);
    setPlaying(true);
  }, [setT]);

  const shownT = reduced ? raceDuration : t;
  const progress = Math.min(100, (shownT / raceDuration) * 100);

  return (
    <div ref={ref}>
      <p className="mb-6 text-sm leading-relaxed text-fog">
        The fixture is TaskBox — a ~380-line static demo app that ships in the
        repo (login → tasks → settings), so the bench is reproducible:{" "}
        <a
          href={`${REPO_URL}/tree/main/fixtures/app`}
          className="font-mono text-[0.92em] whitespace-nowrap text-acid underline decoration-acid/30 underline-offset-2 hover:decoration-acid"
        >
          fixtures/app/index.html
        </a>
        . The screenshots below are <span className="font-mono text-[0.92em]">bx snap</span>{" "}
        output.
      </p>

      {!reduced && (
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => (ended ? reset() : setPlaying((p) => !p))}
            className="w-24 rounded-md border border-acid/40 bg-acid/10 px-3 py-2 font-mono text-[13px] text-acid transition-colors hover:bg-acid/20"
          >
            {ended ? "replay" : playing ? "pause" : "play"}
          </button>
          <div className="flex overflow-hidden rounded-md border border-line">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={s === speed}
                onClick={() => setSpeed(s)}
                className={`border-r border-line px-3 py-2 font-mono text-[13px] transition-colors last:border-r-0 ${
                  s === speed
                    ? "bg-panel-2 text-chalk"
                    : "text-fog-dim hover:bg-panel hover:text-fog"
                }`}
              >
                {s}×
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setT(0);
              setPlaying(false);
            }}
            className="rounded-md border border-line px-3 py-2 font-mono text-[13px] text-fog-dim transition-colors hover:border-fog/40 hover:text-fog"
          >
            reset
          </button>
          <span className="ml-auto font-mono text-[13px] text-fog tabular-nums">
            t = {clock(shownT)}
          </span>
        </div>
      )}

      <div
        aria-hidden="true"
        className="mb-5 h-px w-full overflow-hidden bg-line-soft"
      >
        <div
          className="h-px bg-acid/60 transition-none"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Pane data={oldway} t={shownT} accent="flare" screens={OLDWAY_SCREENS} />
        <Pane data={bx} t={shownT} accent="acid" screens={BX_SCREENS} />
      </div>

      <p className="mt-5 text-sm leading-relaxed text-fog-dim">
        Both timelines are real sessions against the same fixture app, replayed on
        one clock. Left: the extension, driven by the main session — coordinate
        clicks, two 30-second CDP timeouts, and a navigation that never landed.
        Right: <span className="font-mono text-fog">bx agent</span> on Haiku,
        finishing while the left pane is still waiting.
      </p>
    </div>
  );
}
