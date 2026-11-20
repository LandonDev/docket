import { describe, expect, it } from "vitest";
import { filePlaceOf, type FileLook } from "./openFilePlace";

/** t1 a Work thread, c1 a code thread, d1 a Work workspace's draft, d2 a code workspace's, d3 a Work Chat's, p1 a tab still loading. */
const look: FileLook = {
  meta: (id) => ({ t1: { scope: "work" }, c1: { scope: null } })[id] ?? null,
  draft: (id) => ({ d1: { workspaceId: "w-work" }, d2: { workspaceId: "w-code" }, d3: { scope: "work" as const, workspaceId: null }, p1: { scope: "work" as const } })[id],
  provisional: (id) => id === "p1",
  workspaceKind: (id) => (id === "w-work" ? "work" : "code"),
};

describe("where Open File… opens", () => {
  it("a Work view in front starts a new thread, whatever is focused", () => {
    expect(filePlaceOf("c1", true, look)).toEqual({ at: "new" });
  });

  it("else the focused Work thread or Work draft; never a code thread, a code draft or a tab still loading", () => {
    expect(filePlaceOf("t1", false, look)).toEqual({ at: "thread", sessionId: "t1" });
    expect(filePlaceOf("d1", false, look)).toEqual({ at: "draft", sessionId: "d1" });
    expect(filePlaceOf("d3", false, look)).toEqual({ at: "draft", sessionId: "d3" });
    for (const id of ["c1", "d2", "p1", "gone"]) expect(filePlaceOf(id, false, look)).toBeNull();
    expect(filePlaceOf(null, false, look)).toBeNull();
  });
});
