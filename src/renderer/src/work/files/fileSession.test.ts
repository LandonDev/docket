import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FileSaved } from "@shared/contract-work-files";
import type { SavedLine } from "../canvas/kind";
import { DraftStore } from "../../../../main/drafts";
import { FileSession, SAVE_AFTER_MS, type DraftsPort, type FileSessionHost } from "./fileSession";
import { decodeText, encodeText, savedWords, triedAsText, whenWords } from "./fileText";

/** The file kind's session (fileSession.ts) against a stand-in host that keeps one file, and the words of the save line. */

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const NOW = new Date(2026, 10, 23, 14, 30).getTime();
const AT = (h: number, m: number): number => new Date(2026, 10, 23, h, m).getTime();

/** A host holding one file: versions are counted, a write names the version it read. */
function standIn(start: string, o: { locked?: string; name?: string; drafts?: DraftsPort; file?: { text: string; version: number; changed: number; gone: boolean; path: string } } = {}) {
  const file = o.file ?? { text: start, version: 1, changed: AT(13, 52), gone: false, path: `/w/${o.name ?? "Notes.md"}` };
  /** The file is not at the path a call names: deleted, or renamed away from it. */
  const goneFrom = (params: Record<string, unknown>): boolean => file.gone || ((params.ref ?? (params.refs as unknown[])?.[0]) as { path: string }).path !== file.path;
  const lines: (SavedLine | null)[] = [];
  const said: string[] = [];
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  /** the edit's pause, by its handle; the save line's own wake is kept apart (`wakes`) so `fire` sends without moving the clock */
  const timers: (() => void)[] = [];
  const wakes = new Map<number, () => void>();
  let ids = 0;
  let clock = NOW;
  let down = false;
  /** the next write lands, and its answer is lost on the way back */
  let lose = false;
  const host: FileSessionHost = {
    async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      if (down) throw new Error("not connected");
      if (method === "work.files.read") return { data: b64(file.text), size: Buffer.byteLength(file.text), version: `v${file.version}`, changed: file.changed, end: true, ...(o.locked ? { locked: o.locked } : {}) } as T;
      if (method === "work.files.stat") return { entries: [goneFrom(params) ? null : { key: "k", ref: null, folder: null, name: o.name ?? "Notes.md", kind: "text", size: Buffer.byteLength(file.text), changed: file.changed }] } as T;
      if (method === "work.files.write") {
        if (params.copy) return { copy: { key: "c", ref: null, folder: null, name: "Notes (mine).md", kind: "text" } } as T;
        if (goneFrom(params)) return { conflict: { gone: true } } satisfies FileSaved as T;
        if (params.version !== `v${file.version}`) return { conflict: { version: `v${file.version}`, changed: file.changed } } satisfies FileSaved as T;
        file.text = params.text as string;
        file.version += 1;
        file.changed += 60_000;
        if (lose) {
          lose = false;
          throw new Error("The request timed out.");
        }
        return { version: `v${file.version}`, changed: file.changed } satisfies FileSaved as T;
      }
      throw new Error(`unexpected ${method}`);
    },
    saved: (line) => void lines.push(line),
    say: (text) => void said.push(text),
    now: () => clock,
    // The pause's timer is the one at SAVE_AFTER_MS; anything else is the line asking again once the clock has moved.
    setTimeout: (fn, ms) => {
      if (ms === SAVE_AFTER_MS) return void timers.push(fn);
      wakes.set(++ids, fn);
      return ids;
    },
    clearTimeout: (id) => (typeof id === "number" ? void wakes.delete(id) : void timers.splice(0)),
    ...(o.drafts ? { drafts: o.drafts } : {}),
  };
  const session = new FileSession(host, { workspaceId: "w1", itemId: "i1", source: { at: "file", host: "box", path: `/w/${o.name ?? "Notes.md"}` }, name: o.name ?? "Notes.md", holder: "box" });
  /** Another writer changes the file under the session. */
  const theirs = (text: string): void => void Object.assign(file, { text, version: file.version + 1, changed: Math.max(AT(14, 4), file.changed + 60_000) });
  const words = (): string | null => {
    const last = lines.at(-1);
    return last ? savedWords(last, "Events", NOW) : null;
  };
  const fire = async (): Promise<void> => {
    for (const fn of timers.splice(0)) fn();
    await session.flush();
  };
  /** The clock moves on, and the line asks again where it said it would. */
  const tick = (ms: number): void => {
    clock += ms;
    for (const [id, fn] of [...wakes]) {
      wakes.delete(id);
      fn();
    }
  };
  return { session, file, lines, said, calls, timers, theirs, words, fire, tick, setDown: (on: boolean) => void (down = on), loseNext: () => void (lose = true) };
}

describe("a text file open", () => {
  it("reads it once and says when it was last saved and where", async () => {
    const h = standIn("first line\n");
    await h.session.load();
    expect(h.session.getSnapshot()).toEqual({ is: "text", text: "first line\n", rev: 0, locked: null });
    expect(h.words()).toBe("Saved 1:52 PM in Events");
    expect(h.calls.map((c) => c.method)).toEqual(["work.files.read"]);
  });

  it("saves as he types, after a pause, naming the version it read: no save press", async () => {
    const h = standIn("first\n");
    await h.session.load();
    h.session.edit("first\nsecond\n");
    // Inside the pause the last Saved line stays (calm.ts): nothing has gone yet.
    expect(h.words()).toBe("Saved 1:52 PM in Events");
    expect(h.timers).toHaveLength(1);
    expect(SAVE_AFTER_MS).toBeLessThanOrEqual(1000);
    h.session.edit("first\nsecond\nthird\n");
    // One timer: the pause starts again with each change.
    expect(h.timers).toHaveLength(1);
    await h.fire();
    expect(h.file.text).toBe("first\nsecond\nthird\n");
    expect(h.calls.filter((c) => c.method === "work.files.write")).toHaveLength(1);
    expect(h.words()).toBe("Saved 1:53 PM in Events");
    expect(h.session.dirty).toBe(false);
    // The next save names the version the last one answered.
    h.session.edit("again\n");
    await h.fire();
    expect(h.calls.at(-1)!.params.version).toBe("v2");
    expect(h.file.text).toBe("again\n");
  });

  it("never writes over a second writer: the line says the file changed, with Reload and Keep Both", async () => {
    const h = standIn("first\n");
    await h.session.load();
    h.theirs("theirs\n");
    h.session.edit("mine\n");
    await h.fire();
    expect(h.file.text).toBe("theirs\n");
    const line = h.lines.at(-1)!;
    expect(savedWords(line, "Events", NOW)).toBe("This file changed at 2:04 PM");
    expect(line.actions?.map((a) => a.label)).toEqual(["Reload", "Keep Both"]);
    // More typing while it stands sends nothing.
    const writes = h.calls.filter((c) => c.method === "work.files.write").length;
    h.session.edit("mine, more\n");
    await h.fire();
    expect(h.calls.filter((c) => c.method === "work.files.write")).toHaveLength(writes);
    // Reload takes the file as it is now, in a new buffer.
    await line.actions![0]!.run();
    expect(h.session.getSnapshot()).toMatchObject({ is: "text", text: "theirs\n", rev: 1 });
    expect(h.words()).toBe("Saved 2:04 PM in Events");
  });

  it("keeps his text as a copy beside the file and then shows the file as it is", async () => {
    const h = standIn("first\n");
    await h.session.load();
    h.theirs("theirs\n");
    h.session.edit("mine\n");
    await h.fire();
    await h.lines.at(-1)!.actions![1]!.run();
    expect(h.calls.at(-2)).toMatchObject({ method: "work.files.write", params: { copy: true, text: "mine\n" } });
    expect(h.said).toEqual(["Kept as Notes (mine).md"]);
    expect(h.session.getSnapshot()).toMatchObject({ is: "text", text: "theirs\n" });
    expect(h.file.text).toBe("theirs\n");
  });

  it("says a file that was moved or deleted is gone, and never makes it again", async () => {
    const h = standIn("first\n");
    await h.session.load();
    h.file.gone = true;
    h.session.edit("mine\n");
    await h.fire();
    const line = h.lines.at(-1)!;
    expect(savedWords(line, "Events", NOW)).toBe("This file was moved or deleted");
    expect(line.actions?.map((a) => a.label)).toEqual(["Keep Both"]);
  });

  it("follows a rename: what is typed after it goes to the renamed file, by the version it read", async () => {
    const h = standIn("first\n");
    await h.session.load();
    h.file.path = "/w/Revised.md";
    // Typed before the window heard of the rename: the old path answers gone.
    h.session.edit("first\nsecond\n");
    await h.fire();
    expect(h.words()).toBe("This file was moved or deleted");
    h.session.follow({ at: "file", host: "box", path: "/w/Revised.md" });
    await h.session.flush();
    expect(h.file.text).toBe("first\nsecond\n");
    expect(h.words()).toBe("Saved 1:53 PM in Events");
    h.session.edit("first\nsecond\nthird\n");
    await h.session.flush();
    expect(h.calls.filter((c) => c.method === "work.files.write").at(-1)!.params).toMatchObject({ ref: { path: "/w/Revised.md" }, version: "v2" });
    expect(h.file.text).toBe("first\nsecond\nthird\n");
  });

  it("holds changes here while the host is out of reach, says how many wait, and sends them on Retry", async () => {
    const h = standIn("first\n");
    await h.session.load();
    h.setDown(true);
    h.session.edit("a\n");
    h.session.edit("ab\n");
    await h.fire();
    const line = h.lines.at(-1)!;
    expect(savedWords(line, "Events", NOW)).toBe("Offline. 2 changes wait here");
    expect(line.actions?.map((a) => a.label)).toEqual(["Retry"]);
    expect(h.file.text).toBe("first\n");
    h.setDown(false);
    await line.actions![0]!.run();
    expect(h.file.text).toBe("ab\n");
    expect(h.words()).toBe("Saved 1:53 PM in Events");
  });

  it("sends what waited when the link opens again: the line goes from waiting to saving to saved", async () => {
    const h = standIn("first\n");
    await h.session.load();
    h.setDown(true);
    h.session.edit("first\ntyped while away\n");
    await h.fire();
    expect(h.words()).toBe("Offline. 1 change waits here");
    h.setDown(false);
    const sent = h.session.reopened();
    // A failure said at once; the send that follows says Saving… only once it has been out a while.
    expect(h.words()).toBe("Saved 1:52 PM in Events");
    h.tick(600);
    expect(h.words()).toBe("Saving…");
    await sent;
    expect(h.file.text).toBe("first\ntyped while away\n");
    expect(h.calls.filter((c) => c.method === "work.files.write").at(-1)!.params).toMatchObject({ version: "v1" });
    expect(h.words()).toBe("Saved 1:53 PM in Events");
    // Nothing waits: a later reopen sends nothing.
    const before = h.calls.length;
    await h.session.reopened();
    expect(h.calls).toHaveLength(before);
  });

  it("names a send whose answer was lost in the next one, by its bytes' sha256", async () => {
    const h = standIn("first\n");
    await h.session.load();
    h.loseNext();
    h.session.edit("first\nsecond\n");
    await h.session.flush();
    expect(h.words()).toBe("Offline. 1 change waits here");
    const writes = () => h.calls.filter((c) => c.method === "work.files.write").map((c) => c.params);
    expect(writes()[0]).not.toHaveProperty("tried");
    h.session.edit("first\nsecond\nthird\n");
    await h.session.flush();
    // Same base, and the lost send named: the host goes over his own words there, never anyone else's.
    expect(writes()[1]).toMatchObject({ version: "v1", tried: [createHash("sha256").update(writes()[0]!.text as string).digest("hex")] });
  });

  it("asks before a reopen writes over a change made there meanwhile", async () => {
    const h = standIn("first\n");
    await h.session.load();
    h.setDown(true);
    h.session.edit("mine\n");
    await h.fire();
    h.theirs("theirs\n");
    h.setDown(false);
    await h.session.reopened();
    expect(h.file.text).toBe("theirs\n");
    expect(h.words()).toBe("This file changed at 2:04 PM");
  });

  it("takes a change made elsewhere at once when nothing waits here, and says so when something does", async () => {
    const h = standIn("first\n");
    await h.session.load();
    await h.session.check();
    expect(h.calls.map((c) => c.method)).toEqual(["work.files.read", "work.files.stat"]);
    h.theirs("theirs\n");
    await h.session.check();
    expect(h.session.getSnapshot()).toMatchObject({ is: "text", text: "theirs\n", rev: 1 });
    h.session.edit("mine\n");
    h.theirs("theirs again\n");
    await h.session.check();
    expect(savedWords(h.lines.at(-1)!, null, NOW)).toBe("This file changed at 2:05 PM");
    expect(h.session.getSnapshot()).toMatchObject({ text: "theirs\n" });
  });

  it("keeps the last Saved line through the pause and a short send, says Saving… past them, and never names a time later than the host's answer", async () => {
    const h = standIn("first\n");
    await h.session.load();
    h.session.edit("first\nsecond\n");
    expect(h.words()).toBe("Saved 1:52 PM in Events");
    // Edits that waited past their pause with nothing sent (the timer has not run): Saving….
    h.tick(SAVE_AFTER_MS);
    expect(h.words()).toBe("Saving…");
    await h.fire();
    // The answer's time, never the window's clock.
    expect(h.lines.at(-1)).toEqual({ state: "saved", at: h.file.changed });
    expect(h.file.changed).toBeLessThan(NOW);
    // A failure inside 600 ms is said at once.
    h.setDown(true);
    h.session.edit("third\n");
    const failing = h.session.flush();
    expect(h.words()).toBe("Saved 1:53 PM in Events");
    await failing;
    expect(h.words()).toBe("Offline. 1 change waits here");
    expect(h.lines.filter((l) => l?.state === "saving")).toHaveLength(1);
  });

  it("sends what waits when the tab closes under the editor", async () => {
    const h = standIn("first\n");
    await h.session.load();
    h.session.edit("typed and closed\n");
    h.session.dispose();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.file.text).toBe("typed and closed\n");
    // Nothing more is said to a frame that has gone, and nothing it said claimed the close's send.
    expect(h.lines.at(-1)).toEqual({ state: "saved", at: AT(13, 52) });
  });

  it("is read only where the host would refuse a save: nothing typed is kept or sent", async () => {
    const h = standIn("team text\n", { locked: "Nothing can be changed in General from here." });
    await h.session.load();
    expect(h.session.getSnapshot()).toMatchObject({ is: "text", locked: "Nothing can be changed in General from here." });
    expect(h.words()).toBe("Read only. Nothing can be changed in General from here");
    h.session.edit("x");
    expect(h.session.dirty).toBe(false);
    // A copy says nothing of its own: the frame names the computer its file is on.
    const copy = standIn("x", { locked: "This is a copy. Changes are made where the file is kept." });
    await copy.session.load();
    expect(copy.lines.at(-1)).toBeNull();
  });

  it("keeps a file's mark and line ends through a save", async () => {
    const h = standIn("﻿one\r\ntwo\r\n");
    await h.session.load();
    expect(h.session.getSnapshot()).toMatchObject({ text: "one\ntwo\n" });
    h.session.edit("one\ntwo\nthree\n");
    await h.fire();
    expect(h.file.text).toBe("﻿one\r\ntwo\r\nthree\r\n");
  });
});

describe("a file that is not text", () => {
  it("shows its facts, read from its row, and never reads its bytes", async () => {
    const h = standIn("PK", { name: "bundle.zip" });
    await h.session.load();
    expect(h.session.getSnapshot()).toMatchObject({ is: "facts", entry: { size: 2 } });
    expect(h.calls.map((c) => c.method)).toEqual(["work.files.stat"]);
    expect(h.lines.at(-1)).toBeNull();
  });

  it("tries a name it does not know as text, and falls back to its facts when its bytes are not", async () => {
    const text = standIn("all: build\n", { name: "Makefile" });
    await text.session.load();
    expect(text.session.getSnapshot()).toMatchObject({ is: "text", text: "all: build\n" });
    const bin = standIn("a\0b", { name: "thing.xyz" });
    await bin.session.load();
    expect(bin.session.getSnapshot()).toMatchObject({ is: "facts" });
  });
});

describe("the words", () => {
  it("decodes only text it can keep whole, and encodes it back as it was", () => {
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
    expect(decodeText(new TextEncoder().encode("a\0b"))).toBeNull();
    const mixed = decodeText(new TextEncoder().encode("a\r\nb\nc"))!;
    expect(mixed).toEqual({ text: "a\r\nb\nc", bom: false, crlf: false });
    expect(encodeText(mixed.text, mixed)).toBe("a\r\nb\nc");
    const win = decodeText(new TextEncoder().encode("﻿a\r\nb\r\n"))!;
    expect(win).toEqual({ text: "a\nb\n", bom: true, crlf: true });
    expect(encodeText(win.text, win)).toBe("﻿a\r\nb\r\n");
  });

  it("tries text and unknown names as text, up to the size an editor keeps", () => {
    expect(["README.md", "main.ts", "Makefile", ".env", "bundle.zip", "old.xls", "logo.svg"].map((n) => triedAsText(n, 10))).toEqual([true, true, true, true, false, false, false]);
    expect(triedAsText("big.log", 3 * 1024 * 1024)).toBe(false);
  });

  it("says each state of the save line in one plain line", () => {
    const say = (line: SavedLine): string => savedWords(line, "Events", NOW);
    expect(say({ state: "saved", at: AT(13, 52) })).toBe("Saved 1:52 PM in Events");
    expect(say({ state: "saved", at: AT(13, 52), where: "Budgets" })).toBe("Saved 1:52 PM in Budgets");
    expect(savedWords({ state: "saved" }, null, NOW)).toBe("Saved");
    expect(say({ state: "saved", at: new Date(2026, 10, 21, 9, 5).getTime() })).toBe("Saved Nov 21, 9:05 AM in Events");
    expect(say({ state: "saving" })).toBe("Saving…");
    expect(say({ state: "offline", pending: 3 })).toBe("Offline. 3 changes wait here");
    expect(say({ state: "offline", pending: 1 })).toBe("Offline. 1 change waits here");
    expect(say({ state: "conflict", detail: "Dana changed this at 2:04 PM" })).toBe("Dana changed this at 2:04 PM");
    expect(say({ state: "readonly", detail: "a mail's file" })).toBe("Read only, a mail's file");
    expect(say({ state: "copy", detail: "MacBook" })).toBe("A copy from MacBook. Changes stay here");
    expect(say({ state: "downloading", detail: "2.1 of 8.4 MB" })).toBe("Downloading 2.1 of 8.4 MB");
    expect(say({ state: "asleep", detail: "The Windows VM", at: AT(13, 40) })).toBe("The Windows VM is asleep. This is the copy from 1:40 PM");
    expect(whenWords(AT(9, 5), NOW)).toBe("9:05 AM");
  });
});

/** The draft store main keeps (src/main/drafts.ts) on a scratch folder, as one window reaches it; a new store on the folder is the app started again. */
const scratch: string[] = [];
const stores: DraftStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.settled()));
  scratch.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
function draftsAt(dir = (scratch.push(mkdtempSync(join(tmpdir(), "tc-drafts-"))), join(scratch.at(-1)!, "drafts")), window = 1) {
  const store = new DraftStore(dir);
  stores.push(store);
  const port: DraftsPort = { put: (d) => store.put(d, window), drop: (k) => store.drop(k), release: (k) => store.release(k), list: (k) => store.list(k) };
  const place = { workspaceId: "w1", holder: "box", file: JSON.stringify({ at: "file", host: "box", path: "/w/Notes.md" }) };
  return { store, port, dir, kept: async () => (store.releaseOwner(window), store.list(place)) };
}
const labels = (line: SavedLine | null | undefined): string[] => line?.actions?.map((a) => a.label) ?? [];

describe("drafts survive a crash, a close and a link drop", () => {
  it("keeps each edit the host has not taken on this computer, by the version it was made on, and lets it go once taken", async () => {
    const d = draftsAt();
    const h = standIn("first\n", { drafts: d.port });
    await h.session.load();
    h.setDown(true);
    h.session.edit("first\nsecond\n");
    await h.fire();
    expect((await d.kept()).map((x) => [x.base, x.body.text])).toEqual([["v1", "first\nsecond\n"]]);
    h.setDown(false);
    await h.session.reopened();
    await d.store.settled();
    expect(await d.kept()).toEqual([]);
  });

  it("moves a draft typed after a save onto the version that save answered", async () => {
    const d = draftsAt();
    const h = standIn("first\n", { drafts: d.port });
    await h.session.load();
    h.session.edit("one\n");
    await h.fire();
    h.setDown(true);
    h.session.edit("one\ntwo\n");
    await d.store.settled();
    expect((await d.kept()).map((x) => [x.base, x.body.text])).toEqual([["v2", "one\ntwo\n"]]);
  });

  it("types with the link closed, quits, restarts: the draft is offered first, and Restore sends it by its version", async () => {
    const before = draftsAt();
    const h = standIn("first\n", { drafts: before.port });
    await h.session.load();
    h.setDown(true);
    h.session.edit("first\nsecond\n");
    h.session.edit("first\nsecond\nthird\n");
    await h.fire();
    await before.store.settled();
    // The window went with no word: the app starts again on the same folder.
    const after = draftsAt(before.dir, 2);
    const again = standIn("", { drafts: after.port, file: h.file });
    await again.session.load();
    expect(again.session.getSnapshot()).toMatchObject({ is: "text", text: "first\n", offer: true });
    expect(again.words()).toBe("Edits from 2:30 PM were not saved");
    expect(labels(again.lines.at(-1))).toEqual(["Restore", "Discard"]);
    // Nothing is typed over the offer: he answers it first.
    again.session.edit("typed over it\n");
    expect(again.calls.filter((c) => c.method === "work.files.write")).toEqual([]);
    await again.lines.at(-1)!.actions![0]!.run();
    expect(again.file.text).toBe("first\nsecond\nthird\n");
    expect(again.calls.find((c) => c.method === "work.files.write")?.params).toMatchObject({ version: "v1" });
    expect(again.session.getSnapshot()).toEqual({ is: "text", text: "first\nsecond\nthird\n", rev: 1, locked: null });
    expect(again.words()).toBe("Saved 1:53 PM in Events");
    await after.store.settled();
    expect(await after.kept()).toEqual([]);
  });

  it("keeps both when the file changed since: the draft goes beside it, never over the newer file", async () => {
    const before = draftsAt();
    const h = standIn("first\n", { drafts: before.port });
    await h.session.load();
    h.setDown(true);
    h.session.edit("mine\n");
    await h.fire();
    h.theirs("theirs, later\n");
    await before.store.settled();
    const after = draftsAt(before.dir, 2);
    const again = standIn("", { drafts: after.port, file: h.file });
    await again.session.load();
    expect(again.words()).toBe("Edits from 2:30 PM were not saved. The file changed since");
    expect(labels(again.lines.at(-1))).toEqual(["Keep Both", "Discard"]);
    await again.lines.at(-1)!.actions![0]!.run();
    expect(again.calls.find((c) => c.method === "work.files.write")?.params).toMatchObject({ copy: true, text: "mine\n", version: "v1" });
    expect(again.file.text).toBe("theirs, later\n");
    expect(again.said).toEqual(["Kept as Notes (mine).md"]);
    expect(again.session.getSnapshot()).toEqual({ is: "text", text: "theirs, later\n", rev: 0, locked: null });
    await after.store.settled();
    expect(await after.kept()).toEqual([]);
  });

  it("drops a draft the file already holds (its save landed, its answer did not), and one he discards", async () => {
    const before = draftsAt();
    before.port.put({ workspaceId: "w1", holder: "box", file: JSON.stringify({ at: "file", host: "box", path: "/w/Notes.md" }), base: "v0", name: "Notes.md", at: AT(13, 0), body: { kind: "text", text: "first\n", bom: false, crlf: false } });
    before.port.put({ workspaceId: "w1", holder: "box", file: JSON.stringify({ at: "file", host: "box", path: "/w/Notes.md" }), base: "v1", name: "Notes.md", at: AT(14, 0), body: { kind: "text", text: "unwanted\n", bom: false, crlf: false } });
    await before.store.settled();
    const after = draftsAt(before.dir, 2);
    const h = standIn("first\n", { drafts: after.port });
    await h.session.load();
    expect(h.words()).toBe("Edits from 2:00 PM were not saved");
    h.lines.at(-1)!.actions![1]!.run();
    expect(h.words()).toBe("Saved 1:52 PM in Events");
    await after.store.settled();
    expect(await after.kept()).toEqual([]);
    expect(h.file.text).toBe("first\n");
  });

  it("lets a closed tab's unsent draft go to the next open in the same window", async () => {
    const d = draftsAt();
    const h = standIn("first\n", { drafts: d.port });
    await h.session.load();
    h.setDown(true);
    h.session.edit("closed while away\n");
    h.session.dispose();
    await new Promise((r) => setTimeout(r, 0));
    h.setDown(false);
    const again = standIn("", { drafts: d.port, file: h.file });
    await again.session.load();
    expect(again.words()).toBe("Edits from 2:30 PM were not saved");
  });
});
