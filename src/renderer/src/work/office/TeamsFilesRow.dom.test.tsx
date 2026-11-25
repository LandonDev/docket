// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TeamsLibrary, TeamsRoot } from "@shared/contract-work-office";
import type { Link } from "../../lib/connection/link";
const picked = vi.hoisted(() => ({ path: "J:\\Shared\\Esports" as string | null }));
vi.mock("../../lib/fs", () => ({ pickFolder: async () => picked.path }));
import { folderHint, libraryTitle, TeamsFilesRow, withRoot } from "./TeamsFilesRow";

afterEach(cleanup);

const FOUND: TeamsLibrary = { id: "h~1", host: "h", path: "/c/S/Purdue Esports - Documents", team: "Purdue Esports", library: null, tenant: "Purdue University", kind: "channels", channels: [], web: null, found: true };

/** A host that keeps his list as filesSetRoots leaves it. */
function fakeHost() {
  let roots: TeamsRoot[] = [];
  const calls: { method: string; params: unknown }[] = [];
  // A folder he added himself is a library the host did not find.
  const added = (): TeamsLibrary[] => roots.filter((r) => r.folder !== FOUND.path && !r.off).map((r) => ({ ...FOUND, id: `h~${r.folder}`, path: r.folder, team: r.folder.split("/").pop()!, found: false, ...(host.slow ? { slow: host.slow } : {}) }));
  const state = () => ({
    libraries: [...(roots.some((r) => r.folder === FOUND.path && r.off) ? [] : [{ ...FOUND, web: roots.find((r) => r.folder === FOUND.path)?.web ?? null }]), ...added()],
    roots,
    off: roots.filter((r) => r.off).map((r) => r.folder),
  });
  const host = { refuse: null as string | null, opensIn: "here" as "here" | "live", slow: null as string | null };
  const link = {
    connected: true,
    onOpen: () => () => {},
    request: (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "work.office.live.setLibraryDefault") host.opensIn = (params as { mode: "here" | "live" }).mode;
      if (method.startsWith("work.office.live.")) return Promise.resolve({ mode: host.opensIn });
      if (method === "work.office.filesSetRoots") {
        if (host.refuse) return Promise.reject(new Error(host.refuse));
        roots = (params as { roots: TeamsRoot[] }).roots;
      }
      return Promise.resolve(state());
    },
  } as unknown as Link;
  return { link, calls, host };
}

describe("Folders in Settings", () => {
  it("says where each library's Office files open, Edit here until he picks Office for the web", async () => {
    const { link, calls, host } = fakeHost();
    host.opensIn = "live";
    await act(async () => void render(<TeamsFilesRow link={link} title="Folders" editable />));
    const select = await screen.findByLabelText("Where Purdue Esports's Office files open");
    expect(select.textContent).toContain("Office for the web");
    expect(calls).toContainEqual({ method: "work.office.live.libraryDefault", params: { libraryId: FOUND.id } });
  });

  it("puts a library's three controls on their own line in a narrow page, so its name keeps the row's width", async () => {
    const { link } = fakeHost();
    await act(async () => void render(<TeamsFilesRow link={link} title="Folders" editable />));
    await screen.findByLabelText("Where Purdue Esports's Office files open");
    const row = screen.getByText("Purdue Esports").closest<HTMLElement>("[data-slot=page-row]")!;
    // PageRow's wide row: under 480px of page content its controls take a full line under the name.
    expect(row.hasAttribute("data-wide")).toBe(true);
    expect(row.querySelector("[data-wide-control]")!.textContent).toContain("web link");
  });

  it("offers no choice where this window cannot edit the host's list", async () => {
    const { link } = fakeHost();
    await act(async () => void render(<TeamsFilesRow link={link} title="Folders" editable={false} />));
    expect(screen.queryByLabelText("Where Purdue Esports's Office files open")).toBeNull();
  });

  it("names a found library by its team, its folder in the row's tip; a folder he added shows its path", async () => {
    const { link } = fakeHost();
    await act(async () => void render(<TeamsFilesRow link={link} title="Folders" editable />));
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

  /** Council round 6 (Sol P3): the slow reader's reason was joined to the path with a middle dot. */
  it("says a slow folder's reason on its own line under the path", async () => {
    const { link, host } = fakeHost();
    host.slow = "Read without the folder reader, so it lists slowly";
    await act(async () => void render(<TeamsFilesRow link={link} title="Folders" editable />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add folder…" })));
    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "J:/Shared/Esports" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add" })));
    const path = await screen.findByText("J:/Shared/Esports");
    expect(path.className).toContain("block");
    expect(path.nextElementSibling?.textContent).toBe(host.slow);
    expect(path.nextElementSibling?.className).toContain("block");
    expect(document.body.textContent).not.toContain(" · ");
  });

  it("keeps what is shown when a dialog closes: no skeleton, a fresh read after Cancel, none after a save", async () => {
    const { link, calls } = fakeHost();
    await act(async () => void render(<TeamsFilesRow link={link} title="Folders" editable />));
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
    await act(async () => void render(<TeamsFilesRow link={link} title="Folders" editable />));
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
    await act(async () => void render(<TeamsFilesRow link={link} title="Folders" editable />));
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Purdue Esports" })));
    expect(calls.at(-1)).toEqual({ method: "work.office.filesSetRoots", params: { roots: [{ folder: FOUND.path, off: true }] } });
    await act(async () => fireEvent.click(screen.getByRole("switch")));
    expect(calls.filter((c) => c.method === "work.office.filesSetRoots").at(-1)).toEqual({ method: "work.office.filesSetRoots", params: { roots: [{ folder: FOUND.path }] } });
  });

  it("gives a folder its web link through a dialog", async () => {
    const { link, calls } = fakeHost();
    await act(async () => void render(<TeamsFilesRow link={link} title="Folders" editable />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add web link…" })));
    fireEvent.change(screen.getByLabelText("Link"), { target: { value: "https://p.sharepoint.com/sites/e/Shared Documents" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(calls.filter((c) => c.method === "work.office.filesSetRoots").at(-1)!.params).toEqual({ roots: [{ folder: FOUND.path, web: "https://p.sharepoint.com/sites/e/Shared Documents" }] });
    expect(await screen.findByRole("button", { name: "Web link…" })).toBeTruthy();
  });

  it("heads its host's folders as a section, Add folder… at the heading's end, and says a raw failure in his words", async () => {
    const { link, host } = fakeHost();
    await act(async () => void render(<TeamsFilesRow link={link} title="Folders on MacBook Pro" host="MacBook Pro" editable />));
    const section = screen.getByRole("region", { name: "Folders on MacBook Pro" });
    // Its box ends on the column's edge as the Remove presses' do, so their words end on one edge (Opus round 3 P3).
    expect(within(section).getByRole("button", { name: "Add folder…" }).className).not.toMatch(/-me-|-mr-/);
    host.refuse = "work.office.filesSetRoots: EIO at /Users/landon/.tc";
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Purdue Esports" })));
    expect(screen.getByText("MacBook Pro did not save the folders.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("filesSetRoots");
  });

  /** Sol round 4 P3: Remove's words end on the box's edge, where Add folder…'s end, the spinner's room kept at the start. */
  it("ends Remove's words on its box's edge, as Add folder…'s are", async () => {
    const { link } = fakeHost();
    await act(async () => void render(<TeamsFilesRow link={link} title="Folders" editable />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add folder…" })));
    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "/c/S/Scrims" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add" })));
    const remove = await screen.findByRole("button", { name: "Remove" });
    expect(remove.querySelector(".justify-end")?.textContent).toBe("Remove");
    expect(remove.querySelector(".justify-center")).toBeNull();
  });

  it("is read only from another computer's window", async () => {
    const { link } = fakeHost();
    await act(async () => void render(<TeamsFilesRow link={link} title="Folders on The box" editable={false} />));
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

describe("Add a folder", () => {
  it("hints a mapped drive on Windows and a home folder elsewhere", () => {
    expect(folderHint("win32")).toBe("J:\\Shared");
    expect(folderHint("darwin")).toBe("~/Documents/…");
  });

  it("fills the field from the system's folder picker, and adds that folder", async () => {
    const { link, calls } = fakeHost();
    await act(async () => void render(<TeamsFilesRow link={link} title="Folders" editable />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add folder…" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Browse…" })));
    expect((screen.getByLabelText("Folder") as HTMLInputElement).value).toBe("J:\\Shared\\Esports");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add" })));
    expect(calls.some((c) => c.method === "work.office.filesSetRoots" && JSON.stringify(c.params).includes("Esports"))).toBe(true);
  });
});
