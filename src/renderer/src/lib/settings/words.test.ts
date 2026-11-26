import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SETTINGS_SECTIONS } from "../settings";
import { SETTINGS_MAP } from "./map";
import { RETIRED_WORDS, WORDED_FILES, shownWords } from "./words";

const ROOT = join(__dirname, "../..");

/** The retired words in what a text shows, each with the word that replaced it. */
const retiredIn = (texts: readonly string[]): string[] =>
  texts.flatMap((text) => RETIRED_WORDS.filter(({ word }) => word.test(text)).map(({ word, now }) => `“${text}” has ${word} (now: ${now})`));

describe("the words Settings shows", () => {
  it("reads what a file shows: JSX text and worded strings, never comments, imports or class strings", () => {
    const shown = shownWords(`
      import { Hosts } from "./Hosts page";
      // A host is a computer.
      /* Providers were renamed. */
      const a = <PageRow title="Largest attachment" className="Hosts row">Stuck after</PageRow>;
      const key = "host";
    `);
    expect(shown).toContain("Largest attachment");
    expect(shown).toContain("Stuck after");
    expect(shown.join("|")).not.toMatch(/Hosts|computer|Providers|^host$/);
  });

  it("reads a template's words and not its code: a `${…}` and a stretch between an arrow and a generic are code", () => {
    const shown = shownWords(`
      const a = <Row description={\`\${host.running} running, \${host.held} waiting\`} />;
      const b = useHostRead(link, () => host.request<State>("admission.get"));
    `);
    expect(shown).toContain("… running, … waiting");
    expect(shown.join("|")).not.toMatch(/host/);
  });

  it("names no page or row with a retired word", () => {
    const names = [...SETTINGS_SECTIONS.flatMap((s) => [s.label, s.title ?? "", s.description]), ...SETTINGS_MAP.flatMap((e) => [e.title, e.section])];
    expect(retiredIn(names)).toEqual([]);
  });

  it("keeps every old name findable: a retired word lives on only in a row's `was`", () => {
    const was = SETTINGS_MAP.flatMap((e) => e.was).join("|");
    for (const old of ["Hosts", "Providers", "Harness config", "Public origin", "Preamble", "Ghost text", "Orchestration", "Thread defaults"]) expect(was).toContain(old);
  });

  it.each(WORDED_FILES)("%s shows no retired word", (file) => {
    expect(retiredIn(shownWords(readFileSync(join(ROOT, file), "utf8")))).toEqual([]);
  });
});
