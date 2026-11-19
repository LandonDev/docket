// @vitest-environment jsdom
/**
 * The guests pillar in the renderer: Share's popover and its dialog against a
 * fake host (the box answering for another host), the held request's view,
 * the audit list, and what a guest may write into a document as the owner's
 * own editor shows it: a `javascript:` link and a hostile paste.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentEditor, EditorAdaptersProvider, EditorKitProvider, type AnyEditor } from "work-kit/editor";
import type { GuestLinkRow } from "@shared/contract-work-guests";
import type { HeldItem } from "@shared/work";

const calls = vi.hoisted(() => ({ list: [] as { env: string; method: string; params: Record<string, unknown> }[], links: [] as unknown[], failOnce: false, down: new Set<string>(), revokeGate: null as Promise<void> | null, revokeRefusal: null as string | null }));
vi.mock("../../lib/connection", async (original) => {
  const linkOf = (env: string) => ({
    environmentId: env,
    connected: true,
    onPush: () => () => undefined,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      calls.list.push({ env, method, params });
      if (calls.down.has(env)) throw new Error("The host did not answer");
      // The Mac does not serve LifeOS's documents: it names the box, as the host does.
      if (env === "mac") throw new Error("served elsewhere: box");
      if (calls.failOnce && method === "work.guests.forItem") {
        calls.failOnce = false;
        throw new Error("LifeOS did not answer");
      }
      if (method === "work.guests.forItem" || method === "work.guests.list") return calls.links;
      if (method === "work.guests.create")
        return { link: { ...LINK, name: params.name, role: params.role, expiresAt: params.expiresAt }, url: "https://tempcode.landonhale.com/g/abc#k=secret" };
      if (method === "work.guests.revoke") {
        if (calls.revokeGate) await calls.revokeGate;
        if (calls.revokeRefusal) throw new Error(calls.revokeRefusal);
        return { ok: true };
      }
      if (method === "work.guests.rekey") return { url: "https://tempcode.landonhale.com/g/new#k=secret" };
      throw new Error(`unexpected ${method}`);
    },
  });
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf, onLink: () => () => undefined } };
});

const confirm = vi.hoisted(() => ({ answer: true, asked: [] as { title: string; body?: string; action: string }[] }));
vi.mock("../../chrome/ConfirmDialog", async (original) => ({
  ...(await original<object>()),
  confirmAction: async (request: { title: string; body?: string; action: string }) => (confirm.asked.push(request), confirm.answer),
}));
const clip = vi.hoisted(() => ({ fail: false }));
vi.mock("../../lib/clipboard", () => ({
  copyText: async () => {
    if (clip.fail) throw new Error("denied");
  },
}));

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
  calls.down.clear();
  calls.revokeGate = null;
  calls.revokeRefusal = null;
});

describe("Share", () => {
  it("lists the item's links from the host that serves it, revokes one, and makes a new one shown once", async () => {
    const { ShareButton } = await import("./Share");
    calls.links = [LINK];
    render(<ShareButton env="mac" source={{ at: "lifeos", table: "docs", id: "kd1" }} title="Run of show" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await screen.findByText("Sam Ortiz");
    // A list's avatar: 24px, as Settings' list draws it.
    expect(document.querySelector("[data-avatar]")!.getAttribute("data-avatar")).toBe("list");
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

  it("offers a sheet view or edit only, and draws no Share on what cannot be shared", async () => {
    const { ShareButton } = await import("./Share");
    const { container, unmount } = render(<ShareButton env="box" source={{ at: "file", host: "box", path: "/x/a.tcdoc" }} title="a" />);
    expect(container.innerHTML).toBe("");
    unmount();
    render(<ShareButton env="box" source={{ at: "lifeos", table: "sheets", id: "ks1" }} title="Budget" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    fireEvent.click(await screen.findByRole("button", { name: "New guest link…" }));
    await screen.findByPlaceholderText("Name");
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });
  it("says a list that did not load with Retry, which asks again", async () => {
    const { ShareButton } = await import("./Share");
    calls.links = [LINK];
    calls.failOnce = true;
    render(<ShareButton env="box" source={{ at: "lifeos", table: "docs", id: "kd1" }} title="Run of show" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await screen.findByText("LifeOS did not answer");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Sam Ortiz");
    expect(screen.queryByText("LifeOS did not answer")).toBeNull();
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

  it("keeps a row with a busy Revoke until the host confirms, and a refusal visible with the row still there", async () => {
    const { ShareButton } = await import("./Share");
    calls.links = [LINK];
    let open: () => void = () => {};
    calls.revokeGate = new Promise((r) => (open = r));
    render(<ShareButton env="box" source={{ at: "lifeos", table: "docs", id: "kd1" }} title="Run of show" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await screen.findByText("Sam Ortiz");
    fireEvent.click(screen.getByRole("button", { name: "Revoke Sam Ortiz's link" }));
    // Pending: the row and its busy Revoke stay; "Only you can open this" waits for the host.
    expect(screen.getByText("Sam Ortiz")).toBeTruthy();
    expect(screen.queryByText("Only you can open this")).toBeNull();
    expect(screen.getByRole("button", { name: "Revoke Sam Ortiz's link" }).querySelector("[data-busy]")).toBeTruthy();
    calls.revokeRefusal = "The link was already opened elsewhere";
    await act(async () => open());
    await waitFor(() => expect(screen.getByText("The link was already opened elsewhere")).toBeTruthy());
    expect(screen.getByText("Sam Ortiz")).toBeTruthy();
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
    // Copy new address and Revoke wait for the row's hover.
    expect(document.querySelector("[data-guest-actions]")!.className).toContain("group-hover/item:opacity-100");
  });

  it("keeps the links one host gave when another does not answer, with Retry, and lists a link read through two hosts once", async () => {
    const { GuestLinksSection } = await import("./GuestLinksSection");
    calls.links = [LINK];
    calls.down.add("win");
    render(<GuestLinksSection hosts={["box", "mac", "win"]} />);
    await screen.findByText("Sam Ortiz");
    expect(screen.getAllByText("Sam Ortiz")).toHaveLength(1);
    expect(screen.getByText("The host did not answer")).toBeTruthy();
    calls.down.clear();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    await waitFor(() => expect(screen.queryByText("The host did not answer")).toBeNull());
    expect(screen.getByText("Sam Ortiz")).toBeTruthy();
  });

  it("Replace address… asks first, saying the old address stops opening, and rekeys only on Replace", async () => {
    const { GuestLinksSection } = await import("./GuestLinksSection");
    calls.links = [LINK];
    render(<GuestLinksSection hosts={["box"]} />);
    await screen.findByText("Sam Ortiz");
    expect((document.querySelector("[data-avatar]") as HTMLElement).getAttribute("data-avatar")).toBe("list");
    confirm.answer = false;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Replace address…" })));
    expect(confirm.asked.at(-1)!.body).toMatch(/^.+'s current address stops opening\. The new one is copied for you to send\.$/);
    expect(calls.list.some((c) => c.method === "work.guests.rekey")).toBe(false);
    confirm.answer = true;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Replace address…" })));
    expect(calls.list.filter((c) => c.method === "work.guests.rekey").map((c) => c.params)).toEqual([{ linkId: "abc" }]);
  });

  it("shows the new address in the link-made dialog when it did not copy, so it is not lost", async () => {
    const { GuestLinksSection } = await import("./GuestLinksSection");
    calls.links = [LINK];
    confirm.answer = true;
    clip.fail = true;
    render(<GuestLinksSection hosts={["box"]} />);
    await screen.findByText("Sam Ortiz");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Replace address…" })));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("https://tempcode.landonhale.com/g/new#k=secret");
    // Copy there fails too: it says so, and the address stays to select.
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Copy" })));
    expect(dialog.textContent).toContain("It didn't copy");
    clip.fail = false;
  });

  it("says an empty list in a plain line", async () => {
    const { GuestLinksSection } = await import("./GuestLinksSection");
    render(<GuestLinksSection hosts={["box"]} />);
    expect(await screen.findByText("No guest links")).toBeTruthy();
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
