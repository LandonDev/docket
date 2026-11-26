import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FileSaved } from "@shared/contract-work-files";
import type { SavedLine } from "../canvas/kind";
import { DraftStore } from "../../../../main/drafts";
import { FileSession, JOURNAL_MS, SAVE_AFTER_MS, type DraftsPort, type FileSessionHost } from "./fileSession";
import { decodeText, encodeText, offlineNamed, savedWords, triedAsText, whenWords } from "./fileText";

/** The file kind's session (fileSession.ts) against a stand-in host that keeps one file, and the words of the save line. */

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const NOW = new Date(2026, 10, 23, 14, 30).getTime();
const AT = (h: number, m: number): number => new Date(2026, 10, 23, h, m).getTime();

/** A host holding one file: versions are counted, a write names the version it read. */
function standIn(start: string, o: { locked?: string; name?: string; drafts?: DraftsPort; unlisted?: boolean; file?: { text: string; version: number; changed: number; gone: boolean; path: string } } = {}) {
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
  /** what happens while the next read is out (he types) */
  let duringRead: (() => void) | null = null;
  /** what happens while the next Keep Both is out (he types) */
  let duringKeep: (() => void) | null = null;
  const host: FileSessionHost = {
    async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      if (down) throw new Error("not connected");
      if (method === "work.files.read") {
        if (params.length !== 1) {
          const typing = duringRead;
          duringRead = null;
          typing?.();
        }
        if (o.unlisted && params.itemId !== "i1") throw new Error("That tab holds no copy to read.");
        if (goneFrom(params)) throw new Error("That file or folder is not there any more.");
        return { data: b64(file.text), size: Buffer.byteLength(file.text), version: `v${file.version}`, changed: file.changed, end: true, ...(o.locked ? { locked: o.locked } : {}) } as T;
      }
      if (method === "work.files.stat") return { entries: [o.unlisted || goneFrom(params) ? null : { key: "k", ref: null, folder: null, name: o.name ?? "Notes.md", kind: "text", size: Buffer.byteLength(file.text), changed: file.changed }] } as T;
      if (method === "work.files.write") {
        if (params.copy) {
          const typing = duringKeep;
          duringKeep = null;
          typing?.();
        }
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
  return { session, file, lines, said, calls, timers, theirs, words, fire, tick, setDown: (on: boolean) => void (down = on), loseNext: () => void (lose = true), whileReading: (fn: () => void) => void (duringRead = fn), whileKeeping: (fn: () => void) => void (duringKeep = fn) };
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
    // The send that follows says Saving… only once it has been out a while; until then the words still wait, never Saved.
    expect(h.words()).toBe("Offline. 1 change waits here");
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
    expect(h.calls.at(-1)).toMatchObject({ method: "work.files.read", params: { itemId: "i1", length: 1 } });
    h.theirs("theirs\n");
    await h.session.check();
    expect(h.session.getSnapshot()).toMatchObject({ is: "text", text: "theirs\n", rev: 1 });
    h.session.edit("mine\n");
    h.theirs("theirs again\n");
    await h.session.check();
    expect(savedWords(h.lines.at(-1)!, null, NOW)).toBe("This file changed at 2:05 PM");
    expect(h.session.getSnapshot()).toMatchObject({ text: "theirs\n" });
  });

  it("a change the folder said while the first read was out is read again before the line says Saved (M6 review, finding 5)", async () => {
    const h = standIn("version A\n");
    const host = (h.session as unknown as { host: FileSessionHost }).host;
    const real = host.request.bind(host);
    let first = true;
    host.request = async <T,>(method: string, params: Record<string, unknown>): Promise<T> => {
      const got = await real<T>(method, params);
      if (method === "work.files.read" && first && params.length !== 1) {
        // The answer holds A; before it reaches the window, B is written and the folder's push arrives.
        first = false;
        h.theirs("version B\n");
        void h.session.check();
      }
      return got;
    };
    await h.session.load();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(h.session.getSnapshot()).toMatchObject({ is: "text", text: "version B\n" });
    expect(h.calls.filter((c) => c.method === "work.files.read" && c.params.length !== 1)).toHaveLength(2);
    // Never Saved for A: every Saved line names B's change.
    expect(h.lines.filter((l) => l?.state === "saved").every((l) => l?.state === "saved" && l.at === h.file.changed)).toBe(true);
  });

  it("an edit made while that second read is out stays, and the line says the file changed (finding 5)", async () => {
    const h = standIn("version A\n");
    await h.session.load();
    const host = (h.session as unknown as { host: FileSessionHost }).host;
    const real = host.request.bind(host);
    let once = true;
    host.request = async <T,>(method: string, params: Record<string, unknown>): Promise<T> => {
      const got = await real<T>(method, params);
      if (method === "work.files.read" && params.length !== 1 && once) {
        once = false;
        h.theirs("version C\n");
        void h.session.check();
        h.session.edit("mine\n");
      }
      return got;
    };
    h.theirs("version B\n");
    await h.session.reload();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(savedWords(h.lines.at(-1)!, null, NOW)).toMatch(/^This file changed at/);
    expect(h.session.dirty).toBe(true);
  });

  it("keeps an unlisted open copy writable after a scoped look and a failed look", async () => {
    const h = standIn("first\n", { unlisted: true });
    await h.session.load();
    await h.session.check();
    expect(h.calls.at(-1)).toMatchObject({ method: "work.files.read", params: { itemId: "i1", length: 1 } });
    h.setDown(true);
    await h.session.check();
    expect(h.words()).toBe("Saved 1:52 PM in Events");
    h.setDown(false);
    h.session.edit("mine\n");
    await h.fire();
    expect(h.file.text).toBe("mine\n");
  });

  it("keeps both conflict actions on an unlisted copy across another look and holds the save", async () => {
    const h = standIn("first\n", { unlisted: true });
    await h.session.load();
    h.session.edit("mine\n");
    h.theirs("theirs\n");
    await h.session.check();
    expect(h.words()).toBe("This file changed at 2:04 PM");
    h.setDown(true);
    await h.session.check();
    h.setDown(false);
    await h.session.check();
    await h.fire();
    expect(h.words()).toBe("This file changed at 2:04 PM");
    expect(h.lines.at(-1)?.actions?.map((a) => a.label)).toEqual(["Reload", "Keep Both"]);
    expect(h.calls.some((c) => c.method === "work.files.write")).toBe(false);
    expect(h.file.text).toBe("theirs\n");
  });

  it("holds the save after the scoped read confirms removal", async () => {
    const h = standIn("first\n", { unlisted: true });
    await h.session.load();
    h.session.edit("mine\n");
    h.file.gone = true;
    await h.session.check();
    await h.fire();
    expect(h.words()).toBe("This file was moved or deleted");
    expect(h.lines.at(-1)?.actions?.map((a) => a.label)).toEqual(["Keep Both"]);
    expect(h.calls.some((c) => c.method === "work.files.write")).toBe(false);
  });

  it("keeps keys typed while a change made elsewhere is read: nothing he typed is thrown away, and the line says the file changed", async () => {
    const h = standIn("first\n");
    await h.session.load();
    h.theirs("theirs\n");
    // Ask is fixing the file while he types: his key lands while the session reads their version.
    h.whileReading(() => h.session.edit("first, mine\n"));
    await h.session.check();
    expect(h.session.getSnapshot()).toMatchObject({ is: "text", text: "first\n", rev: 0 });
    expect(h.session.dirty).toBe(true);
    const line = h.lines.at(-1)!;
    expect(savedWords(line, null, NOW)).toBe("This file changed at 2:04 PM");
    expect(line.actions?.map((a) => a.label)).toEqual(["Reload", "Keep Both"]);
    // Nothing is sent over theirs; Keep Both puts his words beside the file.
    await h.fire();
    expect(h.file.text).toBe("theirs\n");
    await line.actions![1]!.run();
    expect(h.calls.find((c) => c.method === "work.files.write")?.params).toMatchObject({ copy: true });
    expect(h.said).toEqual(["Kept as Notes (mine).md"]);
  });

  it("keeps keys typed while Keep Both is out: only the text the copy took is let go, and the rest still waits here", async () => {
    const h = standIn("first\n");
    await h.session.load();
    h.theirs("theirs\n");
    h.session.edit("first, mine\n");
    await h.session.check();
    const line = h.lines.at(-1)!;
    h.whileKeeping(() => h.session.edit("first, mine\nand a line after\n"));
    await line.actions!.find((a) => a.label === "Keep Both")!.run();
    expect(h.said).toEqual(["Kept as Notes (mine).md"]);
    // Not read over: the editor keeps what he typed since, and the line still offers its ways.
    expect(h.session.getSnapshot()).toMatchObject({ is: "text", rev: 0 });
    expect(h.session.dirty).toBe(true);
    expect(h.lines.at(-1)!.actions?.map((a) => a.label)).toEqual(["Reload", "Keep Both"]);
    await h.lines.at(-1)!.actions!.find((a) => a.label === "Keep Both")!.run();
    expect(h.calls.filter((c) => c.method === "work.files.write" && c.params.copy).at(-1)!.params.text).toBe("first, mine\nand a line after\n");
    expect(h.session.dirty).toBe(false);
  });

  it("keeps saying a failed save until a send is answered: a key after it never turns the line back to Saved", async () => {
    const h = standIn("first\n");
    await h.session.load();
    h.setDown(true);
    h.session.edit("a\n");
    await h.fire();
    expect(h.words()).toBe("Offline. 1 change waits here");
    // His next key: the words still wait, and the line says so, counted.
    h.session.edit("ab\n");
    expect(h.words()).toBe("Offline. 2 changes wait here");
    h.tick(SAVE_AFTER_MS + 1);
    expect(h.words()).toBe("Offline. 2 changes wait here");
    // The link back: the next send is answered, and only then is it Saved.
    h.setDown(false);
    await h.fire();
    expect(h.words()).toBe("Saved 1:53 PM in Events");
    h.session.edit("abc\n");
    expect(h.words()).toBe("Saved 1:53 PM in Events");
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

  it("says a refused save as Not saved. with the host's reason and Retry, never Offline", async () => {
    const h = standIn("first\n");
    await h.session.load();
    const request = h.session["host"].request.bind(h.session["host"]);
    h.session["host"].request = (async (method: string, params: Record<string, unknown>) => {
      if (method === "work.files.write") throw new Error("Nothing can be changed in General from here.");
      return request(method, params);
    }) as typeof request;
    h.session.edit("mine\n");
    await h.fire();
    expect(h.words()).toBe("Not saved. Nothing can be changed in General from here.");
    expect(h.lines.at(-1)!.actions!.map((a) => a.label)).toEqual(["Retry"]);
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
  it("gets the facts of an unlisted copy by its open item", async () => {
    const h = standIn("PK", { name: "bundle.zip", unlisted: true });
    await h.session.load();
    expect(h.session.getSnapshot()).toMatchObject({ is: "facts", scoped: true, entry: { kind: "archive", size: 2 } });
    expect(h.calls.at(-1)).toMatchObject({ method: "work.files.read", params: { itemId: "i1", length: 1 } });
  });

  it("says a failed look could not read the file", async () => {
    const h = standIn("PK", { name: "bundle.zip", unlisted: true });
    h.setDown(true);
    await h.session.load();
    expect(h.session.getSnapshot()).toEqual({ is: "failed", error: "not connected" });
  });
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
    expect(say({ state: "downloading", detail: "2.1 of 8.4 MB" })).toBe("Downloading… 2.1 of 8.4 MB");
    // In the frame, Offline names the computer that is not answering, as its family does; unnamed, it stands.
    expect(offlineNamed({ state: "offline", pending: 3 }, "the box")?.words).toBe("The box is not answering. 3 changes wait here");
    expect(offlineNamed({ state: "offline", pending: 1 }, "this Mac")?.words).toBe("This Mac is not answering. 1 change waits here");
    expect(offlineNamed({ state: "offline" }, "the box")?.words).toBe("The box is not answering. Changes wait here");
    expect(offlineNamed({ state: "offline", pending: 2 }, undefined)?.words).toBeUndefined();
    expect(offlineNamed({ state: "saving" }, "the box")?.words).toBeUndefined();
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
    // Inside the journal's span of the first edit: written at its end.
    h.tick(JOURNAL_MS);
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

  it("offers Copy Text in Keep Both's place when the holder cannot keep the draft, and keeps the draft until he lets it go", async () => {
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
    const copied: string[] = [];
    const host = (again.session as unknown as { host: FileSessionHost }).host;
    host.copy = async (text) => void copied.push(text);
    const request = host.request;
    host.request = async (method, params) => (method === "work.files.write" && params.copy ? Promise.reject(new Error("The other computer did not keep the copy.")) : request(method, params));
    await again.session.load();
    await again.lines.at(-1)!.actions![0]!.run();
    expect(again.said).toEqual(["Not kept: The other computer did not keep the copy."]);
    expect(labels(again.lines.at(-1))).toEqual(["Copy Text", "Discard"]);
    await again.lines.at(-1)!.actions![0]!.run();
    expect(copied).toEqual(["mine\n"]);
    expect(again.said.at(-1)).toBe("Copied");
    await after.store.settled();
    expect((await after.kept()).map((x) => x.body.text)).toEqual(["mine\n"]);
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

describe("a key copies nothing", () => {
  const reader = (text: string) => {
    const counted = { reads: 0, length: text.length, read: () => (counted.reads++, text) };
    return counted;
  };

  it("with no draft store, the text an edit hands over is read only when it is sent", async () => {
    const h = standIn("first\n");
    await h.session.load();
    const keys = ["first\na", "first\nab", "first\nabc"].map(reader);
    for (const k of keys) h.session.edit(k);
    expect(keys.map((k) => k.reads)).toEqual([0, 0, 0]);
    await h.fire();
    expect(keys.map((k) => k.reads)).toEqual([0, 0, 1]);
    expect(h.file.text).toBe("first\nabc");
  });

  it("a text of any size is journaled at once, then at most every 250 ms, its last edit kept", async () => {
    const d = draftsAt();
    const h = standIn("first\n", { drafts: d.port });
    await h.session.load();
    h.setDown(true);
    const long = (n: number) => reader(`${"x".repeat(100_000)}${n}`);
    const short = reader("first\nshort\n");
    const keys = [short, long(1), long(2), long(3)];
    for (const k of keys) h.session.edit(k);
    expect(keys.map((k) => k.reads)).toEqual([1, 0, 0, 0]);
    await d.store.settled();
    expect((await d.kept()).map((x) => x.body.text)).toEqual(["first\nshort\n"]);
    h.tick(JOURNAL_MS);
    expect(keys.map((k) => k.reads)).toEqual([1, 0, 0, 1]);
    await d.store.settled();
    expect((await d.kept()).map((x) => x.body.text.slice(-1))).toEqual(["3"]);
  });

  it("typing in a 90,000-character file sends main at most one copy each 250 ms, and the last edit before a close (perf M11)", async () => {
    const sent: number[] = [];
    const port: DraftsPort = { put: (d) => void sent.push(d.body.kind === "text" ? d.body.text.length : 0), drop: () => {}, release: () => {}, list: async () => [] };
    const big = "y".repeat(90_000);
    const h = standIn(big, { drafts: port });
    await h.session.load();
    h.setDown(true);
    // A second of typing at 20 keys a second: before, 20 whole copies (1.8 MB); now the first and one each 250 ms.
    for (let i = 1; i <= 20; i++) {
      h.session.edit(reader(`${big}${"k".repeat(i)}`));
      if (i % 5 === 0) h.tick(JOURNAL_MS);
    }
    expect(sent.length).toBe(1 + 1000 / JOURNAL_MS);
    expect(sent.reduce((a, b) => a + b, 0)).toBeLessThan(5 * 90_021);
    // Two keys more, then the tab closes: the last edit is journaled before it goes.
    h.session.edit(reader(`${big}${"k".repeat(21)}`));
    h.session.edit(reader(`${big}${"k".repeat(22)}`));
    h.session.dispose();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.at(-1)).toBe(90_022);
  });
});
