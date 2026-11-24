import { describe, expect, it, vi } from "vitest";
import { askDesktop, DESK, deskHosts, desktopsFor, unsearchedLine, type Desktops } from "./desktops";

/** His shape: the job lives on the box; it may use his Mac (this window's own machine) and a PC only the box reaches. */
const deps = {
  settings: async () => ({ mayUseDesktop: ["env_mac", "env_pc", "env_box"] }),
  local: async () => "env_mac",
  linkOf: (host: string, local: string | null) => (host === "env_box" ? "env_box" : host === local ? "local" : null),
  connected: () => true,
  nameOf: (link: string) => ({ local: "This Mac", env_box: "the box", env_pc: "Purdue laptop" })[link],
};
const WS = [{ id: "ws", environmentId: "env_box" }];
const DESKS: Desktops = { linked: [{ link: "local", host: "env_mac", name: "This Mac", workspaceId: "ws" }], far: ["Purdue laptop"] };
const entry = (name: string, kind = "deck") => ({ name, path: `/Users/l/Library/CloudStorage/OneDrive-SharedLibraries-Org/Staff - Documents/General/${name}`, library: "lib1", kind, size: 10, modified: 5, local: true, by: null }) as never;

describe("his other computers' folders in a search of files", () => {
  it("sorts a job's desktops into the ones this window can ask and the ones it cannot; the job's own host is neither", async () => {
    expect(await desktopsFor(WS, deps)).toEqual(DESKS);
    // A desktop whose link is down is not asked, and is named.
    expect(await desktopsFor(WS, { ...deps, connected: (link) => link !== "local" })).toEqual({ linked: [], far: ["This Mac", "Purdue laptop"] });
  });

  it("names what was not searched in one line", () => {
    expect(unsearchedLine([])).toBeNull();
    expect(unsearchedLine(["Purdue laptop"])).toBe("Folders on Purdue laptop were not searched.");
    expect(unsearchedLine(["This Mac", "Purdue laptop", "another computer"])).toBe("Folders on This Mac, Purdue laptop and another computer were not searched.");
  });

  it("asks a desktop nothing as he types, and walks its folders only when files are asked alone", async () => {
    const ask = vi.fn(async () => ({ entries: [entry("Kickoff.pptx"), entry("Kickoff", "folder")], more: false }));
    const host = `${DESK}local`;
    expect(deskHosts(DESKS)).toEqual([{ id: host, name: "This Mac", home: false, workspaceId: "ws" }]);
    // Every kind, as he types: nothing asked, nothing offered.
    expect(await askDesktop(DESKS, host, { text: "kickoff", tier: "instant" }, ask)).toEqual({ groups: [], pending: [], quiet: [], searched: 0 });
    // Files alone: the walk is offered as one source, asked after his last key like any network source.
    expect(await askDesktop(DESKS, host, { text: "kickoff", kind: "file", tier: "instant" }, ask)).toMatchObject({ pending: [{ source: "desktop.file", kind: "file" }] });
    expect(ask).not.toHaveBeenCalled();
    const found = await askDesktop(DESKS, host, { text: "kickoff", kind: "file", sources: ["desktop.file"] }, ask);
    expect(ask).toHaveBeenCalledWith("local", "work.office.filesSearch", { query: "kickoff" }, { timeoutMs: 20_000 });
    // The file, as a row that opens in the job's Files as a copy from that computer; the folder is left out.
    expect(found.groups[0]!.hits).toMatchObject([
      { kind: "file", title: "Kickoff.pptx", detail: "This Mac › General", workspaceId: "ws", open: { to: "file", name: "Kickoff.pptx", ref: { at: "file", host: "env_mac" } } },
    ]);
    expect(found.searched).toBe(1);
  });
});
