import { useState } from "react";
import type { ReactNode } from "react";
import { C } from "./Code";

/** Syntax tones, hand-applied — no highlighter, no extra dependency. */
function Kw({ children }: { children: string }) {
  return <span className="text-chalk">{children}</span>;
}
function Str({ children }: { children: string }) {
  return <span className="text-acid">{children}</span>;
}
function Cm({ children }: { children: string }) {
  return <span className="text-fog-dim italic">{children}</span>;
}
function Fn({ children }: { children: string }) {
  return <span className="text-amber/80">{children}</span>;
}

const stdout = (
  <>
    <span className="text-acid">✓ TaskBox — http://127.0.0.1:57395/fixture</span>
    {"\n\n"}
    <span className="text-chalk">{'[1] textbox "Email"'}</span>
    {"\n"}
    <span className="text-chalk">{'[2] textbox "Password"'}</span>
    {"\n"}
    <span className="text-chalk">{'[3] button "Sign in"'}</span>
  </>
);

const flowFile = (
  <>
    <Cm>{"// synthesized by bx agent — 2026-08-07"}</Cm>
    {"\n"}
    <Kw>import</Kw>
    {" { flow } "}
    <Kw>from</Kw> <Str>"bx/flow"</Str>;{"\n\n"}
    <Kw>export default</Kw> <Fn>flow</Fn>(<Str>"invoices"</Str>, <Kw>async</Kw> (b) ={">"} {"{"}
    {"\n  "}
    <Kw>await</Kw> b.<Fn>open</Fn>(<Str>"https://myapp.localhost"</Str>);{"\n  "}
    <Kw>await</Kw> b.<Fn>fill</Fn>(<Str>"Email"</Str>, <Str>"demo@acme.test"</Str>);{"\n  "}
    <Kw>await</Kw> b.<Fn>fill</Fn>(<Str>"Password"</Str>, <Str>""</Str>);{"  "}
    <Cm>{"// redacted at record time"}</Cm>
    {"\n  "}
    <Kw>await</Kw> b.<Fn>click</Fn>(<Str>"Sign in"</Str>);{"\n  "}
    <Kw>await</Kw> b.<Fn>expectText</Fn>(<Str>"Dashboard"</Str>);{"\n  "}
    <Kw>await</Kw> b.<Fn>click</Fn>(<Str>"Invoices"</Str>);{"\n  "}
    <Kw>await</Kw> b.<Fn>expectText</Fn>(<Str>"Invoice #1041"</Str>);{"\n"}
    {"});"}
  </>
);

const report = (
  <>
    <span className="text-acid">PASS</span>
    <span className="text-chalk">
      {" — Logged in as demo@acme.test, opened Invoices, verified"}
    </span>
    {"\n"}
    <span className="text-chalk">
      {'"Invoice #1041" renders. Evidence: expect text "Dashboard" ✓,'}
    </span>
    {"\n"}
    <span className="text-chalk">
      {'expect text "Invoice #1041" ✓, final url /invoices.'}
    </span>
    {"\n"}
    <span className="text-fog">
      {"tier=haiku turns=14 wall=25.9s tokens=31551/948 cost=$0.037"}
    </span>
  </>
);

type Artifact = {
  id: string;
  tab: string;
  title: string;
  body: ReactNode;
  caption: ReactNode;
  /** Prose reflows to the column; source code scrolls instead of wrapping. */
  wrap?: boolean;
};

const ARTIFACTS: [Artifact, ...Artifact[]] = [
  {
    id: "stdout",
    tab: "stdout",
    title: "What the model reads",
    body: stdout,
    caption: (
      <>
        This is the model's entire view of the page — no screenshot, no DOM dump.
        ~42 tokens.
      </>
    ),
  },
  {
    id: "flow",
    tab: "flow file",
    title: "What --save writes",
    body: flowFile,
    caption: (
      <>
        Typed TypeScript, checked by <C>tsc</C>, targets are testids and
        accessible names — never coordinates. <C>bx run</C> replays it in ~1.2s
        with zero model tokens.
      </>
    ),
  },
  {
    id: "report",
    tab: "report",
    title: "What the agent returns",
    body: report,
    wrap: true,
    caption: (
      <>
        ~300 tokens into your main context. The 30-turn transcript stays on Haiku.
      </>
    ),
  },
];

function Panel({ artifact }: { artifact: Artifact }) {
  return (
    <div className="flex min-w-0 flex-col">
      <h3 className="font-mono text-[11px] tracking-[0.16em] text-fog-dim uppercase">
        {artifact.title}
      </h3>
      <pre
        className={`bx-scroll mt-3 flex-1 overflow-x-auto rounded-lg border border-line bg-panel p-4 font-mono text-[11px] leading-[1.75] ${
          artifact.wrap ? "whitespace-pre-wrap" : ""
        }`}
      >
        <code>{artifact.body}</code>
      </pre>
      <p className="mt-3 text-[13px] leading-relaxed text-fog">{artifact.caption}</p>
    </div>
  );
}

export function Artifacts() {
  const [active, setActive] = useState<Artifact>(ARTIFACTS[0]);

  return (
    <div>
      {/* Tabs — mobile only; every panel is visible at once on desktop. */}
      <div
        className="mb-5 flex flex-wrap gap-2 md:hidden"
        role="group"
        aria-label="Artifacts"
      >
        {ARTIFACTS.map((a) => (
          <button
            key={a.id}
            type="button"
            aria-pressed={a.id === active.id}
            onClick={() => setActive(a)}
            className={`rounded-md border px-3 py-2 font-mono text-[13px] transition-colors ${
              a.id === active.id
                ? "border-acid/50 bg-acid/10 text-acid"
                : "border-line bg-panel text-fog"
            }`}
          >
            {a.tab}
          </button>
        ))}
      </div>

      <div className="grid gap-8 md:grid-cols-3">
        {ARTIFACTS.map((a) => (
          <div
            key={a.id}
            className={`min-w-0 ${a.id === active.id ? "block" : "hidden md:block"}`}
          >
            <Panel artifact={a} />
          </div>
        ))}
      </div>
    </div>
  );
}
