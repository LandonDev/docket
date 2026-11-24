import { describe, expect, it } from "vitest";
import { STATE_LINES, type StateFact } from "@shared/work/stateLines";
import { stateLineSources } from "./stateLineSources.test-support";

const KNOWN: readonly { file: string; literal: string; fact: StateFact; wall: string }[] = [];

function overclaims(literal: string, fact: StateFact): boolean {
  return /^`?(?:Saved|Sent)\b/.test(literal.trimStart()) && (fact === "queued" || fact === "stored token");
}

describe("Work state lines", () => {
  it("lists every state line with the fact it reads and keeps the known walls current", () => {
    const lines = stateLineSources();
    const hits: string[] = [];
    function take(file: string, literal: string, fact: StateFact, wall?: string): void {
      const i = lines.findIndex((line) => line.file === file && line.literal === literal);
      if (i === -1) {
        hits.push(`Unused ${wall ? "wall" : "state line"}: ${file}: ${literal}${wall ? ` (${wall})` : ""}`);
        return;
      }
      const [{ at }] = lines.splice(i, 1);
      if (!wall && overclaims(literal, fact)) hits.push(`${at}: reword ${literal}, its fact is ${fact}`);
      if (wall && !overclaims(literal, fact)) hits.push(`${at}: remove the exception for ${wall}`);
    }
    for (const { file, literal, fact, wall } of KNOWN) take(file, literal, fact, wall);
    for (const [file, rows] of Object.entries(STATE_LINES)) {
      for (const [literal, fact] of rows) take(file, literal, fact);
    }
    for (const { at, literal } of lines) hits.push(`${at}: classify ${JSON.stringify(literal)}`);
    expect(hits).toEqual([]);
  });
});
