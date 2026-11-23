import { describe, expect, it } from "vitest";
import type { CanvasShell, MoreEntry } from "../canvas/kind";
import { feedMore } from "./more";

const entry = (id: string): MoreEntry => ({ id, label: id, run() {} });

describe("the deck's rows of the pane's More", () => {
  it("gives the shell every place's rows as one list, by the places' names, and takes a place's rows away alone", () => {
    const got: Array<string[] | null> = [];
    const shell = { more: (entries: MoreEntry[] | null) => got.push(entries ? entries.map((e) => e.id) : null) } as unknown as CanvasShell;
    feedMore(shell, "file", [entry("google-upload")]);
    feedMore(shell, "export", [entry("export")]);
    expect(got.at(-1)).toEqual(["export", "google-upload"]);
    feedMore(shell, "file", null);
    expect(got.at(-1)).toEqual(["export"]);
    feedMore(shell, "export", null);
    expect(got.at(-1)).toBeNull();
  });

  it("keeps two panes' rows apart, and does nothing for a shell with no More", () => {
    const a: string[][] = [];
    const b: string[][] = [];
    const one = { more: (entries: MoreEntry[] | null) => a.push((entries ?? []).map((e) => e.id)) } as unknown as CanvasShell;
    const two = { more: (entries: MoreEntry[] | null) => b.push((entries ?? []).map((e) => e.id)) } as unknown as CanvasShell;
    feedMore(one, "export", [entry("export")]);
    feedMore(two, "file", [entry("google-reload")]);
    expect(a.at(-1)).toEqual(["export"]);
    expect(b.at(-1)).toEqual(["google-reload"]);
    expect(() => feedMore({} as CanvasShell, "export", [entry("export")])).not.toThrow();
  });
});
