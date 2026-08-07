// Snapshots skill/SKILL.md into a TS module the site can import. Runs before
// dev and build (see package.json) so the modal always shows the real skill.
import { readFileSync, writeFileSync } from "node:fs";

const md = readFileSync(new URL("../../skill/SKILL.md", import.meta.url), "utf8");
writeFileSync(
  new URL("../src/data/skill-source.ts", import.meta.url),
  `// generated from skill/SKILL.md — do not edit; run \`bun scripts/gen-skill.ts\`\n` +
    `export const skillSource = ${JSON.stringify(md)};\n`,
);
console.log("generated src/data/skill-source.ts");
