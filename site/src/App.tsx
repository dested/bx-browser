import { Hero } from "./components/Hero";
import { ClaudeCode } from "./components/ClaudeCode";
import { Race } from "./components/Race";
import { Numbers } from "./components/Numbers";
import { Delegation } from "./components/Delegation";
import { HowItWorks } from "./components/HowItWorks";
import { Honesty } from "./components/Honesty";
import { Footer } from "./components/Footer";
import { Section } from "./components/Section";
import { OsProvider } from "./lib/os";

export function App() {
  return (
    <OsProvider>
      <div className="min-h-dvh">
        <Hero />

        <Section
          id="claude-code"
          eyebrow="how you use it"
          title="You never type a bx command. You just talk."
          lede="Install the skill once and Claude Code reaches for bx on its own whenever a browser task shows up. Real prompts, and the commands they turn into:"
        >
          <ClaudeCode />
        </Section>

        <Section
          id="race"
          wide
          eyebrow="side by side"
          title="The same task, two drivers, one clock"
          lede="This is why bx exists: nobody wants the screenshot loop, and there is nothing the extension can do about it. Log in and toggle a setting on a fixture app — left is a real Claude in Chrome session, right is a real bx agent run. Neither timeline has been edited."
        >
          <Race />
        </Section>

        <Section
          id="numbers"
          eyebrow="measured"
          title="Where the time and tokens actually go"
          lede="Most people run this on a Claude Code subscription, so the spend that matters isn't dollars — it's minutes, context, and wasted runs."
        >
          <Numbers />
        </Section>

        <Section
          id="delegation"
          wide
          eyebrow="under the hood"
          title="One instruction in. A verdict out."
          lede="What actually happens when Claude Code hands a browser task to bx agent — every artifact below is real captured output."
        >
          <Delegation />
        </Section>

        <Section
          id="how"
          eyebrow="how it works"
          title="Three moving parts"
          lede="A daemon, a set of verbs, and files you can commit."
        >
          <HowItWorks />
        </Section>

        <Section
          id="honesty"
          eyebrow="tradeoffs"
          title="When the extension is still the right tool"
          lede="bx is not a superset. Three cases where it is the wrong choice:"
        >
          <Honesty />
        </Section>

        <Footer />
      </div>
    </OsProvider>
  );
}
