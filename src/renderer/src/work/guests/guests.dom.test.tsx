// @vitest-environment jsdom
/**
 * The guests pillar in the renderer: Share's popover and its dialog against a
 * fake host (the box answering for another host), the held request's view,
 * the audit list, and what a guest may write into a document as the owner's
 * own editor shows it: a `javascript:` link and a hostile paste.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentEditor, EditorAdaptersProvider, EditorKitProvider, type AnyEditor } from "work-kit/editor";
import type { GuestLinkRow } from "@shared/contract-work-guests";
import type { HeldItem } from "@shared/work";

const calls = vi.hoisted(() => ({ list: [] as { env: string; method: string; params: Record<string, unknown> }[], links: [] as unknown[] }));
vi.mock("../../lib/connection", async (original) => {
  const linkOf = (env: string) => ({
    environmentId: env,
    connected: true,
    onPush: () => () => undefined,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      calls.list.push({ env, method, params });
      // The Mac does not serve LifeOS's documents: it names the box, as the host does.
      if (env === "mac") throw new Error("served elsewhere: box");
      if (method === "work.guests.forItem" || method === "work.guests.list") return calls.links;
      if (method === "work.guests.create")
        return { link: { ...LINK, name: params.name, role: params.role, expiresAt: params.expiresAt }, url: "https://tempcode.landonhale.com/g/abc#k=secret" };
      if (method === "work.guests.revoke") return { ok: true };
      throw new Error(`unexpected ${method}`);
    },
  });
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf, onLink: () => () => undefined } };
});

const LINK: GuestLinkRow = {
  id: "abc",
  name: "Sam Ortiz",
  source: { at: "lifeos", table: "docs", id: "kd1" },
  title: "Run of show",
  role: "edit",
  createdAt: Date.now(),
  expiresAt: Date.now() + 5 * 86_400_000,
  revokedAt: null,
  by: "owner",
  lastOpenedAt: null,
  open: 1,
};

afterEach(() => {
  cleanup();
  calls.list.length = 0;
  calls.links = [];
});

describe("Share", () => {
  it("lists the item's links from the host that serves it, revokes one, and makes a new one shown once", async () => {
    const { ShareButton } = await import("./Share");
    calls.links = [LINK];
    render(<ShareButton env="mac" source={{ at: "lifeos", table: "docs", id: "kd1" }} title="Run of show" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await screen.findByText("Sam Ortiz");
    // Asked of the Mac, answered by the box.
    expect(calls.list.map((c) => `${c.env}:${c.method}`)).toEqual(["mac:work.guests.forItem", "box:work.guests.forItem"]);
    fireEvent.click(screen.getByRole("button", { name: "Revoke Sam Ortiz's link" }));
    await waitFor(() => expect(calls.list.at(-1)).toMatchObject({ env: "box", method: "work.guests.revoke", params: { linkId: "abc" } }));
    expect(screen.getByText("Only you can open this")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "New guest link…" }));
    const name = await screen.findByPlaceholderText("Name");
    expect(screen.getByRole("button", { name: "Create link" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(name, { target: { value: "Dana Lee" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await screen.findByText("https://tempcode.landonhale.com/g/abc#k=secret");
    const made = calls.list.find((c) => c.method === "work.guests.create")!;
    expect(made.params).toMatchObject({ source: { at: "lifeos", table: "docs", id: "kd1" }, title: "Run of show", name: "Dana Lee", role: "comment" });
    // Thirty days unless he picks.
    expect(Math.round(((made.params.expiresAt as number) - Date.now()) / 86_400_000)).toBe(30);
    expect(screen.getByText("Link for Dana Lee")).toBeTruthy();
    expect(screen.getByText(/shown only now/)).toBeTruthy();
  });

  it("offers a sheet view or edit only, and a file the move to LifeOS", async () => {
    const { ShareButton } = await import("./Share");
    const { unmount } = render(<ShareButton env="box" source={{ at: "file", host: "box", path: "/x/a.tcdoc" }} title="a" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await screen.findByText("Move it to LifeOS to share it.");
    unmount();
    render(<ShareButton env="box" source={{ at: "lifeos", table: "sheets", id: "ks1" }} title="Budget" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    fireEvent.click(await screen.findByRole("button", { name: "New guest link…" }));
    await screen.findByPlaceholderText("Name");
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });
});

describe("the held request and the audit list", () => {
  it("shows the link an agent asked for, exactly", async () => {
    const { View } = await import("./ShareActView");
    const item = { kind: "share.guestLink", payload: { source: { at: "lifeos", table: "sheets", id: "ks1" }, title: "Nationals travel budget", name: "Dana Lee", role: "edit", expiresAt: Date.UTC(2026, 11, 18, 12) } } as unknown as HeldItem;
    render(<View item={item} env="box" />);
    for (const words of ["Nationals travel budget", "Dana Lee", "Edit"]) expect(screen.getByText(words)).toBeTruthy();
    expect(screen.getByText(/Dec 18/)).toBeTruthy();
  });

  it("lists every link, live first, a revoked one muted with no Revoke", async () => {
    const { GuestLinksSection } = await import("./GuestLinksSection");
    calls.links = [{ ...LINK, id: "old", name: "Maya Chen", revokedAt: Date.now() - 1000, open: 0 }, LINK];
    render(<GuestLinksSection hosts={["box"]} />);
    await screen.findByText("Sam Ortiz");
    const names = screen.getAllByText(/Sam Ortiz|Maya Chen/).map((n) => n.textContent);
    expect(names).toEqual(["Sam Ortiz", "Maya Chen"]);
    expect(screen.getByText(/Edit, Run of show, until .*, in it now/)).toBeTruthy();
    expect(screen.getByText(/revoked/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
  });
});

// jsdom has neither; the editor's paste builds one of each, as a browser's paste event carries them.
class TestDataTransfer {
  private readonly data = new Map<string, string>();
  get types() {
    return [...this.data.keys()];
  }
  files = [] as File[];
  items = [] as unknown[];
  setData(type: string, value: string) {
    this.data.set(type, value);
  }
  getData(type: string) {
    return this.data.get(type) ?? "";
  }
}
class TestClipboardEvent extends Event {
  clipboardData: TestDataTransfer | null;
  constructor(type: string, init: EventInit & { clipboardData?: TestDataTransfer } = {}) {
    super(type, init);
    this.clipboardData = init.clipboardData ?? null;
  }
}
const g = globalThis as Record<string, unknown>;
g.DataTransfer ??= TestDataTransfer;
g.ClipboardEvent ??= TestClipboardEvent;

describe("what a guest writes, in the owner's editor", () => {
  it("a javascript: link and a hostile paste run nothing and open nothing", async () => {
    let editor: AnyEditor | null = null;
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    (window as unknown as { __pwned?: number }).__pwned = undefined;
    render(
      <EditorKitProvider value={{ theme: "light" }}>
        <EditorAdaptersProvider adapters={{}}>
          <DocumentEditor documentName="hostile" editable initialMarkdown="Hello" onEditor={(e) => (editor = e)} />
        </EditorAdaptersProvider>
      </EditorKitProvider>,
    );
    await waitFor(() => expect(editor).not.toBeNull());
    // As a guest's socket delivers it: a block whose text is a link to a script.
    act(() => {
      editor!.insertBlocks(
        [{ type: "paragraph", content: [{ type: "link", href: "javascript:window.__pwned=1", content: [{ type: "text", text: "click me", styles: {} }] }] } as never],
        editor!.document[0]!,
        "after",
      );
    });
    // And a paste from the guest's clipboard.
    act(() => {
      editor!.pasteHTML('<p><a href="javascript:window.__pwned=2">pasted</a><img src="x" onerror="window.__pwned=3"><script>window.__pwned=4</script></p>');
    });
    await new Promise((r) => setTimeout(r, 50));
    const root = document.querySelector(".ProseMirror")!;
    // Both reached the text: the guest's words are there, what they would run is not.
    expect(root.textContent).toContain("click me");
    expect(root.textContent).toContain("pasted");
    for (const a of root.querySelectorAll("a")) expect(a.getAttribute("href") ?? "").not.toMatch(/^\s*javascript:/i);
    for (const el of root.querySelectorAll("*")) for (const attr of el.getAttributeNames()) expect(attr.startsWith("on"), `${el.tagName} ${attr}`).toBe(false);
    expect(root.querySelector("script")).toBeNull();
    // A press on the link opens nothing: the editor takes every press, and a script is no address.
    const link = [...root.querySelectorAll("a")].find((a) => a.textContent === "click me");
    if (link) fireEvent.click(link, { metaKey: true });
    expect(opened).not.toHaveBeenCalled();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
