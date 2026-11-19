// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TeamsLibrary, TeamsRoot } from "@shared/contract-work-office";
import type { Link } from "../../lib/connection/link";
import { libraryTitle, TeamsFilesRow, withRoot } from "./TeamsFilesRow";

afterEach(cleanup);

const FOUND: TeamsLibrary = { id: "h~1", host: "h", path: "/c/S/Purdue Esports - Documents", team: "Purdue Esports", library: null, tenant: "Purdue University", kind: "channels", channels: [], web: null, found: true };

/** A host that keeps his list as filesSetRoots leaves it. */
function fakeHost() {
  let roots: TeamsRoot[] = [];
  const calls: { method: string; params: unknown }[] = [];
  const state = () => ({ libraries: roots.some((r) => r.folder === FOUND.path && r.off) ? [] : [{ ...FOUND, web: roots.find((r) => r.folder === FOUND.path)?.web ?? null }], roots, off: roots.filter((r) => r.off).map((r) => r.folder) });
  const link = {
    connected: true,
    onOpen: () => () => {},
    request: (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "work.office.filesSetRoots") roots = (params as { roots: TeamsRoot[] }).roots;
      return Promise.resolve(state());
    },
  } as unknown as Link;
  return { link, calls };
}

describe("Teams files in Settings", () => {
  it("lists each library found, by team, with its folder", async () => {
    const { link } = fakeHost();
    await act(async () => void render(<TeamsFilesRow link={link} title="Teams files" editable />));
    expect(screen.getByText("Purdue Esports")).toBeTruthy();
    expect(screen.getByText(FOUND.path)).toBeTruthy();
  });

  it("turns a found folder off and on again", async () => {
    const { link, calls } = fakeHost();
    await act(async () => void render(<TeamsFilesRow link={link} title="Teams files" editable />));
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Purdue Esports" })));
    expect(calls.at(-1)).toEqual({ method: "work.office.filesSetRoots", params: { roots: [{ folder: FOUND.path, off: true }] } });
    await act(async () => fireEvent.click(screen.getByRole("switch")));
    expect(calls.at(-1)).toEqual({ method: "work.office.filesSetRoots", params: { roots: [{ folder: FOUND.path }] } });
  });

  it("gives a folder its web link through a dialog", async () => {
    const { link, calls } = fakeHost();
    await act(async () => void render(<TeamsFilesRow link={link} title="Teams files" editable />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add web link…" })));
    fireEvent.change(screen.getByLabelText("Link"), { target: { value: "https://p.sharepoint.com/sites/e/Shared Documents" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(calls.filter((c) => c.method === "work.office.filesSetRoots").at(-1)!.params).toEqual({ roots: [{ folder: FOUND.path, web: "https://p.sharepoint.com/sites/e/Shared Documents" }] });
    expect(await screen.findByRole("button", { name: "Web link…" })).toBeTruthy();
  });

  it("is read only from another computer's window", async () => {
    const { link } = fakeHost();
    await act(async () => void render(<TeamsFilesRow link={link} title="Teams files on The box" editable={false} />));
    expect(screen.queryByRole("button", { name: "Add folder…" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("keeps one row per folder and drops one that says nothing more", () => {
    expect(withRoot([{ folder: "/a", off: true }], "/a", { off: false })).toEqual([{ folder: "/a" }]);
    expect(withRoot([{ folder: "/a", web: "https://x" }], "/a", null)).toEqual([]);
    expect(libraryTitle({ kind: "library", team: "RecWell", library: "Site Policies" })).toBe("RecWell Site Policies");
  });
});
