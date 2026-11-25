// @vitest-environment jsdom
/**
 * A folder in the Windows VM never makes him wait in silence (docs/agents/work-teams-files.md "A folder in the VM"):
 * only his press asks the host to wake the VM, a page of its rows is not looked at again for who saved them, and the
 * page says the machine's state in its own state line or empty state: waking with a spinner and nothing to press,
 * asleep with Wake it, or a wake that did not come.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePage, FilesListing } from "@shared/contract-work-files";
import type { FileEntry, FilePlace, FolderRef } from "@shared/work/files";

const requests: { method: string; params: Record<string, unknown> }[] = [];
vi.mock("../../lib/connection", async (original) => {
  const linkOf = (id: string) => ({
    environmentId: id,
    connected: true,
    request: async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      return { thumbs: [], entries: [] };
    },
    onPush: () => () => undefined,
    onOpen: () => () => undefined,
    onClose: () => () => undefined,
  });
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf, link: linkOf, has: () => true, environment: (id: string) => ({ id, name: "The box", platform: "linux" }), environments: () => [], onLink: () => () => undefined } };
});

const { PageView } = await import("./Page");
const { listingSeams, pressFor, resetFilesStore, useListing } = await import("./store");
const { vmSleepNote } = await import("./model");

const TOP = "C:\\Users\\tcuser\\Dummy U\\Team - Documents\\General";
const at = (path: string): FolderRef => ({ at: "file", host: "env_box", path });
const VM_PLACE = { id: "box~vm/General", kind: "teams", name: "General", host: "Windows VM", env: "env_box", shared: true, vm: true, can: [], state: { state: "asleep", at: 1_700_000_000_000 }, root: at(TOP) } as unknown as FilePlace;
const VM = { place: VM_PLACE, link: "box", host: "Windows VM", wire: "files" as const };
const PAGE: FilePage = { at: at(TOP), name: "General" };
const doc = (name: string): FileEntry => ({ key: `lib:general:${name}`, ref: at(`${TOP}\\${name}`), folder: null, name, kind: "document", changed: 1_700_000_000_000 });
type Listed = NonNullable<Parameters<typeof PageView>[0]["listing"]>;
const listing = (over: Partial<Listed> = {}): Listed => ({ entries: [doc("Plan.docx")], trail: [{ name: "General", at: at(TOP) }], loaded: true, more: false, loading: false, error: null, away: false, loadMore: () => undefined, retry: () => undefined, ...over });

function draw(listed: Listed, run = vi.fn()) {
  render(
    <PageView
      page={PAGE}
      panelId="p1"
      listing={listed}
      copy={VM}
      from={{ workspaceId: "w1", copy: VM }}
      trail={listed.trail}
      canBack={false}
      canForward={false}
      busy={null}
      fixes={{ busy: false, run }}
      onBack={() => undefined}
      onForward={() => undefined}
      onGo={() => undefined}
      onOpen={() => undefined}
    />,
  );
  return run;
}

beforeEach(() => {
  localStorage.clear();
  resetFilesStore();
  requests.length = 0;
});
afterEach(() => {
  delete listingSeams.fetch;
  cleanup();
  vi.restoreAllMocks();
});

describe("which lists may wake the VM", () => {
  it("asks without waking for a tab shown again, a later page and a stale press; with waking for his press and his Retry", async () => {
    const woke: boolean[] = [];
    listingSeams.fetch = async (_from, _at, _sort, cursor, wake) => {
      woke.push(!!wake);
      return cursor ? { entries: [doc("More.docx")] } : { entries: [doc("Plan.docx")], next: "c1", trail: [] };
    };
    // A tab restored on a reconnect: no press.
    const restored = renderHook(() => useListing({ workspaceId: "w1", copy: VM }, PAGE.at));
    await waitFor(() => expect(restored.result.current.loaded).toBe(true));
    await act(async () => restored.result.current.loadMore());
    await waitFor(() => expect(restored.result.current.entries).toHaveLength(2));
    expect(woke).toEqual([false, false]);
    // His Retry (and Wake it, which is Retry over a sleeping folder).
    await act(async () => restored.result.current.retry());
    await waitFor(() => expect(woke).toHaveLength(3));
    expect(woke[2]).toBe(true);
    restored.unmount();
    // He opened the folder: its first page may wake it, once.
    const other = at(`${TOP}\\Budgets`);
    pressFor(other);
    const pressed = renderHook(() => useListing({ workspaceId: "w1", copy: VM }, other));
    await waitFor(() => expect(woke).toHaveLength(4));
    expect(woke[3]).toBe(true);
    pressed.unmount();
    // Shown again once its first page is older than the window's fresh time (keep.ts), so the host is asked: no press.
    const real = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(real + 6_000);
    const again = renderHook(() => useListing({ workspaceId: "w1", copy: VM }, other));
    await waitFor(() => expect(woke).toHaveLength(5));
    expect(woke[4]).toBe(false);
    again.unmount();
    vi.restoreAllMocks();
    // A press that was never followed by its list lapses.
    const late = at(`${TOP}\\Late`);
    pressFor(late, Date.now() - 60_000);
    const lapsed = renderHook(() => useListing({ workspaceId: "w1", copy: VM }, late));
    await waitFor(() => expect(woke).toHaveLength(6));
    expect(woke[5]).toBe(false);
    lapsed.unmount();
  });

  it("never asks the host who saved a page of VM rows", async () => {
    listingSeams.fetch = async () => ({ entries: [doc("Plan.docx"), doc("Notes.docx"), doc("Deck.pptx")], trail: [] });
    const { result } = renderHook(() => useListing({ workspaceId: "w1", copy: VM }, PAGE.at));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(requests.filter((r) => r.method === "work.files.stat")).toEqual([]);
  });

  it("says a wake it saw under way that ended asleep did not come", async () => {
    const answers: FilesListing[] = [
      { entries: [], trail: [], sleeping: "waking" },
      { entries: [], trail: [], sleeping: "asleep" },
    ];
    listingSeams.fetch = async () => answers.shift()!;
    const { result } = renderHook(() => useListing({ workspaceId: "w1", copy: VM }, PAGE.at));
    await waitFor(() => expect(result.current.sleeping).toBe("waking"));
    await act(async () => result.current.retry());
    await waitFor(() => expect(result.current).toMatchObject({ sleeping: "asleep", unwoken: true }));
  });
});

describe("what a sleeping VM folder shows", () => {
  const clock = () => "1:40 PM";

  it("words each state once, from the folder's own answer", () => {
    expect(vmSleepNote(VM, { sleeping: "waking" }, clock)).toEqual({ title: "Waking the Windows VM", busy: true });
    expect(vmSleepNote(VM, { sleeping: "waking", asOf: 1 }, clock)).toEqual({ title: "Waking the Windows VM", line: "This is the list from 1:40 PM.", busy: true });
    expect(vmSleepNote(VM, { sleeping: "asleep", asOf: 1 }, clock)).toEqual({ title: "The Windows VM is asleep", line: "This is the list from 1:40 PM.", fix: { kind: "wake", link: "box" } });
    expect(vmSleepNote(VM, { sleeping: "asleep", unwoken: true }, clock)).toEqual({ title: "The Windows VM did not wake", fix: { kind: "wake", link: "box" } });
    expect(vmSleepNote(VM, {}, clock)).toBeNull();
  });

  it("waking with nothing kept: the spinner and its words where the list would be, busy, with nothing to press", () => {
    draw(listing({ entries: [], sleeping: "waking" }));
    const status = screen.getByText("Waking the Windows VM").closest("[role=status]")!;
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("button", { name: "Wake it" })).toBeNull();
    expect(screen.queryByText("This folder is empty")).toBeNull();
  });

  it("waking over the rows kept: one state line with the spinner and when the list is from, the rows still there", () => {
    draw(listing({ sleeping: "waking", asOf: 1_700_000_000_000 }));
    const line = document.querySelector("[data-files-note]")!;
    expect(line.getAttribute("aria-busy")).toBe("true");
    expect(line.textContent).toContain("Waking the Windows VM");
    expect(line.textContent).toContain("This is the list from");
    expect(screen.queryByRole("button", { name: "Wake it" })).toBeNull();
    expect(document.querySelector('[data-files-row="lib:general:Plan.docx"]')).not.toBeNull();
  });

  it("asleep with nothing kept: Wake it where the list would be, which lists the folder again as his press", () => {
    const retry = vi.fn();
    const run = draw(listing({ entries: [], sleeping: "asleep", retry }));
    fireEvent.click(screen.getByRole("button", { name: "Wake it" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByText("The Windows VM is asleep")).toBeTruthy();
  });

  it("spins Wake it for his press alone, never for a read the page asked by itself", () => {
    draw(listing({ sleeping: "asleep", loading: true }));
    const wake = screen.getByRole("button", { name: "Wake it" }) as HTMLButtonElement;
    expect(wake.disabled).toBe(false);
    expect(wake.querySelector("[data-busy]")).toBeNull();
    cleanup();
    draw(listing({ sleeping: "asleep", loading: true, retrying: true }));
    expect((screen.getByRole("button", { name: "Wake it" }) as HTMLButtonElement).querySelector("[data-busy]")).not.toBeNull();
  });

  it("rows read live put the place's older asleep line away", () => {
    draw(listing({}));
    expect(screen.queryByText("The Windows VM is asleep")).toBeNull();
    expect(document.querySelector("[data-files-note]")).toBeNull();
  });
});
