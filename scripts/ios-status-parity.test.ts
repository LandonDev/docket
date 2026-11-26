import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { STATUS_WORD } from "../src/renderer/src/components/ui/status";
import { COMPACTING_WORDS } from "../src/shared/statusWords";

/* The phone holds the desktop's status words once, in the client package's
 * `StatusWord` (Client/StatusWords.swift; docs/IOS-DESIGN.md "Status
 * vocabulary"). This reads that enum and fails when a word differs from
 * status.tsx's STATUS_WORD or statusWords.ts, so one state keeps one name on
 * both. The Live Activity, a target of its own, spells its waiting word
 * literally; the last case holds it too. */
const ROOT = resolve(__dirname, "..");
const swift = readFileSync(resolve(ROOT, "ios/TempCodeClient/Sources/TempCodeClient/Client/StatusWords.swift"), "utf8");
const activity = readFileSync(resolve(ROOT, "ios/TempCode/Activity/Shared/ThreadActivityText.swift"), "utf8");

export function statusWords(text: string): Record<string, string> {
  const body = text.match(/public enum StatusWord \{([\s\S]*?)\n\}/);
  if (!body) throw new Error("StatusWords.swift has no StatusWord enum");
  const out: Record<string, string> = {};
  for (const m of body[1].matchAll(/public static let (\w+) = "([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

const phone = statusWords(swift);

describe("the phone's status words", () => {
  it("take every word of STATUS_WORD the phone draws", () => {
    expect(phone.working).toBe(STATUS_WORD.working);
    expect(phone.needsYou).toBe(STATUS_WORD.waiting);
    expect(phone.paused).toBe(STATUS_WORD.paused);
    expect(phone.failed).toBe(STATUS_WORD.failed);
    expect(phone.queued).toBe(STATUS_WORD.queued);
    expect(phone.stopped).toBe(STATUS_WORD.stopped);
    expect(phone.watching).toBe(STATUS_WORD.watching);
    expect(phone.done).toBe(STATUS_WORD.done);
    expect(phone.idle).toBe(STATUS_WORD.idle);
  });

  it("take statusWords.ts's compaction and starting words", () => {
    expect(phone.compacting).toBe(COMPACTING_WORDS);
    expect(phone.starting).toBe("Starting");
  });

  it("are the Live Activity's too", () => {
    expect(activity).toContain(`case .working: "${STATUS_WORD.working}"`);
    expect(activity).toContain(`case .waiting: "${STATUS_WORD.waiting}"`);
  });

  it("are parsed from the enum", () => {
    expect(statusWords('public enum StatusWord {\n    public static let working = "Working"\n}')).toEqual({ working: "Working" });
  });
});
