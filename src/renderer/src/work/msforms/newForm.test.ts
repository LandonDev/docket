import { describe, expect, it } from "vitest";
import { formKindsFor } from "./newForm";

describe("New → Form", () => {
  it("offers our form alone in the workspace's own folder", () => {
    expect(formKindsFor({ kind: "folder" }, { sameHost: true, offered: true })).toEqual(["tempcode"]);
  });
  it("offers both in a Teams or OneDrive library of a host with the box browser", () => {
    expect(formKindsFor({ kind: "teams" }, { sameHost: true, offered: true })).toEqual(["microsoft", "tempcode"]);
    expect(formKindsFor({ kind: "onedrive" }, { sameHost: true, offered: true })).toEqual(["microsoft", "tempcode"]);
  });
  it("offers our form alone where the host has no box browser", () => {
    expect(formKindsFor({ kind: "teams" }, { sameHost: true, offered: false })).toEqual(["tempcode"]);
  });
  it("offers none in a place of another computer, LifeOS or a lens", () => {
    expect(formKindsFor({ kind: "teams" }, { sameHost: false, offered: true })).toEqual([]);
    expect(formKindsFor({ kind: "lifeos" }, { sameHost: true, offered: true })).toEqual([]);
    expect(formKindsFor({ kind: "recent" }, { sameHost: true, offered: true })).toEqual([]);
  });
});
