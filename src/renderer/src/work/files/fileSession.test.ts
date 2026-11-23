import { describe, expect, it } from "vitest";
import type { FileSaved } from "@shared/contract-work-files";
import type { SavedLine } from "../canvas/kind";
import { FileSession, SAVE_AFTER_MS, type FileSessionHost } from "./fileSession";
import { decodeText, encodeText, savedWords, triedAsText, whenWords } from "./fileText";

/** The file kind's session (fileSession.ts) against a stand-in host that keeps one file, and the words of the save line. */

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const NOW = new Date(2026, 10, 23, 14, 30).getTime();
const AT = (h: number, m: number): number => new Date(2026, 10, 23, h, m).getTime();

/** A host holding one file: versions are counted, a write names the version it read. */
function standIn(start: string, o: { locked?: string; name?: string } = {}) {
  const file = { text: start, version: 1, changed: AT(13, 52), gone: false };
  const lines: (SavedLine | null)[] = [];
  const said: string[] = [];
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const timers: (() => void)[] = [];
  let down = false;
  const host: FileSessionHost = {
    async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      if (down) throw new Error("not connected");
      if (method === "work.files.read") return { data: b64(file.text), size: Buffer.byteLength(file.text), version: `v${file.version}`, changed: file.changed, end: true, ...(o.locked ? { locked: o.locked } : {}) } as T;
      if (method === "work.files.stat") return { entries: [file.gone ? null : { key: "k", ref: null, folder: null, name: o.name ?? "Notes.md", kind: "text", size: Buffer.byteLength(file.text), changed: file.changed }] } as T;
      if (method === "work.files.write") {
        if (params.copy) return { copy: { key: "c", ref: null, folder: null, name: "Notes (mine).md", kind: "text" } } as T;
        if (file.gone) return { conflict: { gone: true } } satisfies FileSaved as T;
        if (params.version !== `v${file.version}`) return { conflict: { version: `v${file.version}`, changed: file.changed } } satisfies FileSaved as T;
        file.text = params.text as string;
        file.version += 1;
        file.changed += 60_000;
        return { version: `v${file.version}`, changed: file.changed } satisfies FileSaved as T;
      }
      throw new Error(`unexpected ${method}`);
    },
    saved: (line) => void lines.push(line),
    say: (text) => void said.push(text),
    now: () => NOW,
    setTimeout: (fn) => timers.push(fn),
    clearTimeout: () => void timers.splice(0),
  };
  const session = new FileSession(host, { workspaceId: "w1", itemId: "i1", source: { at: "file", host: "box", path: `/w/${o.name ?? "Notes.md"}` }, name: o.name ?? "Notes.md" });
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
  return { session, file, lines, said, calls, timers, theirs, words, fire, setDown: (on: boolean) => void (down = on) };
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
    expect(h.words()).toBe("Saving…");
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

  it("never writes over a second writer: the line says the file changed, with Reload and Keep mine as a copy", async () => {
    const h = standIn("first\n");
    await h.session.load();
    h.theirs("theirs\n");
    h.session.edit("mine\n");
    await h.fire();
    expect(h.file.text).toBe("theirs\n");
    const line = h.lines.at(-1)!;
    expect(savedWords(line, "Events", NOW)).toBe("This file changed at 2:04 PM");
    expect(line.actions?.map((a) => a.label)).toEqual(["Reload", "Keep mine as a copy"]);
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
    expect(line.actions?.map((a) => a.label)).toEqual(["Keep mine as a copy"]);
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

  it("sends what waits when the tab closes under the editor", async () => {
    const h = standIn("first\n");
    await h.session.load();
    h.session.edit("typed and closed\n");
    h.session.dispose();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.file.text).toBe("typed and closed\n");
    // Nothing more is said to a frame that has gone.
    expect(h.lines.at(-1)).toEqual({ state: "saving" });
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
    expect(say({ state: "readonly", detail: "a mail's file" })).toBe("Read only: a mail's file");
    expect(say({ state: "copy", detail: "MacBook" })).toBe("A copy from MacBook. Changes stay here");
    expect(say({ state: "downloading", detail: "2.1 of 8.4 MB" })).toBe("Downloading 2.1 of 8.4 MB");
    expect(say({ state: "asleep", detail: "The Windows VM", at: AT(13, 40) })).toBe("The Windows VM is asleep. This is the copy from 1:40 PM");
    expect(whenWords(AT(9, 5), NOW)).toBe("9:05 AM");
  });
});
