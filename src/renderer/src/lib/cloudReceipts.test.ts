import { describe, expect, it } from "vitest";
import type { CloudBack, CopyBack } from "@shared/contract-work-files";
import { cloudLine, cloudOfBack, copyLine, newestBack } from "../work/files/fileText";

/**
 * In Teams only for our bytes (plan-cBclQIRDtvVS decision 18): the line a copy's tab shows is told of the cloud only by
 * the record that came with the receipt it shows. Causal, beside stateLinesGuard.test.ts, which checks the words alone.
 */
const NOW = Date.UTC(2026, 10, 25, 15);
const lineOf = (tab: { back: CopyBack; cloud?: CloudBack }, answer?: CopyBack) => {
  const back = newestBack(tab.back, answer);
  return cloudLine(copyLine(null, back, "MacBook", NOW), cloudOfBack(tab, back), "Teams", "MacBook", NOW).words;
};

describe("In Teams on a copy's line", () => {
  const first: CopyBack = { is: "ok", at: NOW - 60_000, writes: 1, held: 1 };
  const second: CopyBack = { is: "ok", at: NOW - 1_000, writes: 2, held: 2 };
  const uploaded: CloudBack = { is: "uploaded", at: NOW - 30_000 };

  it("says In Teams of the save the tab's record followed", () => {
    expect(lineOf({ back: first, cloud: uploaded })).toMatch(/^In Teams/);
  });

  it("says the computer's receipt alone when a second save's answer reaches the window before its cloud update", () => {
    // The send's answer holds write 2; the tab still carries write 1 and what OneDrive did with it.
    expect(lineOf({ back: first, cloud: uploaded }, second)).toMatch(/^Saved to MacBook \S/);
    // The tab catches up: the host follows write 2 from its own write, with no cloud yet.
    expect(lineOf({ back: second }, second)).toMatch(/^Saved to MacBook \S/);
    expect(lineOf({ back: second, cloud: { is: "uploading", at: second.at! } }, second)).toBe("Saved, uploading to Teams…");
    expect(lineOf({ back: second, cloud: { is: "uploaded", at: NOW } }, second)).toMatch(/^In Teams/);
  });

  it("keeps an older answer from hiding the tab's own record", () => {
    expect(lineOf({ back: second, cloud: uploaded }, first)).toMatch(/^In Teams/);
  });
});
