import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A usage window past its reset is spent no more, whatever its last poll
 * said. The window reads windows through one rule (src/shared/usageMeter.ts:
 * `isLive`, `windowAsOf`, `drawnWindows`), so this guard fails when a file
 * reads a window's use (`usedPercent`, `percentLeft`, `healthOf`, `toneFor`,
 * `fillFor`, `onPaceLeft`) without taking one of them: before it, the
 * Accounts row said "0% left" on a week that had already refilled.
 */
const REPO = resolve(__dirname, "../../../..");
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "proof" || name === "fixtures" ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.(test|dom\.test|preview|fixtures)\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) ? [path] : [];
  });
}
const rel = (path: string) => relative(REPO, path);

/** Where the readers themselves are defined: they judge the window they are handed. */
const DEFINES = new Set(["src/renderer/src/aliax/lib/accounts.ts"]);
const READS = /\b(percentLeft|healthOf|toneFor|fillFor|onPaceLeft)\(|\.usedPercent\b/;
const RULE = /import\s*{[^}]*\b(isLive|windowAsOf|drawnWindows)\b[^}]*}\s*from\s*["']@shared\/usageMeter["']/;

describe("the usage reset guard", () => {
  it("every renderer file that reads a window's use reads it through the reset rule", () => {
    const readers = sources(join(REPO, "src/renderer/src"))
      .filter((f) => !DEFINES.has(rel(f)))
      .filter((f) => READS.test(readFileSync(f, "utf8")));
    expect(readers.length).toBeGreaterThan(0);
    expect(readers.filter((f) => !RULE.test(readFileSync(f, "utf8"))).map(rel)).toEqual([]);
  });
});
