import { afterEach, describe, expect, it } from "vitest";
import { newSession, type Session } from "../session";
import "../approvalToast";
import { sessionStore } from "./store";

const session = (id: string, over: Partial<Session> = {}): Session => ({ ...newSession("local", "claude", "/repo"), id, ...over });

afterEach(() => sessionStore.reset());

describe("the pending-approval index", () => {
  it("reads only the open sessions that changed since its last read", () => {
    sessionStore.mutate(Array.from({ length: 30 }, (_, i) => session(`s${i}`)));
    expect(sessionStore.approvalVisits).toBe(30);
    sessionStore.mutate((prev) => prev.map((s) => (s.id === "s4" ? { ...s, title: "moved" } : s)));
    expect(sessionStore.approvalVisits).toBe(1);
    sessionStore.patch("s9", { title: "also moved" });
    expect(sessionStore.approvalVisits).toBe(1);
  });
});
