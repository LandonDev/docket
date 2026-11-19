import { describe, expect, it } from "vitest";
import type { BrowserState } from "@shared/contract-work-browser";
import type { OutboxItem } from "@shared/contract-work-outbox";
import { barFaceOf, fieldsOfMark, heldSubmitOf, portalValues, siteHost } from "./portal";

const MARK = JSON.stringify([
  "com.google.Chrome",
  ["textField|Hotel|$389.20", "textField|Mileage|$184.20", "textField|Meals|$39.04", "textField|Notes|", "textField||orphan", "textArea|Purpose|Nationals | travel"],
]);
const state = (patch: Partial<BrowserState> = {}): BrowserState => ({ sessionId: "t1", driver: "agent", needs: null, site: { url: "https://us2.concursolutions.com/report", name: "Concur" }, sources: [], since: 100, ...patch });
const act = (patch: Partial<OutboxItem>): OutboxItem =>
  ({ ref: { at: "host", id: "h1" }, kind: "computer.act", sessionId: "t1", workspaceId: "w", sector: null, summary: "Click Submit Report in Chrome", verb: "Submit Report", account: null, state: "live", payload: { app: { name: "Google Chrome", bundleId: "com.google.Chrome" }, label: "Submit Report", mark: MARK }, createdAt: 200, decidedBy: null, decidedAt: null, n: 1, why: "screen", grantId: null, error: null, result: null, routineRunId: null, updatedAt: 200, ...patch }) as OutboxItem;

describe("the page's values", () => {
  it("are the fields the host read off the page, in its order, leaving out empty and unlabelled ones", () => {
    expect(fieldsOfMark(MARK)).toEqual([
      { label: "Hotel", value: "$389.20" },
      { label: "Mileage", value: "$184.20" },
      { label: "Meals", value: "$39.04" },
      { label: "Purpose", value: "Nationals | travel" },
    ]);
    expect(fieldsOfMark("not json")).toEqual([]);
    expect(fieldsOfMark(JSON.stringify(["app", "nope"]))).toEqual([]);
  });

  it("carry the agent's source by the field's label, whatever its case, and none where it named none", () => {
    expect(portalValues(MARK, [{ field: "hotel", source: "Hilton folio.pdf, page 1" }, { field: "Not on the page", source: "x" }]).slice(0, 2)).toEqual([
      { label: "Hotel", value: "$389.20", source: "Hilton folio.pdf, page 1" },
      { label: "Mileage", value: "$184.20", source: null },
    ]);
  });
});

describe("the held submit", () => {
  const tree = new Set(["t1", "t1-sub"]);
  it("is the newest waiting computer act of the thread's tree, a subagent's included", () => {
    const items = [act({ ref: { at: "host", id: "a" }, createdAt: 1 }), act({ ref: { at: "host", id: "b" }, sessionId: "t1-sub", createdAt: 5 }), act({ ref: { at: "host", id: "c" }, sessionId: "other", createdAt: 9 })];
    expect(heldSubmitOf(items, tree, 0)?.ref).toEqual({ at: "host", id: "b" });
  });
  it("after the press, is the one decided since the site was opened, never an older one or a stale one", () => {
    expect(heldSubmitOf([act({ state: "sent", decidedAt: 300 })], tree, 100)?.state).toBe("sent");
    expect(heldSubmitOf([act({ state: "sent", decidedAt: 50 })], tree, 100)).toBeNull();
    expect(heldSubmitOf([act({ state: "stale", decidedAt: 300 })], tree, 100)).toBeNull();
  });
});

describe("the bar", () => {
  it("names the one primary for the act and the site while a submit waits, whoever drives", () => {
    expect(barFaceOf(state(), act({}))).toMatchObject({ face: "held", act: "Submit Report in Concur" });
    expect(barFaceOf(state({ site: null }), act({}))).toMatchObject({ face: "held", act: "Submit Report in Google Chrome" });
    expect(barFaceOf(state({ driver: "owner" }), act({ state: "held" }))).toMatchObject({ face: "held" });
  });
  it("says who drives, and a page that needs him, once nothing waits", () => {
    expect(barFaceOf(null, null)).toEqual({ face: "loading" });
    expect(barFaceOf(state(), null)).toEqual({ face: "agent" });
    expect(barFaceOf(state({ driver: "owner" }), null)).toEqual({ face: "owner" });
    expect(barFaceOf(state({ needs: "Concur wants you to sign in" }), null)).toEqual({ face: "needs", words: "Concur wants you to sign in" });
  });
  it("says how the submit ended", () => {
    expect(barFaceOf(state(), act({ state: "sent", decidedAt: new Date(2026, 10, 19, 14, 14).getTime() }))).toMatchObject({ face: "done", words: expect.stringMatching(/^Submitted 2:14/) });
    expect(barFaceOf(state(), act({ state: "discarded", decidedAt: 1 }))).toEqual({ face: "done", words: "Left without submitting" });
  });
  it("shows the site's host, never a field", () => {
    expect(siteHost(state())).toBe("us2.concursolutions.com");
    expect(siteHost(state({ site: null }))).toBeNull();
  });
});
