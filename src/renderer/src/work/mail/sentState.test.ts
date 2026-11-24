import { describe, expect, it } from "vitest";
import { sentState } from "./sentState";

const CENTRAL = "America/Chicago";
// Monday Nov 23 2026, noon Central; the mail is set for Tuesday 8:00 AM Central.
const now = Date.UTC(2026, 10, 23, 18, 0);
const at = Date.UTC(2026, 10, 24, 14, 0);

describe("where a mail that left Drafts stands", () => {
  it("a scheduled mail is scheduled for its time, never Sending, however long it waits", () => {
    expect(sentState({ status: "queued", scheduled: true, sendAt: at }, CENTRAL, now)).toBe("Scheduled for Tue 8:00 AM");
    // Picked in another zone: both clocks, as the mail itself says it.
    expect(sentState({ status: "queued", scheduled: true, sendAt: at, sendZone: "America/New_York" }, CENTRAL, now)).toBe("Scheduled for Tue 8:00 AM Central · 9:00 AM Eastern");
  });

  it("a mail in its undo time or on its way is Sending", () => {
    expect(sentState({ status: "queued" }, CENTRAL, now)).toBe("Sending");
    expect(sentState({ status: "queued", sendAt: at }, CENTRAL, now)).toBe("Sending");
    expect(sentState({ status: "sending" }, CENTRAL, now)).toBe("Sending");
  });

  it("a sent mail names no time it does not know, and a failed one says so", () => {
    expect(sentState({ status: "sent", sendAt: at }, CENTRAL, now)).toBe("Sent");
    expect(sentState({ status: "failed" }, CENTRAL, now)).toBe("Not sent");
  });

  it("a draft has no such word", () => {
    expect(sentState({ status: "draft" }, CENTRAL, now)).toBeNull();
  });
});
