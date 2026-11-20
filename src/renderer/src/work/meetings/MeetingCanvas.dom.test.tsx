// @vitest-environment jsdom
/**
 * The meeting canvas in the real pane (docs/agents/work-meetings.md "The
 * canvas"): a host that answers `work.canvas.list` and `work.meetings.*`,
 * the kind's chunk loaded through the registry, and the frame's stepper,
 * state line and selection bar fed by it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Meeting } from "@shared/contract-work-meetings";
import type { CanvasItem } from "@shared/work";
import { openMenus } from "../../chrome/menuRows";
import { canvasItem, fakeHost } from "../canvas/testkit";
import { SAMPLE_NOTES, sampleMeeting } from "./sample";

const host = vi.hoisted(() => ({
  current: null as ReturnType<typeof import("../canvas/testkit").fakeHost> | null,
  pushes: new Set<(push: never) => void>(),
  opens: new Set<() => void>(),
  meeting: null as Meeting | null,
  calls: [] as { method: string; params: Record<string, unknown> }[],
  decide: null as null | ((params: Record<string, unknown>) => unknown),
  down: false,
  hold: null as Promise<void> | null,
  refuseStart: false,
  recording: null as null | ((params: Record<string, unknown>) => unknown),
}));
vi.mock("../../lib/connection", async (original) => {
  const link = {
    environmentId: "local",
    connected: true,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      if (!method.startsWith("work.meetings.")) return host.current!.link.request(method, params);
      host.calls.push({ method, params });
      if (method === "work.meetings.get") {
        if (host.hold) await host.hold;
        if (host.down) throw new Error("socket closed");
        return { meeting: host.meeting };
      }
      if (method === "work.meetings.start") {
        if (host.refuseStart) throw new Error("socket closed");
        host.meeting = sampleMeeting({ status: "transcribing", segments: [], rev: (host.meeting?.rev ?? 0) + 1 });
        return { meeting: host.meeting };
      }
      if (method === "work.meetings.decide") return host.decide!(params);
      if (method === "work.meetings.voices") return { voices: [] };
      if (method === "work.meetings.recording") return host.recording!(params);
      throw new Error(`unexpected ${method}`);
    },
    onPush: (listener: (push: never) => void) => (host.pushes.add(listener), () => host.pushes.delete(listener)),
    onOpen: (listener: () => void) => (host.opens.add(listener), () => host.opens.delete(listener)),
    onClose: () => () => undefined,
  };
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf: () => link, onLink: (listener: (l: typeof link, event: string) => void) => (listener(link, "added"), () => undefined) } };
});

import { CanvasSeat } from "../canvas/CanvasSeat";
import { canvasOf, resetCanvasStore } from "../canvas/store";
import { resetMeetings } from "./data";

const ITEM: CanvasItem = canvasItem("m1", { kind: "meeting", title: "Staff sync, Nov 16", source: { at: "file", host: "local", path: "/files/Staff sync.m4a" } });

beforeEach(async () => {
  HTMLElement.prototype.setPointerCapture ??= () => undefined;
  HTMLElement.prototype.releasePointerCapture ??= () => undefined;
  HTMLElement.prototype.hasPointerCapture ??= () => false;
  Element.prototype.scrollIntoView ??= () => undefined;
  localStorage.clear();
  resetCanvasStore();
  resetMeetings();
  host.calls = [];
  host.decide = null;
  host.down = false;
  host.hold = null;
  host.refuseStart = false;
  await new Promise<void>((done) => openMenus(done));
});
afterEach(cleanup);

async function seat(meeting: Meeting | null, item: CanvasItem = ITEM) {
  host.meeting = meeting;
  host.current = fakeHost([item], host as never);
  const view = render(
    <CanvasSeat session={{ id: "t1", environmentId: "local" }}>
      <div data-testid="thread" />
    </CanvasSeat>,
  );
  await waitFor(() => expect(canvasOf("t1").loaded).toBe(true));
  await waitFor(() => expect(view.container.querySelector("[data-meeting], [data-meeting-empty], [data-meeting-skeleton], [data-meeting-failed], [data-canvas-state]")).toBeTruthy());
  await act(async () => {});
  return view;
}
const push = (meeting: Meeting): void => {
  host.meeting = meeting;
  for (const listener of host.pushes) (listener as (p: unknown) => void)({ push: "work.meetings", itemId: meeting.itemId, sessionId: "t1", rev: meeting.rev, status: meeting.status });
};
const time = (container: HTMLElement): string => container.querySelector("[data-meeting-player] .tabular-nums")!.textContent!;

describe("the meeting canvas", () => {
  it("draws the player over the turns: a name and its minute over the words, a click on a turn seeks", async () => {
    const { container } = await seat(sampleMeeting());
    await waitFor(() => expect(container.querySelector("[data-meeting=ready]")).toBeTruthy());
    expect(time(container)).toBe("0:00 / 42:10");
    expect(container.querySelectorAll("[data-meeting-wave] > span[class*='flex-1']")).toHaveLength(100);
    const turn = container.querySelector('[data-turn="s7"]') as HTMLElement;
    expect(turn.textContent).toContain("Landon15:02The contract lists a 200 amp drop");
    fireEvent.click(turn);
    expect(time(container)).toBe("15:02 / 42:10");
    expect(screen.getByRole("slider", { name: "Position" }).getAttribute("aria-valuenow")).toBe("902");
    // The turn playing sits on the muted fill.
    expect(turn.getAttribute("aria-current")).toBe("true");
    // The bar holds the mode and Find, and no Notes switch while there are no notes.
    expect(container.querySelector("[data-canvas-bar]")!.textContent).toContain("Agent writes");
    expect(screen.queryByRole("tab", { name: "Notes" })).toBeNull();
  });

  it("a click on a decision's minute seeks the player to it", async () => {
    const { container } = await seat(sampleMeeting({ notes: SAMPLE_NOTES }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Notes" })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    await waitFor(() => expect(container.querySelector("[data-meeting-notes]")).toBeTruthy());
    const notes = container.querySelector("[data-meeting-notes]") as HTMLElement;
    expect([...notes.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(["Decided", "To do", "Open questions"]);
    const decision = notes.querySelector('[data-note="d2"]') as HTMLElement;
    expect(decision.textContent).toBe("The LAN is in the ballroom on April 10, $2,400 with the RecWell discount15:41");
    fireEvent.click(within(decision).getByRole("button", { name: "Play from 15:41" }));
    expect(time(container)).toBe("15:41 / 42:10");
    expect(screen.getByRole("slider", { name: "Position" }).getAttribute("aria-valuenow")).toBe("941");
    // Its Undo sits in the bar's end while no task waits... here three wait, so the stepper has the slot.
    expect(within(container.querySelector("[data-canvas-bar]") as HTMLElement).getByText("1/3")).toBeTruthy();
  });

  it("the Notes and Transcript switch is the form's 24px switch, and stays in a narrow bar while no tasks wait", async () => {
    const calm = await seat(sampleMeeting({ notes: { ...SAMPLE_NOTES, actions: SAMPLE_NOTES.actions.map((a) => ({ ...a, state: "filed" as const })) } }));
    await screen.findByRole("tab", { name: "Notes" });
    const kept = calm.container.querySelector("[data-canvas-bar] [role=tablist]")!.parentElement as HTMLElement;
    expect(kept.hasAttribute("data-narrow-hide")).toBe(false);
    expect(kept.className).not.toContain("@max-[560px]/bar:hidden");
    calm.unmount();
  });

  it("the switch goes whole under the narrow bar while tasks wait to be stepped through", async () => {
    const { container } = await seat(sampleMeeting({ notes: SAMPLE_NOTES }));
    const notes = await screen.findByRole("tab", { name: "Notes" });
    const list = screen.getByRole("tablist", { name: "Show" });
    expect(list.className).toContain("relative");
    expect(list.className).toContain("p-0.5");
    expect(list.className).toContain("group-data-[orientation=horizontal]/tabs:h-6");
    // The pill glides under the triggers, which lift nothing of their own.
    for (const tab of [notes, screen.getByRole("tab", { name: "Transcript" })]) expect(tab.className).toContain("group-data-[variant=default]/tabs-list:data-active:bg-transparent");
    const root = container.querySelector("[data-canvas-bar] [data-narrow-hide]") as HTMLElement;
    expect(root.contains(list)).toBe(true);
    expect(root.className).toContain("shrink-0");
    expect(root.className).toContain("@max-[560px]/bar:hidden");
  });

  it("an open Find can narrow but keeps its field whole", async () => {
    const { container } = await seat(sampleMeeting());
    await waitFor(() => expect(container.querySelector("[data-meeting=ready]")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    const field = (await screen.findByRole("textbox", { name: "Find in the transcript" })).closest("[data-slot=input-group]")!;
    expect(field.className).toContain("min-w-24");
    expect(field.className).toContain("shrink");
  });

  it("tasks wait at their turn, tinted; the stepper steps through them and Accept files the current one", async () => {
    host.decide = (params) => {
      const ids = params.actionIds as string[];
      host.meeting = sampleMeeting({ rev: 5, notes: { ...SAMPLE_NOTES, actions: SAMPLE_NOTES.actions.map((a) => (ids.includes(a.id) ? { ...a, state: "filed" as const, lifeosTaskId: "t9" } : a)) } });
      return { meeting: host.meeting, failed: [] };
    };
    const { container } = await seat(sampleMeeting({ notes: SAMPLE_NOTES }));
    await waitFor(() => expect(container.querySelector('[data-task="a1"]')).toBeTruthy());
    const row = container.querySelector('[data-turn="s2"] [data-task="a1"]') as HTMLElement;
    expect(row.getAttribute("data-state")).toBe("proposed");
    expect(row.hasAttribute("data-current")).toBe(true);
    // The filed one shows as LifeOS's and is not counted.
    expect(container.querySelector('[data-task="a4"]')!.getAttribute("data-state")).toBe("filed");
    const bar = container.querySelector("[data-canvas-bar]") as HTMLElement;
    fireEvent.click(within(bar).getByRole("button", { name: "Next change" }));
    await waitFor(() => expect(within(bar).getByText("2/3")).toBeTruthy());
    expect(time(container)).toBe("16:40 / 42:10");
    fireEvent.click(within(bar).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(host.calls.find((c) => c.method === "work.meetings.decide")?.params).toEqual({ itemId: "m1", actionIds: ["a2"], decision: "accept" }));
    await waitFor(() => expect(container.querySelector('[data-task="a2"]')!.getAttribute("data-state")).toBe("filed"));
    expect(within(bar).getByText("1/2")).toBeTruthy();
  });

  it("a task LifeOS would not take stays waiting, and the state line says why with Retry", async () => {
    host.decide = () => ({ meeting: host.meeting, failed: [{ id: "a1", error: "LifeOS is not connected on this host." }] });
    const { container } = await seat(sampleMeeting({ notes: SAMPLE_NOTES }));
    const bar = await waitFor(() => container.querySelector("[data-canvas-bar]") as HTMLElement);
    await waitFor(() => expect(within(bar).getByText("1/3")).toBeTruthy());
    fireEvent.click(within(bar).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(container.querySelector("[data-canvas-state=failed]")?.textContent).toContain("LifeOS is not connected on this host."));
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("Find marks every hit, steps the current one, and says how many", async () => {
    const { container } = await seat(sampleMeeting());
    await waitFor(() => expect(container.querySelector("[data-meeting=ready]")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    const field = screen.getByRole("textbox", { name: "Find in the transcript" });
    fireEvent.change(field, { target: { value: "friday" } });
    await waitFor(() => expect(container.querySelector("[data-meeting-find]")!.textContent).toContain("1/3"));
    expect(container.querySelectorAll("mark[data-hit]")).toHaveLength(3);
    expect(container.querySelector('[data-turn="s1"] mark[data-hit=current]')).toBeTruthy();
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(container.querySelector('[data-turn="s2"] mark[data-hit=current]')).toBeTruthy());
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() => expect(container.querySelectorAll("mark[data-hit]")).toHaveLength(0));
  });

  it("Escape and Close find give the focus back to Find, never to the body", async () => {
    const { container } = await seat(sampleMeeting());
    await waitFor(() => expect(container.querySelector("[data-meeting=ready]")).toBeTruthy());
    const bar = container.querySelector("[data-canvas-bar]") as HTMLElement;
    fireEvent.click(within(bar).getByRole("button", { name: "Find" }));
    const field = await screen.findByRole("textbox", { name: "Find in the transcript" });
    act(() => field.focus());
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(within(bar).getByRole("button", { name: "Find" })));
    fireEvent.click(within(bar).getByRole("button", { name: "Find" }));
    act(() => within(bar).getByRole("button", { name: "Close find" }).focus());
    fireEvent.click(within(bar).getByRole("button", { name: "Close find" }));
    await waitFor(() => expect(document.activeElement).toBe(within(bar).getByRole("button", { name: "Find" })));
    expect(document.activeElement).not.toBe(document.body);
    // The transcript pane is where the focus goes when the bar holds no Find: focusable from code, no Tab stop of its own.
    expect(container.querySelector('[data-meeting-pane="m1"]')!.getAttribute("tabindex")).toBe("-1");
  });

  it("while it transcribes: the turns heard so far, the working line, turns still to come; a push with a newer rev fetches it again", async () => {
    const busy = sampleMeeting({ status: "transcribing", rev: 2, segments: sampleMeeting().segments.slice(0, 4), progress: { phase: "words", done: 840, total: 2530 } });
    const { container } = await seat(busy);
    await waitFor(() => expect(container.querySelector("[data-meeting=transcribing]")).toBeTruthy());
    expect(container.querySelectorAll("[data-turn]")).toHaveLength(4);
    expect(container.querySelector("[data-meeting-progress]")!.textContent).toBe("Transcribing, 14 of 42 minutes");
    await act(async () => push(sampleMeeting({ rev: 3 })));
    await waitFor(() => expect(container.querySelector("[data-meeting=ready]")).toBeTruthy());
    expect(container.querySelectorAll("[data-turn]")).toHaveLength(14);
  });

  it("an item opened on a file starts it once; could not transcribe says why, keeps the player and tries again", async () => {
    const { container } = await seat(null);
    await waitFor(() => expect(host.calls.filter((c) => c.method === "work.meetings.start")).toHaveLength(1));
    await act(async () => push(sampleMeeting({ status: "failed", rev: 9, segments: [], error: "It stopped when tempcode-box restarted. The recording is fine." })));
    await waitFor(() => expect(container.querySelector("[data-meeting-failed]")).toBeTruthy());
    expect(container.querySelector("[data-meeting-failed]")!.textContent).toContain("Could not transcribeIt stopped when tempcode-box restarted. The recording is fine.");
    expect(container.querySelector("[data-meeting-player]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(host.calls.filter((c) => c.method === "work.meetings.start")).toHaveLength(2));
  });

  it("an item with no file yet offers one Choose a file", async () => {
    const { container } = await seat(null, { ...ITEM, source: { at: "thread" } });
    await waitFor(() => expect(container.querySelector("[data-meeting-empty]")).toBeTruthy());
    expect(container.querySelector("[data-meeting-empty]")!.textContent).toBe("Drop a recordingAudio, video or a transcript, from any meeting.Choose a file");
    expect(host.calls.some((c) => c.method === "work.meetings.start")).toBe(false);
    // Nothing in the bar yet, so no bar is drawn: its Bar renders nothing (F2).
    const bar = container.querySelector("[data-canvas-bar]");
    expect(bar === null || bar.matches(":has([data-canvas-tools]:empty)")).toBe(true);
    // and More holds the frame's rows alone
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect((await screen.findAllByRole("menuitem")).map((row) => row.textContent)).toEqual(["Open from Google…", "Close"]);
  });

  it("offers Export transcript first in More once there is a transcript, and saves the turns as text", async () => {
    const clicked: { name: string; href: string }[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ name: this.download, href: this.href });
    });
    // jsdom has no object URLs
    const made = vi.fn((_blob: Blob) => "blob:transcript");
    const was = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    Object.assign(URL, { createObjectURL: made, revokeObjectURL: () => undefined });
    try {
      await seat(sampleMeeting({ title: "Staff sync.m4a" }));
      fireEvent.click(screen.getByRole("button", { name: "More" }));
      const rows = (await screen.findAllByRole("menuitem")).map((row) => row.textContent);
      expect(rows[0]).toBe("Export transcript");
      fireEvent.click(screen.getByRole("menuitem", { name: "Export transcript" }));
      await waitFor(() => expect(clicked).toEqual([{ name: "Staff sync.txt", href: "blob:transcript" }]));
      expect(await (made.mock.calls[0][0] as Blob).text()).toMatch(/^Staff sync\.m4a\n\n10:52 Dana Lee\n/);
    } finally {
      click.mockRestore();
      Object.assign(URL, { createObjectURL: was.create, revokeObjectURL: was.revoke });
    }
  });

  it("Download recording saves the original as it was dropped, read in ranges, and takes no second press while it comes", async () => {
    const clicked: { name: string; href: string }[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ name: this.download, href: this.href });
    });
    const made = vi.fn((_blob: Blob) => "blob:recording");
    const was = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    Object.assign(URL, { createObjectURL: made, revokeObjectURL: () => undefined });
    // two ranges; the second waits until the test lets it go
    const body = "x".repeat(2 * 1024 * 1024) + "tail";
    let release!: () => void;
    const second = new Promise<void>((r) => (release = r));
    host.recording = async (params) => {
      const offset = params.offset as number;
      if (offset > 0) await second;
      const part = body.slice(offset, offset + (params.length as number));
      return { name: "Staff sync.mov", size: body.length, dataBase64: btoa(part) };
    };
    try {
      await seat(sampleMeeting({ title: "Staff sync.mov" }));
      fireEvent.click(screen.getByRole("button", { name: "More" }));
      expect((await screen.findAllByRole("menuitem")).map((row) => row.textContent).slice(0, 2)).toEqual(["Export transcript", "Download recording"]);
      fireEvent.click(screen.getByRole("menuitem", { name: "Download recording" }));
      fireEvent.click(screen.getByRole("button", { name: "More" }));
      const busy = await screen.findByRole("menuitem", { name: /^Downloading… \d+%$/ });
      expect(busy.getAttribute("aria-disabled") ?? busy.getAttribute("data-disabled")).not.toBeNull();
      release();
      await waitFor(() => expect(clicked).toEqual([{ name: "Staff sync.mov", href: "blob:recording" }]));
      expect(await (made.mock.calls[0][0] as Blob).text()).toBe(body);
      expect(host.calls.filter((c) => c.method === "work.meetings.recording").map((c) => c.params.offset)).toEqual([0, 2 * 1024 * 1024]);
    } finally {
      click.mockRestore();
      Object.assign(URL, { createObjectURL: was.create, revokeObjectURL: was.revoke });
    }
  });

  it("in the desktop app Download recording writes each range to the file he picks, and a cancelled pick reads nothing", async () => {
    const body = "y".repeat(2 * 1024 * 1024) + "end";
    host.recording = async (params) => ({ name: "Staff sync.m4a", size: body.length, dataBase64: btoa(body.slice(params.offset as number, (params.offset as number) + (params.length as number))) });
    const written: string[] = [];
    let closed = false;
    let cancel = true;
    const asked: string[] = [];
    const picker = vi.fn(async (o: { suggestedName: string }) => {
      asked.push(o.suggestedName);
      if (cancel) throw new DOMException("The user aborted a request.", "AbortError");
      return { createWritable: async () => ({ write: async (part: Uint8Array) => void written.push(new TextDecoder().decode(part)), close: async () => void (closed = true) }) };
    });
    Object.assign(window, { showSaveFilePicker: picker });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    try {
      await seat(sampleMeeting({ title: "Staff sync" }));
      const download = async () => {
        fireEvent.click(screen.getByRole("button", { name: "More" }));
        fireEvent.click(await screen.findByRole("menuitem", { name: "Download recording" }));
      };
      await download();
      await waitFor(() => expect(asked).toEqual(["Staff sync.m4a"]));
      expect(host.calls.filter((c) => c.method === "work.meetings.recording")).toHaveLength(0);
      cancel = false;
      await download();
      await waitFor(() => expect(closed).toBe(true));
      expect(written.join("")).toBe(body);
      expect(written).toHaveLength(2);
      expect(click).not.toHaveBeenCalled();
    } finally {
      click.mockRestore();
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    }
  });

  it("marks a task that waits with the add-task glyph and a filed one with LifeOS's", async () => {
    const { container } = await seat(sampleMeeting({ notes: SAMPLE_NOTES }));
    await waitFor(() => expect(container.querySelector('[data-task="a1"]')).toBeTruthy());
    expect(container.querySelector('[data-task="a1"] [aria-label="Waiting for you"]')).toBeTruthy();
    const filed = container.querySelector('[data-task="a4"] [aria-label="In LifeOS"]')!;
    expect(filed.querySelector("circle")?.getAttribute("r")).toBe("9");
  });

  it("an unnamed speaker whose voice is near a kept one shows the name offered at its first turn, never applied", async () => {
    const { container } = await seat(sampleMeeting());
    await waitFor(() => expect(container.querySelector('[data-turn="s10"]')).toBeTruthy());
    expect(container.querySelector('[data-turn="s10"]')!.textContent).toContain("Speaker 416:03Sounds like Coach Reyes");
  });

  it("a host that does not answer says so on the state line, with Retry, never as an empty meeting", async () => {
    host.down = true;
    const { container } = await seat(sampleMeeting());
    await waitFor(() => expect(container.querySelector("[data-canvas-state=failed]")?.textContent).toContain("Couldn't open this meeting"));
    expect(container.querySelector("[data-meeting-empty]")).toBeNull();
    // The failure is the state line's alone: no skeleton pulses under it, and the bar holds no bone.
    expect(container.querySelector("[data-meeting-skeleton]")).toBeNull();
    expect(container.querySelector("[data-meeting-bar-bone]")).toBeNull();
    host.down = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(container.querySelector("[data-meeting=ready]")).toBeTruthy());
    expect(container.querySelector("[data-canvas-state]")).toBeNull();
  });

  it("Find gives way to the stepper while tasks wait, and comes back once none do", async () => {
    host.decide = (params) => {
      const ids = params.actionIds as string[];
      host.meeting = sampleMeeting({ rev: 5, notes: { ...SAMPLE_NOTES, actions: SAMPLE_NOTES.actions.map((a) => (ids.includes(a.id) ? { ...a, state: "filed" as const, lifeosTaskId: "t9" } : a)) } });
      return { meeting: host.meeting, failed: [] };
    };
    const { container } = await seat(sampleMeeting({ notes: SAMPLE_NOTES }));
    const bar = await waitFor(() => container.querySelector("[data-canvas-bar]") as HTMLElement);
    await waitFor(() => expect(within(bar).getByText("1/3")).toBeTruthy());
    expect(within(bar).queryByRole("button", { name: "Find" })).toBeNull();
    const waiting = SAMPLE_NOTES.actions.filter((a) => a.state === "proposed").map((a) => a.id);
    await act(async () => {
      await host.decide!({ actionIds: waiting });
      push(host.meeting!);
    });
    await waitFor(() => expect(within(bar).getByRole("button", { name: "Find" })).toBeTruthy());
    expect(within(bar).queryByRole("toolbar", { name: "Review changes" })).toBeNull();
  });

  it("while the meeting loads the bar holds a bone where its tools will be", async () => {
    let release!: () => void;
    host.hold = new Promise<void>((r) => (release = r));
    const { container } = await seat(sampleMeeting());
    expect(container.querySelector("[data-meeting-skeleton]")).toBeTruthy();
    await waitFor(() => expect(container.querySelector("[data-canvas-bar] [data-meeting-bar-bone]")).toBeTruthy());
    await act(async () => release());
    await waitFor(() => expect(container.querySelector("[data-meeting=ready]")).toBeTruthy());
    expect(container.querySelector("[data-meeting-bar-bone]")).toBeNull();
  });

  it("a recording that would not play says so on the one state line with Retry, never as a red line of its own", async () => {
    const { container } = await seat(sampleMeeting());
    await waitFor(() => expect(container.querySelector("[data-meeting=ready]")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() => expect(container.querySelector("[data-canvas-state=failed]")?.textContent).toContain("The recording did not play"));
    expect(container.querySelector("[data-canvas-state=failed]")!.textContent).toContain("It could not be read");
    expect(container.querySelector("[data-meeting] .text-destructive")).toBeNull();
    // The player keeps its row; Retry reads the copy again.
    expect(container.querySelector("[data-meeting-player]")).toBeTruthy();
    fireEvent.click(within(container.querySelector("[data-canvas-state]") as HTMLElement).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(container.querySelector("[data-canvas-state=failed]")?.textContent).toContain("The recording did not play"));
  });

  it("a turn's minute is a button: the keyboard reaches it and it seeks", async () => {
    const { container } = await seat(sampleMeeting());
    await waitFor(() => expect(container.querySelector("[data-meeting=ready]")).toBeTruthy());
    const minute = screen.getByRole("button", { name: "Go to 16:03" });
    fireEvent.click(minute);
    expect(time(container)).toBe("16:03 / 42:10");
  });

  it("a start the host never answered says so in the transcript's place, and Retry asks again", async () => {
    host.refuseStart = true;
    const { container } = await seat(null);
    await waitFor(() => expect(container.querySelector("[data-meeting-failed]")?.textContent).toContain("Could not open the recordingsocket closed"));
    host.refuseStart = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(container.querySelector("[data-meeting=transcribing]")).toBeTruthy());
  });

  it("a meeting that changed while its tab was away is fetched again when it shows", async () => {
    const view = await seat(sampleMeeting({ status: "transcribing", rev: 2, segments: [], progress: { phase: "speakers", done: 0, total: 1 } }));
    await waitFor(() => expect(view.container.querySelector("[data-meeting=transcribing]")).toBeTruthy());
    view.unmount();
    // The push comes while nothing shows the meeting.
    push(sampleMeeting({ rev: 3 }));
    const again = render(
      <CanvasSeat session={{ id: "t1", environmentId: "local" }}>
        <div />
      </CanvasSeat>,
    );
    await waitFor(() => expect(again.container.querySelector("[data-meeting=ready]")).toBeTruthy());
  });
});
