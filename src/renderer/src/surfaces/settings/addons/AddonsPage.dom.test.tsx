// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddonGrantView } from "@shared/contract-addonGrants";
import type { AddonRow, AddonStatus } from "@shared/contract-addons";
import { fakeStoreHost, type FakeStoreHost } from "../storeHost.testkit";

vi.mock("../../../lib/settings/computerName", async (original) => {
  const real = await original<typeof import("../../../lib/settings/computerName")>();
  const own = { name: "MacBook Pro", own: true };
  return {
    ...real,
    useComputerName: () => own,
    useComputerNames: () => (id: string) => (id === "local" ? own : { name: "The box", own: false }),
    useReadFailWords: () => (error: string) => real.readFailWords(error, own),
  };
});
vi.mock("../../../components/choice-select", async () => await import("../../../components/choice-select-body"));
vi.mock("../../../lib/sounds", () => ({ playCue: () => {} }));
const keyMay = vi.hoisted(() => ({ write: true }));
vi.mock("../parts/hostRpc", () => ({ useHost: () => ({ may: () => keyMay.write, name: { name: "The box", own: false } }) }));
vi.mock("../../../lib/connection/status", () => ({ useEnvironmentStatuses: () => new Map() }));
vi.mock("../../../lib/connection", () => ({ registry: { primary: () => null } }));
vi.mock("../../../lib/tcserver/workspaces", () => ({ useWorkspaces: () => [{ id: "ws_1", name: "temp-code", environmentId: "local" }] }));

const { AddonsBody } = await import("./AddonsPage");
const { Page } = await import("../../../components/page");
const { ConfirmHost } = await import("../../../chrome/ConfirmDialog");
const { menuChunk } = await import("../../chunks");
const { warmMenus } = await import("../../../chrome/menuRows");
const { NO_ANSWER } = await import("../../../lib/connection/openRead");
const { asWebPage } = await import("../../../test/webMode");

beforeAll(async () => {
  await menuChunk.load();
  warmMenus();
});
afterEach(cleanup);

const base = (over: Partial<AddonRow>): AddonRow => ({
  id: `ad_${over.name}`,
  name: "x",
  workspaceId: null,
  description: "",
  spec: { transport: "stdio", command: "npx", args: [], env: [], auth: "none" },
  enabled: true,
  addedBy: { kind: "person" },
  writtenBy: { kind: "person" },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const github = base({ name: "github", spec: { transport: "stdio", command: "npx", args: ["server-github"], env: ["GITHUB_TOKEN"], auth: "fields" }, writtenBy: { kind: "thread", sessionId: "s1", environmentId: "local", title: "Fix the build" } });
const mobbin = base({ name: "mobbin", spec: { transport: "http", url: "https://api.mobbin.com/mcp", headers: [], auth: "oauth" } });
const slack = base({ name: "slack", workspaceId: "ws_1", spec: { transport: "http", url: "https://slack.example/mcp", headers: ["X-Api-Key"], auth: "fields" } });
const local = base({ name: "local", enabled: false });
const at = (state: AddonStatus["state"], over: Partial<AddonStatus> = {}): AddonStatus => ({ state, tools: 0, at: 1, ...over });
const STATUS: Record<string, AddonStatus> = {
  [github.id]: at("ready", { tools: 24 }),
  [mobbin.id]: at("failed", { detail: "Disconnected: socket hang up" }),
  [slack.id]: at("needs-grant", { detail: "Needs values for X-Api-Key" }),
  [local.id]: at("off"),
};
const GRANTS: AddonGrantView[] = [
  { addonId: github.id, fields: [{ name: "GITHUB_TOKEN", set: true }], oauth: null, signIn: null, gaps: [] },
  { addonId: mobbin.id, fields: [], oauth: { signedIn: true, expiresAt: null, refreshedBy: "box", refused: false }, signIn: null, gaps: [] },
];
const seeded = () => fakeStoreHost({ addons: [github, mobbin, slack, local], status: STATUS, grants: GRANTS });

const flush = () => act(async () => {});
async function show(host: FakeStoreHost) {
  render(
    <>
      <Page title="Add-ons">
        <AddonsBody link={host.link} />
      </Page>
      <ConfirmHost />
    </>,
  );
  await flush();
}
const rowOf = (name: string) => document.querySelector<HTMLElement>(`[data-addon="${name}"]`)!;
async function menu(name: string) {
  await act(async () => fireEvent.click(screen.getByRole("button", { name: `${name} actions` })));
  return screen.findByRole("menu");
}
const item = (m: HTMLElement, name: string) => within(m).getByRole("menuitem", { name });

describe("Settings → Add-ons", () => {
  it("draws rows in their shape while the host is silent", async () => {
    const host = seeded();
    host.state.silent.add("addons.list");
    await show(host);
    const skeleton = document.querySelectorAll("[data-slot=page-row-skeleton]");
    expect(skeleton).toHaveLength(3);
    expect(skeleton[0]!.getAttribute("data-control")).toBe("switch");
    // Nothing is offered before the list has read.
    expect(screen.queryByRole("button", { name: "Add…" })).toBeNull();
  });

  it("says the host did not answer with Retry, and Retry lands the rows", async () => {
    const host = seeded();
    host.state.refuse.set("addons.list", NO_ANSWER);
    await show(host);
    expect(screen.getByRole("alert").textContent).toBe("This Mac did not answer.");
    host.state.refuse.delete("addons.list");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(rowOf("github")).toBeTruthy();
  });

  it("says No add-ons for an empty host", async () => {
    await show(fakeStoreHost());
    expect(screen.getByText("No add-ons")).toBeTruthy();
  });

  it("says each row's state, its own workspace and its grant in plain words, sorted by name", async () => {
    await show(seeded());
    expect([...document.querySelectorAll("[data-addon]")].map((r) => r.getAttribute("data-addon"))).toEqual(["github", "local", "mobbin", "slack"]);
    expect(rowOf("github").textContent).toContain("Connected24 tools");
    expect(rowOf("github").textContent).toContain("Key saved");
    // No secret's name, no builder's sentence, no thread named beside a key.
    expect(rowOf("github").textContent).not.toContain("GITHUB_TOKEN");
    expect(rowOf("github").textContent).not.toContain("written by");
    // Not connected with its reason, and the stored sign-in as a fact, never a second live state.
    expect(rowOf("mobbin").textContent).toContain("Not connectedSocket hang up");
    expect(rowOf("mobbin").textContent).not.toContain("Disconnected");
    expect(rowOf("mobbin").textContent).toContain("Sign-in saved");
    expect(rowOf("mobbin").textContent).not.toContain("Signed in");
    expect(rowOf("mobbin").textContent).not.toContain("refreshed on");
    expect(rowOf("slack").textContent).toContain("Needs a key");
    expect(rowOf("slack").textContent).not.toContain("X-Api-Key");
    expect(rowOf("slack").textContent).toContain("temp-code");
    // Off is the switch's to say; every workspace is the list's rule, said on no row.
    expect(rowOf("local").textContent).not.toContain("Off");
    expect(screen.getByRole("switch", { name: "local" }).getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).not.toContain("Every workspace");
  });

  it("tells the page's line where the one copy is kept", async () => {
    const { usePageHome } = await import("../../../lib/settings/pageHome");
    let seen: unknown;
    function Probe() {
      seen = usePageHome("addons");
      return null;
    }
    const host = seeded();
    host.state.home = { name: "box", online: true };
    render(<Probe />);
    await show(host);
    expect(seen).toEqual({ name: "box", online: true });
    expect((screen.getByRole("switch", { name: "github" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("draws the rows as words while the home is offline: no switch, no ⋯, nothing to open", async () => {
    const host = seeded();
    host.state.home = { name: "The box", online: false };
    await show(host);
    for (const name of ["github", "local", "mobbin", "slack"]) {
      const row = rowOf(name);
      // Nothing is offered that cannot work while the box is out of reach.
      expect(within(row).queryByRole("switch")).toBeNull();
      expect(within(row).queryByRole("button")).toBeNull();
    }
    // An off row says so in words when there is no switch to read, first on its line, as an off skill does.
    expect(rowOf("local").textContent).toContain("Off");
    expect(rowOf("local").querySelector("[data-slot=status-mark]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add…" })).toBeNull();
  });

  it("folds the pushes in, all of them when they land before a render", async () => {
    const host = seeded();
    await show(host);
    const linear = base({ name: "linear", spec: { transport: "http", url: "https://mcp.linear.app/mcp", headers: [], auth: "oauth" } });
    act(() => host.push({ push: "addons", addons: [github, mobbin, slack, local, linear] }));
    expect(rowOf("linear").textContent).toContain("Starting");
    act(() => host.push({ push: "addon-status", status: { ...STATUS, [linear.id]: at("ready", { tools: 1 }) } }));
    expect(rowOf("linear").textContent).toContain("Connected1 tool");
    act(() =>
      host.push({ push: "addon-grants", grants: [...GRANTS, { addonId: linear.id, fields: [], oauth: null, signIn: { state: "waiting", since: 1 }, gaps: ["sign-in"] }] }),
    );
    expect(rowOf("linear").textContent).toContain("Signing inWaiting for the browser");
    // Three pushes before one render: each computes from the one before.
    const figma = base({ name: "figma" });
    act(() => {
      host.push({ push: "addons", addons: [github, figma] });
      host.push({ push: "addon-status", status: { [figma.id]: at("ready", { tools: 3 }) } });
      host.push({ push: "addon-grants", grants: [{ addonId: github.id, fields: [{ name: "GITHUB_TOKEN", set: false }], oauth: null, signIn: null, gaps: ["GITHUB_TOKEN"] }] });
    });
    expect([...document.querySelectorAll("[data-addon]")].map((r) => r.getAttribute("data-addon"))).toEqual(["figma", "github"]);
    expect(rowOf("figma").textContent).toContain("Connected3 tools");
    expect(rowOf("github").textContent).not.toContain("saved");
  });

  it("leaves the grant out and its rows off while the grants are unread", async () => {
    const host = seeded();
    host.state.silent.add("addons.grant.list");
    await show(host);
    expect(rowOf("github").textContent).not.toContain("saved");
    const m = await menu("github");
    expect(item(m, "Add key…").getAttribute("aria-disabled")).toBe("true");
    await act(async () => fireEvent.keyDown(m, { key: "Escape" }));
    const m2 = await menu("mobbin");
    expect(item(m2, "Sign in…").getAttribute("aria-disabled")).toBe("true");
  });

  it("says a failed grants read under the rows with its own Retry, the grant rows still off", async () => {
    const host = seeded();
    host.state.refuse.set("addons.grant.list", NO_ANSWER);
    await show(host);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("This Mac did not answer.");
    expect(rowOf("slack").compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const m = await menu("github");
    expect(item(m, "Add key…").getAttribute("aria-disabled")).toBe("true");
    await act(async () => fireEvent.keyDown(m, { key: "Escape" }));
    host.state.refuse.delete("addons.grant.list");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(rowOf("github").textContent).toContain("Key saved");
  });

  it("signs an OAuth add-on out with addons.grant.clear, once the confirm says so", async () => {
    const host = seeded();
    await show(host);
    await act(async () => fireEvent.click(item(await menu("mobbin"), "Sign out…")));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Its tools stop working until you sign in again.");
    expect(host.sent("addons.grant.clear")).toEqual([]);
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Sign out" })));
    expect(host.sent("addons.grant.clear")).toEqual([{ id: mobbin.id }]);
  });

  it("sends the switch and flips it back with the host's reason under the row", async () => {
    const host = seeded();
    await show(host);
    const sw = screen.getByRole("switch", { name: "github" });
    await act(async () => fireEvent.click(sw));
    expect(host.sent("addons.set")).toEqual([{ addon: { id: github.id, name: "github", workspaceId: null, description: "", spec: github.spec, enabled: false } }]);
    expect(screen.getByRole("switch", { name: "github" }).getAttribute("aria-checked")).toBe("false");
    host.state.refuse.set("addons.set", "refused: addons of every workspace live on box; it is offline");
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "local" })));
    expect(screen.getByRole("switch", { name: "local" }).getAttribute("aria-checked")).toBe("false");
    expect(rowOf("local").textContent).toContain("Addons of every workspace live on box; it is offline");
  });

  it("removes an add-on once the confirm says so", async () => {
    const host = seeded();
    await show(host);
    await act(async () => fireEvent.click(item(await menu("slack"), "Remove…")));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Remove the add-on slack");
    expect(host.sent("addons.remove")).toEqual([]);
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Remove" })));
    expect(host.sent("addons.remove")).toEqual([{ id: slack.id }]);
    expect(rowOf("slack")).toBeNull();
  });

  it("signs in on the desktop, and offers no sign-in at /ui", async () => {
    const host = seeded();
    await show(host);
    await act(async () => fireEvent.click(item(await menu("mobbin"), "Sign in again…")));
    expect(host.sent("addons.grant.signIn")).toEqual([{ id: mobbin.id }]);
    cleanup();
    const restore = asWebPage();
    try {
      await show(seeded());
      const m = await menu("mobbin");
      expect(within(m).queryByRole("menuitem", { name: /Sign in/ })).toBeNull();
      expect(item(m, "Sign out…")).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("opens Edit… prefilled from a row's click", async () => {
    await show(seeded());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Edit github" })));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("Edit github");
    expect((within(dialog).getByLabelText("Command") as HTMLInputElement).value).toBe("npx");
  });

  it("puts Add… on the title line, and opens Add key… after a new add-on that names values", async () => {
    const host = seeded();
    await show(host);
    const add = screen.getByRole("button", { name: "Add…" });
    expect(add.closest("[data-slot=page-actions]")).not.toBeNull();
    await act(async () => fireEvent.click(add));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "notion" } });
    fireEvent.change(within(dialog).getByLabelText("Command"), { target: { value: "npx" } });
    fireEvent.change(within(dialog).getByLabelText("Secret names"), { target: { value: "NOTION_KEY" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Key" }));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Add" })));
    await flush();
    const key = screen.getByRole("dialog");
    expect(within(key).getByRole("heading").textContent).toBe("Add key");
    expect(within(key).getByLabelText("NOTION_KEY")).toBeTruthy();
    expect(rowOf("notion")).toBeTruthy();
  });

  it("gives a list past eight a find field that narrows it", async () => {
    const many = Array.from({ length: 9 }, (_, i) => base({ name: `tool-${i}` }));
    await show(fakeStoreHost({ addons: [...many, github], status: {}, grants: [] }));
    const field = screen.getByRole("searchbox", { name: "Find an add-on" });
    fireEvent.change(field, { target: { value: "github" } });
    expect([...document.querySelectorAll("[data-addon]")].map((r) => r.getAttribute("data-addon"))).toEqual(["github"]);
  });

  it("shows a key that may not change add-ons the list alone, no switch, menu or Add…, and who can", async () => {
    keyMay.write = false;
    await show(seeded());
    expect(rowOf("github")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "github actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add…" })).toBeNull();
    expect(screen.getByText("Changed from a computer that manages the box.")).toBeTruthy();
    keyMay.write = true;
  });

  it("tells search every add-on's name once read", async () => {
    const { addonNames } = await import("./useAddons");
    const { renderHook } = await import("@testing-library/react");
    await show(seeded());
    const { result } = renderHook(() => addonNames.useExtras());
    expect(result.current.map((extra) => extra.title).sort()).toEqual(["github", "local", "mobbin", "slack"]);
    expect(result.current[0]).toMatchObject({ page: "addons", path: "Everywhere, Add-ons" });
  });
});
