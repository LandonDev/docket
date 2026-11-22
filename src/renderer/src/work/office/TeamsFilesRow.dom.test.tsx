// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  // A folder he added himself is a library the host did not find.
  const added = (): TeamsLibrary[] => roots.filter((r) => r.folder !== FOUND.path && !r.off).map((r) => ({ ...FOUND, id: `h~${r.folder}`, path: r.folder, team: r.folder.split("/").pop()!, found: false }));
  const state = () => ({
    libraries: [...(roots.some((r) => r.folder === FOUND.path && r.off) ? [] : [{ ...FOUND, web: roots.find((r) => r.folder === FOUND.path)?.web ?? null }]), ...added()],
    roots,
    off: roots.filter((r) => r.off).map((r) => r.folder),
  });
  const host = { refuse: null as string | null };
  const link = {
    connected: true,
    onOpen: () => () => {},
    request: (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "work.office.filesSetRoots") {
        if (host.refuse) return Promise.reject(new Error(host.refuse));
        roots = (params as { roots: TeamsRoot[] }).roots;
      }
      return Promise.resolve(state());
    },
  } as unknown as Link;
  return { link, calls, host };
}

describe("Teams files in Settings", () => {
  it("names a found library by its team, its folder in the row's tip; a folder he added shows its path", async () => {
    const { link } = fakeHost();
    await act(async () => void render(<TeamsFilesRow link={link} title="Teams files" editable />));
    const tip = screen.getByText("Purdue Esports").closest("[data-library-path]")!;
    expect(tip.getAttribute("data-library-path")).toBe(FOUND.path);
    // The keyboard reaches the path too: focus opens the tip as hover does.
    expect(tip.getAttribute("tabindex")).toBe("0");
    expect(tip.className).toContain("focus-ring");
    expect(screen.queryByText(FOUND.path)).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add folder…" })));
    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "/c/S/RecWell - Site Policies" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add" })));
    expect(await screen.findByText("/c/S/RecWell - Site Policies")).toBeTruthy();
  });

  it("keeps what is shown when a dialog closes: no skeleton, a fresh read after Cancel, none after a save", async () => {
    const { link, calls } = fakeHost();
    await act(async () => void render(<TeamsFilesRow link={link} title="Teams files" editable />));
    const reads = () => calls.filter((c) => c.method === "work.office.filesLibraries").length;
    const before = reads();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add web link…" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    // The rows stay while the host is asked again.
    expect(screen.getByText("Purdue Esports")).toBeTruthy();
    await waitFor(() => expect(reads()).toBe(before + 1));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add web link…" })));
    fireEvent.change(screen.getByLabelText("Link"), { target: { value: "https://p.sharepoint.com/x" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    await screen.findByRole("button", { name: "Web link…" });
    expect(reads()).toBe(before + 1);
  });

  it("says a dialog's failed save in the dialog alone, and forgets it when the dialog closes", async () => {
    const { link, host } = fakeHost();
    await act(async () => void render(<TeamsFilesRow link={link} title="Teams files" editable />));
    host.refuse = "That folder is not on this Mac";
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add folder…" })));
    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "/nowhere" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add" })));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("That folder is not on this Mac")).toBeTruthy();
    expect(screen.getAllByText("That folder is not on this Mac")).toHaveLength(1);
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("That folder is not on this Mac")).toBeNull();
    // Open again: the old error is gone.
    host.refuse = null;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add folder…" })));
    expect(screen.queryByText("That folder is not on this Mac")).toBeNull();
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

describe("a host's row with nothing synced", () => {
  it("says OneDrive is not signed in there when its folders say so, else none synced", async () => {
    const { noneLine } = await import("./TeamsFilesRow");
    expect(noneLine([{ kind: "folders", state: "no-onedrive", account: null }])).toBe("OneDrive is not signed in here");
    expect(noneLine([{ kind: "folders", state: "no-libraries", account: "a@b" }])).toBe("None synced");
    expect(noneLine(undefined)).toBe("None synced");
  });
});
