// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const drawn = vi.hoisted(() => ({ sections: [] as { title: string; editable: boolean; vm: boolean; elsewhere?: string; setting?: string }[] }));
vi.mock("../../components/choice-select", async () => await import("../../components/choice-select-body"));
vi.mock("../../lib/connection", () => ({
  LOCAL_ENVIRONMENT_ID: "local",
  registry: { linkOf: () => null },
  useEnvironments: () => [
    { id: "local", name: "MacBook Pro", platform: "darwin" },
    { id: "env_box", name: "The box", platform: "linux" },
    { id: "env_pc", name: "PURDUE-LT", platform: "win32" },
  ],
}));
vi.mock("../../lib/workSwitch", () => ({ useWorkHosts: () => new Set(["local", "env_box", "env_pc"]) }));
vi.mock("../../lib/settings/computerName", () => ({
  useComputerNames: () => (id: string) => ({ name: id === "local" ? "MacBook Pro" : id === "env_box" ? "The box" : "PURDUE-LT", own: id === "local" }),
  computerInLine: (c: { name: string; own: boolean }) => (c.own ? "this Mac" : c.name === "The box" ? "the box" : c.name),
}));
vi.mock("../office/TeamsFilesRow", () => ({
  TeamsFilesRow: (props: { title: string; editable: boolean; vm?: boolean; elsewhere?: string; setting?: string }) => {
    drawn.sections.push({ title: props.title, editable: props.editable, vm: !!props.vm, elsewhere: props.elsewhere, setting: props.setting });
    return null;
  },
}));
vi.mock("../guests/GuestLinksSection", () => ({ GuestLinksRow: ({ hosts }: { hosts: string[] }) => <div data-guest-hosts={hosts.join(",")} /> }));
vi.mock("../../lib/nativeWeb", () => ({ isWebMode: () => false }));

const { FilesPage } = await import("./WorkPageFiles");

afterEach(() => {
  cleanup();
  drawn.sections = [];
});

describe("Settings → Files", () => {
  it("draws a section a desktop computer and one for the Windows VM, each written by its own computer's window alone", () => {
    render(<FilesPage />);
    const seen = new Map(drawn.sections.map((s) => [`${s.title}|${s.vm}`, s]));
    expect(seen.get("Folders on this Mac|false")).toMatchObject({ editable: true, setting: "files.folders" });
    expect(seen.get("Folders on PURDUE-LT|false")).toMatchObject({ editable: false, elsewhere: "Changed in Docket on PURDUE-LT" });
    expect(seen.get("Folders in the Windows VM|true")).toMatchObject({ editable: false, elsewhere: "Changed in Docket on the box", setting: "files.vm" });
    // The box is no desktop: it draws no folders of its own.
    expect(seen.has("Folders on the box|false")).toBe(false);
  });

  it("lists every Work computer's guest links behind one row, and this Mac's Word files row", () => {
    render(<FilesPage />);
    expect(document.querySelector("[data-guest-hosts]")!.getAttribute("data-guest-hosts")).toBe("local,env_box,env_pc");
    expect(screen.getByText("On this Mac")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Word files save to Teams" }).textContent).toContain("Ask the first time");
  });
});
