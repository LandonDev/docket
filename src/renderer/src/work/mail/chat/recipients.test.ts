import { describe, expect, it } from "vitest";
import { strangers, strangersLine } from "./recipients";

const thread = [
  { from: { name: "Dana Lee", address: "Dana@Example.com" }, to: [{ address: "me@example.com" }], cc: [{ address: "sam@example.com" }] },
  { from: { address: "me@example.com" }, replyTo: { address: "desk@example.com" }, to: [{ address: "dana@example.com" }], cc: [] },
];

describe("a draft's recipients against its thread", () => {
  it("tells nothing when every recipient is on the thread and there is no bcc", () => {
    const found = strangers({ to: [{ address: "dana@example.com" }], cc: [{ address: "SAM@example.com" }, { address: "desk@example.com" }], bcc: [] }, thread);
    expect(found).toEqual({ outside: [], bcc: [] });
    expect(strangersLine(found)).toBeNull();
  });

  it("names an address not on the thread, even under a name that is, and any bcc", () => {
    const found = strangers({ to: [{ name: "Dana Lee", address: "dana@elsewhere.example" }], cc: [], bcc: [{ address: "x@example.org" }] }, thread);
    expect(strangersLine(found)).toBe("Not on this thread: dana@elsewhere.example. Bcc: x@example.org.");
  });

  it("for a new mail tells only a bcc", () => {
    expect(strangersLine(strangers({ to: [{ address: "a@b.c" }], cc: [], bcc: [] }, null))).toBeNull();
    expect(strangersLine(strangers({ to: [{ address: "a@b.c" }], cc: [], bcc: [{ address: "d@e.f" }] }, null))).toBe("Bcc: d@e.f.");
  });
});
