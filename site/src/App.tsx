import { Hero } from "./components/Hero";
import { Terminal } from "./components/Terminal";
import { Artifacts } from "./components/Artifacts";
import { AgentMode } from "./components/AgentMode";
import { Race } from "./components/Race";
import { Numbers } from "./components/Numbers";
import { HowItWorks } from "./components/HowItWorks";
import { Honesty } from "./components/Honesty";
import { Footer } from "./components/Footer";
import { Section } from "./components/Section";

export function App() {
  return (
    <div className="min-h-dvh">
      <Hero />

      <Section
        id="try"
        eyebrow="what it looks like"
        title="Four things you do every day"
        lede="Real commands, real output. Pick one."
      >
        <Terminal />
      </Section>

      <Section
        id="no-magic"
        wide
        eyebrow="the artifacts"
        title="No magic"
        lede="The entire interface between the model and the browser is plain text. Here it is."
      >
        <Artifacts />
      </Section>

      <Section
        id="agent"
        wide
        eyebrow="the payoff"
        title="Agent mode"
        lede="One instruction in. A verdict out. The drive happens on a model that costs 1/10th of yours."
      >
        <AgentMode />
      </Section>

      <Section
        id="race"
        eyebrow="the race"
        title="The same task, two drivers, one clock"
        lede="Log in and toggle a setting on a fixture app. Left is a real Claude in Chrome session. Right is a real bx agent run. Neither timeline has been edited."
      >
        <Race />
      </Section>

      <Section id="numbers" eyebrow="measured" title="What that buys you">
        <Numbers />
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
  );
}
