import type { ReactNode } from "react";

const REPO_URL = "https://github.com/dested/bx-browser";
const SKILL_URL = `${REPO_URL}/blob/main/skill/SKILL.md`;
const FIXTURE_URL = `${REPO_URL}/tree/main/fixtures/app`;

// No slop. Semantic HTML and one small stylesheet (index.css) that makes it read
// like a plain document — a centered column, classic bordered tables, blue links,
// a little green. Charts are hand-drawn bars, images are real bx-snap output.
// Here's the header, the subheader, the numbers. You're a big boy.
// Same ethos bx ships: text over pixels.

type Bar = {
  label: string;
  value: number;
  display: string;
  tone?: "good" | "bad";
  tag?: { text: string; tone: "good" | "bad" };
};

function BarChart({
  title,
  unit,
  bars,
  children,
}: {
  title: string;
  unit: string;
  bars: Bar[];
  children?: ReactNode;
}) {
  const max = Math.max(...bars.map((b) => b.value));
  return (
    <div className="chart">
      <h3>{title}</h3>
      <p className="chart-unit">{unit}</p>
      <table className="bars">
        <tbody>
          {bars.map((b) => (
            <tr key={b.label}>
              <td className="bar-label">{b.label}</td>
              <td className="bar-cell">
                <div className="bar-track">
                  <div
                    className={b.tone ? `bar-fill ${b.tone}` : "bar-fill"}
                    style={{ width: `${Math.max((b.value / max) * 100, 1.5)}%` }}
                  />
                </div>
              </td>
              <td className="bar-value">
                {b.display}
                {b.tag ? (
                  <>
                    {" "}
                    <span className={b.tag.tone === "good" ? "pass" : "fail"}>
                      {b.tag.text}
                    </span>
                  </>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {children}
    </div>
  );
}

export function App() {
  return (
    <main>
      <h1 className="bx">bx</h1>
      <p>browser automation for Claude Code</p>

      <h2>Claude in Chrome burns tokens, minutes, and sometimes the task — bx replaces it</h2>
      <p>
        The screenshot loop sends your frontier model a ~1,600-token image to find
        one button, round-trips every click through it, and still loses the thread.
        bx is a CLI over real Chrome built for exactly one user: a coding agent.
        Distilled text instead of pixels, hard budgets at the source, a cheap model
        doing the driving — and a path that works becomes a typed flow that never
        needs a model again.
      </p>

      <hr />

      <h2>Install</h2>
      <pre>
        <code>
          bun add -g bx-browser{"\n"}
          bx install-skill
        </code>
      </pre>
      <p>
        Same two lines on macOS, Linux, and Windows. Requires Bun and Chrome. The
        second line drops the Claude Code skill into <code>~/.claude/skills/bx</code>{" "}
        (<code>%USERPROFILE%\.claude\skills\bx</code> on Windows) — then tell Claude
        Code: <strong className="bx">"use bx to verify your changes."</strong>
      </p>
      <p>
        <strong>On Windows, an optional native front door.</strong>{" "}
        <code>bun run build:frontdoor</code> builds <code>bx.exe</code>, a 1.9 MB
        NativeAOT binary that sends the command line straight to the running
        daemon and prints exactly what the Bun CLI would — about 25 ms a call
        instead of 75. Anything it can't serve (stdin scripts, <code>bx agent</code>,{" "}
        <code>bx run</code>) it hands to Bun. Needs the .NET 10 SDK to build.
      </p>
      <p>
        <strong>Runs on your Claude Code subscription.</strong> Delegated drives go
        through the Agent SDK with the same auth Claude Code itself uses — Haiku by
        default, escalating to Sonnet, Opus if you allow it. Signed in with a Max
        plan, that's your subscription: no API key, no separate bill. What it saves
        you is time, context, and wasted runs.
      </p>
      <p>
        One honest caveat: if <code>ANTHROPIC_API_KEY</code> is set in your
        environment, Claude Code — and therefore bx — bills the API instead. That's
        how Claude Code's auth resolution works, not a bx decision; unset the
        variable and you're back on the subscription.
      </p>

      <hr />

      <h2>You never type a bx command — you just talk</h2>
      <p>
        Install the skill once and Claude Code reaches for bx on its own whenever a
        browser task shows up. Real prompts, and the commands they turn into:
      </p>

      <h3>"Use bx to verify your changes"</h3>
      <pre>
        <code>
          bx open https://myapp.localhost{"\n"}
          bx expect text "Saved"{"\n"}
          bx console{"\n"}
          bx net --failed
        </code>
      </pre>
      <p>
        The default verification trio: an assertion, console errors, failed
        requests. <code>expect</code> exits 1 on failure — the agent gets a hard
        signal, not a screenshot to squint at.
      </p>

      <h3>"Test the login flow with bx and keep it as a regression"</h3>
      <pre>
        <code>
          bx agent "log in as demo@taskbox.test{"\n"}
          {"  "}and verify the task list loads" --save login
        </code>
      </pre>
      <p>
        Haiku drives on your Claude Code subscription — escalating to Sonnet (and
        Opus, if you allow it) only when it has to. Your session gets a ~300-token
        report, and <code>flows/login.flow.ts</code> replays forever at zero model
        tokens.
      </p>

      <h3>"Fill out the signup form and tell me what the error toast says"</h3>
      <pre>
        <code>
          bx els --filter signup{"\n"}
          bx fill "Email" "qa@test.dev"{"\n"}
          bx click "Create account"{"\n"}
          bx text ".toast"
        </code>
      </pre>
      <p>
        Hand-driving, for when each intermediate state matters. Targets are text or
        selectors, every read is budgeted, and nothing here costs an image.
      </p>

      <h3>"Record a walkthrough of the checkout bug for the PR"</h3>
      <pre>
        <code>
          bx record start checkout-bug --follow{"\n"}
          bx click "Checkout"{"\n"}
          bx record mark "total jumps here"{"\n"}
          bx record stop
        </code>
      </pre>
      <p>
        Starts in ~150 ms, stops in ~120 ms, and never restarts the browser: your
        tabs, typed values and login all survive. You get{" "}
        <code>recordings/checkout-bug/</code> with <code>video.webm</code>, a
        timestamped action log with your marks, and a <code>report.md</code> of
        deduped keyframes and contact sheets that builds in the background. Drop it
        straight into the PR.
      </p>

      <h3>"Something weird just happened — grab the last 30 seconds"</h3>
      <pre>
        <code>
          bx record start --ring 60{"\n"}
          ...{"\n"}
          bx record save --last 30
        </code>
      </pre>
      <p>
        Ring mode keeps the newest frames in memory (capped at 64 MB) and only
        encodes when you ask. Save a clip while capture keeps running.
      </p>

      <h3>One markdown file teaches Claude Code all of it</h3>
      <p>
        <code>bx install-skill</code> writes a ~260-line skill file to{" "}
        <code>~/.claude/skills/bx</code>. It covers every verb and, more
        importantly, when to reach for them: "verify in the browser", "check the
        console", "test the game", any local dev URL. It loads only when a browser
        task actually shows up — compare that to ~24 MCP tool schemas sitting
        resident in every context you ever open, whether or not the browser is
        touched. <a href={SKILL_URL}>Read the skill</a>.
      </p>

      <hr />

      <h2>The same task, two drivers, one clock</h2>
      <p>
        This is why bx exists: nobody wants the screenshot loop, and there is
        nothing the extension can do about it. Log in and toggle a setting on a
        fixture app. Both timelines are real sessions against the same fixture —
        TaskBox, a ~380-line static demo app that ships in the repo (
        <a href={FIXTURE_URL}>fixtures/app/index.html</a>).
      </p>
      <figure>
        <div className="shot">
          <img src="/shots/login.png" alt="TaskBox sign-in screen" width={1024} height={640} />
        </div>
        <figcaption>The fixture both drivers start from — TaskBox, sign in (bx snap output).</figcaption>
      </figure>
      <table>
        <thead>
          <tr>
            <th>driver</th>
            <th>result</th>
            <th>wall</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Claude in Chrome (main session)</td>
            <td><span className="fail">FAILED</span></td>
            <td>3.2 min</td>
          </tr>
          <tr>
            <td>bx agent (Haiku)</td>
            <td><span className="pass">PASS</span></td>
            <td>25.9s</td>
          </tr>
        </tbody>
      </table>
      <p>
        The extension spent 3.2 minutes on coordinate clicks and two 30-second CDP
        timeouts, and the navigation never landed. bx agent on Haiku finished while
        the extension was still waiting.
      </p>

      <hr />

      <h2>Where the time and tokens actually go</h2>
      <p>
        Most people run this on a Claude Code subscription, so the spend that matters
        isn't dollars — it's minutes, context, and wasted runs. Every number below is
        real captured output from the bench and race transcripts in the repo.
      </p>

      <BarChart
        title="Same task, one clock"
        unit="seconds to a verified result"
        bars={[
          { label: "Claude in Chrome", value: 193.5, display: "3.2 min", tone: "bad", tag: { text: "FAILED", tone: "bad" } },
          { label: "bx agent", value: 25.9, display: "25.9s", tone: "good", tag: { text: "PASS", tone: "good" } },
        ]}
      >
        <p>
          The extension never landed the navigation. bx agent on Haiku finished
          the whole task in a quarter of a minute.
        </p>
      </BarChart>

      <BarChart
        title="One look at the page"
        unit="tokens per observation"
        bars={[
          { label: "read_page dump", value: 2564, display: "2,564" },
          { label: "screenshot", value: 1620, display: "1,620", tone: "bad" },
          { label: "bx els", value: 42, display: "42", tone: "good" },
        ]}
      >
        <p>
          <code>bx els</code> is the numbered element list the model acts on —
          budgeted at the source, so a look at the page is never a context event.
        </p>
      </BarChart>

      <BarChart
        title="What your session absorbs"
        unit="tokens into your main context, same task"
        bars={[
          { label: "Claude in Chrome", value: 8000, display: "~8,000", tone: "bad" },
          { label: "bx report", value: 300, display: "~300", tone: "good" },
        ]}
      >
        <p>
          Every screenshot and retry the extension takes lands in your context and
          stays there. bx hands back a verdict; the drive stays on Haiku.
        </p>
      </BarChart>

      <h3>A few more measured facts</h3>
      <ul>
        <li>~0.7s — cold start: daemon up, Chrome attached, first command answered</li>
        <li>1.2s · 0 tokens — a saved flow, replayed</li>
        <li>4× — more interactive elements surfaced than the extension's tools</li>
        <li>~18× — more page text per read</li>
        <li>5 — agents driving one browser concurrently</li>
        <li>
          12/12 — Haiku on the agent bench: median 7.5 turns, ~15s, ~$0.002 a task
          at API list price
        </li>
      </ul>

      <h3>Faster, measured before and after</h3>
      <table>
        <thead>
          <tr>
            <th>what</th>
            <th>before</th>
            <th>now</th>
          </tr>
        </thead>
        <tbody>
          <tr><td>click a plainly clickable element</td><td>33 ms</td><td>4 ms</td></tr>
          <tr><td><code>els</code> on a 6,000-element page</td><td>1,440 ms</td><td>13 ms</td></tr>
          <tr><td>full-page <code>snap</code></td><td>243 ms</td><td>99 ms</td></tr>
          <tr><td>click on an animated page</td><td>1,547 ms</td><td>94 ms</td></tr>
          <tr><td>one command through <code>bx.exe</code> (Windows)</td><td>72 ms</td><td>23 ms</td></tr>
          <tr><td>start a recording</td><td>~1 s</td><td>~150 ms</td></tr>
          <tr><td>stop a recording</td><td>1.2–7.5 s</td><td>~120 ms</td></tr>
        </tbody>
      </table>
      <p>
        Clicks on an element that is visible, enabled, still and on top go
        straight to a trusted mouse click at its center; anything doubtful takes
        Playwright's full checks. Settling after an action waits for the DOM and
        the action's own requests to go quiet instead of a fixed sleep.
      </p>

      <hr />

      <h2>One instruction in, a verdict out</h2>
      <p>
        What actually happens when Claude Code hands a browser task to bx agent —
        every artifact below is real captured output.
      </p>

      <h3>In — what Claude Code runs (you never see this either)</h3>
      <pre>
        <code>
          bx agent "log in as demo@taskbox.test, turn on dark mode in Settings, and
          verify it stuck" --save dark-mode
        </code>
      </pre>
      <p>
        One instruction, phrased by Claude Code from whatever you said. No element
        refs, no coordinates, no screenshots on your side of the wire.
      </p>
      <p>What Haiku reads each turn — its entire view of the page, ~42 tokens:</p>
      <pre>
        <code>
          ✓ TaskBox — http://127.0.0.1:57395/fixture{"\n\n"}
          [1] textbox "Email"{"\n"}
          [2] textbox "Password"{"\n"}
          [3] button "Sign in"
        </code>
      </pre>

      <h3>During — what Haiku did</h3>
      <p>14 turns · 25.9s · stays on Haiku · on your Claude Code subscription.</p>

      <h3>Out — what your context receives</h3>
      <pre>
        <code>
          PASS — Logged in, enabled dark mode in Settings, verified.{"\n"}
          Evidence: expect text "Dark mode on" ✓ · final url #/settings{"\n"}
          tier=haiku turns=14 wall=25.9s
        </code>
      </pre>
      <p>
        The report — roughly 300 tokens. The 14-turn transcript never enters your
        session. What "verify it stuck" actually checked, before and after:
      </p>
      <figure>
        <div className="shot">
          <img src="/shots/settings.png" alt="TaskBox Settings, dark mode off" width={1024} height={640} />
        </div>
        <figcaption>Before — Settings, "Dark mode off".</figcaption>
      </figure>
      <figure>
        <div className="shot">
          <img src="/shots/settings-dark.png" alt="TaskBox Settings, dark mode on" width={1024} height={640} />
        </div>
        <figcaption>After — Settings, "Dark mode on". This is the state the flow's <code>expectText("Dark mode on")</code> asserts.</figcaption>
      </figure>
      <p>And the run synthesizes a typed flow you can commit:</p>
      <pre>
        <code>
          {"// synthesized by bx agent — flows/dark-mode.flow.ts\n"}
          import {"{ flow }"} from "bx/flow";{"\n\n"}
          export default flow("dark-mode", async (b) =&gt; {"{"}{"\n"}
          {"  "}await b.open("http://127.0.0.1:8000/fixture");{"\n"}
          {"  "}await b.fill("Email", "demo@taskbox.test");{"\n"}
          {"  "}await b.fill("Password", ""); // redacted at record time{"\n"}
          {"  "}await b.click("Sign in");{"\n"}
          {"  "}await b.click("Settings");{"\n"}
          {"  "}await b.click("Dark mode");{"\n"}
          {"  "}await b.expectText("Dark mode on");{"\n"}
          {"});"}
        </code>
      </pre>
      <p>
        <code>tsc</code> checks it, git versions it, and{" "}
        <code>bx run flows/dark-mode.flow.ts</code> replays it tomorrow in 1.2s with
        zero model involvement. The agent run is the authoring cost; every run after
        is a free regression test.
      </p>

      <h3>Measured on a real production app</h3>
      <table>
        <thead>
          <tr>
            <th>task</th>
            <th>turns</th>
            <th>wall</th>
          </tr>
        </thead>
        <tbody>
          <tr><td>holidays count</td><td>11</td><td>26s</td></tr>
          <tr><td>overview + all-tasks synthesis</td><td>37</td><td>75s</td></tr>
          <tr><td>users + weekend schedule</td><td>18</td><td>23s</td></tr>
          <tr><td>module types</td><td>11</td><td>16s</td></tr>
          <tr><td>tags</td><td>13</td><td>20s</td></tr>
          <tr><td>settings profile</td><td>13</td><td>12s</td></tr>
          <tr><td>holidays + PTO</td><td>22</td><td>30s</td></tr>
        </tbody>
      </table>
      <p>
        7/7 correct, independently verified. 5 agents ran concurrently against one
        browser — each pinned to its own tab. Your context pays for the verdict, not
        the drive.
      </p>

      <hr />

      <h2>Three moving parts</h2>
      <p>A daemon, a set of verbs, and files you can commit.</p>

      <h3>A daemon holds your real Chrome</h3>
      <p>
        One background process per profile owns a real Chrome instance over
        playwright-core — persistent user-data-dirs, so you sign in by hand once and
        the session survives every run. The CLI talks to it over localhost HTTP.
        Nothing is a bundled headless browser unless you ask for one. Every command
        runs under a deadline, so a page stuck in a busy loop answers{" "}
        <code>deadline … during &lt;step&gt;</code> instead of hanging, and a crashed
        browser is relaunched on the next command. <code>bx doctor</code> and{" "}
        <code>bx gc</code> find orphaned Chromes, stale locks and old profiles (dry
        run until you pass <code>--fix</code> / <code>--yes</code>).
      </p>

      <h3>Verbs act on distilled text</h3>
      <p>
        <code>open</code>, <code>els</code>, <code>click</code>, <code>fill</code>,{" "}
        <code>expect</code>, <code>console</code>, <code>net</code>. Every read is
        budgeted at the source — the element list caps around 800 tokens, page text
        at 2,000, console and network at 30 entries — so output can never blow up a
        context window, and the model never has to ration a look at the page.
      </p>
      <p>
        A number from <code>els</code> names the element itself, not a position in
        the last scan: it survives re-scans and only goes stale when the element
        leaves the page. Text targets are ranked — exact name, then exact text,
        then prefix, then substring — and a tie answers <code>ambiguous</code> with
        the candidates instead of guessing. Every action reports what changed: the
        URL, the title, a dialog, new or removed elements, a tab that opened.
      </p>

      <h3>Flows replay for free</h3>
      <p>
        A path that works becomes a typed TypeScript file. <code>tsc</code> checks
        it, git versions it, and re-running it costs zero model tokens — which makes
        the same artifact a regression test you can drop into CI or a pre-push hook.
      </p>

      <h3>Real-time mode — for 60fps canvases, the model ships code into the page</h3>
      <p>
        A read→decide→click loop is seconds per decision; a game runs at 60fps. So{" "}
        <code>bx drive</code> installs an agent-authored controller that runs inside
        the page every frame, while the daemon polls a win condition — zero model
        tokens while it plays. Games, drag physics, anything the DOM can't describe.
      </p>

      <h3>Recordings — video becomes something a model can read</h3>
      <p>
        <code>bx record start</code> streams one tab's frames straight out of
        Chrome into ffmpeg — no browser restart, so tabs and typed values survive —
        and <code>--follow</code> moves the capture to whichever tab becomes active.
        After <code>bx record stop</code>, the video is distilled in the background
        into deduped keyframes, 3×3 contact sheets, and a <code>report.md</code>.
        There is no audio, so bx's own action log — clicked Save changes, filled
        Email, plus any <code>bx record mark</code> you dropped — is the timed
        transcript. <code>--mp4</code> adds an mp4 for sharing.
      </p>

      <hr />

      <h2>When the extension is still the right tool</h2>
      <p>bx is not a superset. Three cases where it is the wrong choice:</p>

      <h3>Your own logged-in daily browser</h3>
      <p>
        bx drives its own profiles under <code>~/.bx/profiles</code>. Chrome 136+
        blocks CDP on the default user-data-dir and app-bound encryption blocks
        importing cookies, so the browser you already have open, with all its
        sessions, stays out of reach. The extension lives inside it. (A bridge
        extension into your daily Chrome is the v2 roadmap.)
      </p>

      <h3>Hierarchical accessibility-tree reads</h3>
      <p>
        <code>els</code> returns a flat, numbered list tuned for acting on things.
        When the question is about structure — nesting, landmarks, what contains
        what — <code>read_page</code>'s tree is genuinely the better read.
      </p>

      <h3>Arbitrary third-party sites</h3>
      <p>
        bx is built for driving apps you're actually working on — a dev server, a
        real project, a flow file worth keeping. For one-off poking at a site you
        have never seen, the screenshot loop needs no setup and no profile.
      </p>

      <hr />

      <footer>
        <p>
          <a href={REPO_URL}>github.com/dested/bx-browser</a> · MIT
        </p>
        <p>
          Every transcript, number, and report on this page is real captured output —
          bench and fixture in the repo. This page is plain HTML on purpose.
        </p>
      </footer>
    </main>
  );
}
