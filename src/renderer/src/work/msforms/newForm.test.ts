import { describe, expect, it } from "vitest";
import { ELSEWHERE_LIBRARY, formFolderOf, formKindsFor, twinOf } from "./newForm";

describe("New → Form", () => {
  it("offers our form alone in the workspace's own folder", () => {
    expect(formKindsFor({ kind: "folder" }, { sameHost: true, offered: true }).kinds).toEqual(["tempcode"]);
  });
  it("offers both in a Teams or OneDrive library of a host with the box browser", () => {
    expect(formKindsFor({ kind: "teams" }, { sameHost: true, offered: true }).kinds).toEqual(["microsoft", "tempcode"]);
    expect(formKindsFor({ kind: "onedrive" }, { sameHost: true, offered: true }).kinds).toEqual(["microsoft", "tempcode"]);
  });
  it("offers our form alone where the host has no box browser", () => {
    expect(formKindsFor({ kind: "teams" }, { sameHost: true, offered: false })).toEqual({ kinds: ["tempcode"] });
  });
  it("offers none in LifeOS or a lens", () => {
    expect(formKindsFor({ kind: "lifeos" }, { sameHost: true, offered: true })).toEqual({ kinds: [] });
    expect(formKindsFor({ kind: "recent" }, { sameHost: true, offered: true })).toEqual({ kinds: [] });
  });
  it("offers a Microsoft form in another computer's library the box also holds", () => {
    expect(formKindsFor({ kind: "teams" }, { sameHost: false, offered: true, twin: true })).toEqual({ kinds: ["microsoft"] });
  });
  it("refuses, with its line and before any ask, another computer's library the box does not hold", () => {
    expect(formKindsFor({ kind: "teams" }, { sameHost: false, offered: true, twin: false })).toEqual({ kinds: [], refused: ELSEWHERE_LIBRARY });
    expect(formKindsFor({ kind: "folder" }, { sameHost: false, offered: true })).toEqual({ kinds: [] });
  });
});

describe("a form in another computer's library", () => {
  const ok = { state: "ok" } as const;
  const mac = { link: "env_mac", place: { kind: "teams" as const, state: ok, root: { at: "file" as const, host: "env_mac", path: "/Users/l/Library/CloudStorage/OneDrive-Purdue/RecWell - Documents" } } };
  const vm = { link: "env_box", place: { kind: "teams" as const, state: ok, root: { at: "file" as const, host: "env_box", path: "C:\\Users\\tcuser\\purdue.edu\\RecWell - Documents" } } };

  it("finds the box's copy of the same library, and none asleep or broken", () => {
    expect(twinOf([mac, vm], mac, "env_box")).toBe(vm);
    expect(twinOf([vm], vm, "env_box")).toBe(vm);
    expect(twinOf([mac, { ...vm, place: { ...vm.place, state: { state: "unreachable" } } }], mac, "env_box")).toBeNull();
    expect(twinOf([mac], mac, "env_box")).toBeNull();
  });

  it("names the same folder in the box's copy", () => {
    const at = { at: "file" as const, host: "env_mac", path: `${mac.place.root.path}/Esports/TempCode proof` };
    expect(formFolderOf(at, mac, vm)).toEqual({ at: "file", host: "env_box", path: "C:\\Users\\tcuser\\purdue.edu\\RecWell - Documents\\Esports\\TempCode proof" });
    expect(formFolderOf(mac.place.root, mac, vm)).toEqual(vm.place.root);
  });

  it("names nothing for a folder outside the shown copy", () => {
    expect(formFolderOf({ at: "file", host: "env_mac", path: "/Users/l/Desktop" }, mac, vm)).toBeNull();
    expect(formFolderOf({ at: "file", host: "env_mac", path: `${mac.place.root.path} 2` }, mac, vm)).toBeNull();
  });
});
