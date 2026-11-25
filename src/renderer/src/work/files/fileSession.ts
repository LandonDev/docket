import type { FileBytes, FileSaved } from "@shared/contract-work-files";
import type { CanvasSource } from "@shared/work";
import { draftFileOf, type Draft, type DraftKey } from "@shared/work/drafts";
import { FILE_TEXT_MAX, type FileEntry } from "@shared/work/files";
import type { SavedLine } from "../canvas/kind";
import { bytesOfBase64, decodeText, encodeText, triedAsText, whenWords, type TextFile } from "./fileText";

/**
 * One file open in the `file` kind (docs/agents/work-files.md "The file kind"): read once, shown as text to edit
 * or as its facts, and saved as he types. There is no save press. A change waits `SAVE_AFTER_MS` for the next
 * one, then goes to the host with the version this window read; the host writes it only over that version, so a
 * second writer is never written over: the line says the file changed, with Reload and Keep Both. A
 * save that cannot reach the host waits here and says how many changes wait, and goes again on Retry or when the
 * link to the host opens again. Closing the tab sends what waits.
 *
 * Each edit the host has not acknowledged is journaled as he types, on this computer (`drafts`, src/main/drafts.ts),
 * by the version it was made on, and dropped once the host has it. A file opened with a draft no live editor holds
 * offers it back first (docs/agents/work-files.md "Drafts survive a crash"): Restore sends it by its version, as any
 * save; a draft whose version the file no longer is offers Keep Both alone, so it never goes over a newer file.
 */

export const SAVE_AFTER_MS = 700;

export type FileView =
  | { is: "loading" }
  /** `rev` grows each time the text is replaced from the host, so the editor takes it; `locked`: why it cannot be changed here */
  | { is: "text"; text: string; rev: number; locked: string | null; offer?: true }
  /** its facts: what it is, how big, when it changed; `why` says in a sentence why it is not shown as text, when it might have been */
  | { is: "facts"; entry: FileEntry | null; why?: string }
  | { is: "failed"; error: string };

export interface FileSessionHost {
  /** a request to the item's host */
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
  /** the kind's save line (`shell.saved`) */
  saved(line: SavedLine | null): void;
  /** said once, outside the line: his text was kept as a copy */
  say?(text: string): void;
  now?(): number;
  /** this computer's draft store (native.ts `draftStore`); absent where there is none (a browser) */
  drafts?: DraftsPort;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(id: unknown): void;
}

/** The draft store as a window reaches it (src/preload/index.ts `drafts`). */
export interface DraftsPort {
  put(draft: Draft): void;
  drop(key: DraftKey): void;
  release(key: DraftKey): void;
  list(key: Omit<DraftKey, "base">): Promise<Draft[]>;
}

export interface FileSessionOf {
  workspaceId: string;
  /** the host the item's file is asked of (its link's environment) */
  holder?: string;
  itemId: string;
  source: CanvasSource;
  name: string;
}

const textOf = (err: unknown): string => (err instanceof Error && err.message ? err.message : String(err));
const sameKey = (a: DraftKey, b: DraftKey): boolean => a.workspaceId === b.workspaceId && a.holder === b.holder && a.file === b.file && a.base === b.base;

export class FileSession {
  private view: FileView = { is: "loading" };
  private listeners = new Set<() => void>();
  private file: Pick<TextFile, "bom" | "crlf"> = { bom: false, crlf: false };
  /** the version the host last answered: what a save names */
  private version = "";
  /** the sha256 of saves sent on that version whose answer never came (the link dropped): the next save names them, so the host knows his own words there */
  private tried: string[] = [];
  private changed = 0;
  /** the editor's text now, when it differs from what the host holds */
  private draft: string | null = null;
  /** edits since the last save */
  private pending = 0;
  private timer: unknown = null;
  private saving: Promise<void> | null = null;
  private conflicted = false;
  private gone = false;
  private disposed = false;
  /** the draft this session last journaled */
  private journaled: DraftKey | null = null;
  /** drafts found on first open, offered one at a time, newest first */
  private offers: Draft[] = [];
  private looked = false;

  constructor(
    private readonly host: FileSessionHost,
    private of: FileSessionOf,
  ) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getSnapshot = (): FileView => this.view;
  /** There is text here the host does not hold yet. */
  get dirty(): boolean {
    return this.draft !== null;
  }

  private set(view: FileView): void {
    this.view = view;
    for (const fn of this.listeners) fn();
  }
  private now(): number {
    return this.host.now?.() ?? Date.now();
  }
  private ref(): Record<string, unknown> {
    return { workspaceId: this.of.workspaceId, ref: this.of.source };
  }

  private place(): Omit<DraftKey, "base"> {
    return { workspaceId: this.of.workspaceId, holder: this.of.holder ?? "local", file: draftFileOf(this.of.source) };
  }
  private keyOf(d: Pick<DraftKey, "base">): DraftKey {
    return { ...this.place(), base: d.base };
  }

  /** What waits here, kept on this computer by the version it was made on: the newest text, in place of the last. */
  private journal(): void {
    const drafts = this.host.drafts;
    if (!drafts || this.draft === null || !this.version) return;
    const key = this.keyOf({ base: this.version });
    if (this.journaled && !sameKey(this.journaled, key)) drafts.drop(this.journaled);
    drafts.put({ ...key, name: this.of.name, at: this.now(), body: { kind: "text", text: this.draft, bom: this.file.bom, crlf: this.file.crlf } });
    this.journaled = key;
  }
  /** The host has it, or he let it go: nothing is kept. */
  private unjournal(): void {
    if (this.journaled) this.host.drafts?.drop(this.journaled);
    this.journaled = null;
  }

  /** Drafts of this file no live editor holds: one the file already holds goes, the rest are offered. */
  private async lookForDrafts(text: string): Promise<void> {
    const drafts = this.host.drafts;
    if (this.looked || !drafts) return;
    this.looked = true;
    const found = await drafts.list(this.place()).catch(() => [] as Draft[]);
    this.offers = found.filter((d) => {
      if (d.body.kind !== "text" || d.body.text !== text) return true;
      drafts.drop(d);
      return false;
    });
  }
  private get offering(): Draft | null {
    return this.view.is === "text" && this.view.locked === null ? (this.offers[0] ?? null) : null;
  }
  /** The offer in front was answered: the next, else the editor is his again. */
  private nextOffer(): void {
    this.offers.shift();
    if (this.view.is === "text" && !this.offers.length && this.view.offer) {
      const { offer: _, ...view } = this.view;
      this.set(view);
    }
    this.line();
  }

  /** Reads the file: as text where it is text this editor keeps whole, else its facts. */
  async load(): Promise<void> {
    try {
      // A Drive file that is no Google file has no bytes here to read: it is its facts, with Open in Drive.
      if (this.of.source.at === "google" || !triedAsText(this.of.name, undefined)) return await this.facts();
      const got = await this.host.request<FileBytes>("work.files.read", { ...this.ref(), itemId: this.of.itemId, offset: 0, length: FILE_TEXT_MAX });
      if (this.disposed) return;
      if (!got.end) return await this.facts(`Over ${FILE_TEXT_MAX / 1024 / 1024} MB, too big to edit here.`);
      const text = decodeText(bytesOfBase64(got.data));
      if (!text) return await this.facts();
      this.file = text;
      this.version = got.version;
      this.tried = [];
      this.changed = got.changed;
      this.draft = null;
      this.pending = 0;
      this.conflicted = false;
      this.gone = false;
      await this.lookForDrafts(text.text);
      if (this.disposed) return;
      const rev = this.view.is === "text" ? this.view.rev + 1 : 0;
      const offer = this.offers.length > 0 && !got.locked;
      this.set({ is: "text", text: text.text, rev, locked: got.locked ?? null, ...(offer ? { offer: true as const } : {}) });
      this.line();
    } catch (err) {
      if (this.disposed) return;
      this.set({ is: "failed", error: textOf(err) });
      this.host.saved(null);
    }
  }

  private async facts(why?: string): Promise<void> {
    const got = await this.host.request<{ entries: (FileEntry | null)[] }>("work.files.stat", { workspaceId: this.of.workspaceId, refs: [this.of.source] }).catch(() => ({ entries: [null] }));
    if (this.disposed) return;
    this.set({ is: "facts", entry: got.entries[0] ?? null, ...(why ? { why } : {}) });
    // A file that is not edited here says nothing of saving: the frame draws its own line.
    this.host.saved(null);
  }

  /** The save line for where things stand. */
  private line(failed?: string): void {
    if (this.view.is !== "text" || this.disposed) return;
    const offer = this.offering;
    if (offer) {
      // The same version: his words go back in by it. A newer file: kept beside it, never over it.
      const same = offer.base === this.version;
      const when = whenWords(offer.at, this.now());
      return this.host.saved({
        state: "conflict",
        detail: same ? `Edits from ${when} were not saved` : `Edits from ${when} were not saved. The file changed since`,
        actions: [same ? { id: "restore", label: "Restore", run: () => this.restore() } : { id: "keep", label: "Keep Both", run: () => this.keepDraft() }, { id: "discard", label: "Discard", run: () => this.discardDraft() }],
      });
    }
    if (this.conflicted) {
      const actions = [...(this.gone ? [] : [{ id: "reload", label: "Reload", run: () => this.reload() }]), ...(this.draft !== null ? [{ id: "keep", label: "Keep Both", run: () => this.keepMine() }] : [])];
      return this.host.saved({ state: "conflict", detail: this.gone ? "This file was moved or deleted" : `This file changed at ${whenWords(this.changed, this.now())}`, actions });
    }
    // A copy says nothing of its own: the frame names the computer the file is on.
    if (this.view.locked !== null) return this.host.saved(this.view.locked.startsWith("This is a copy") ? null : { state: "readonly", detail: this.view.locked });
    if (failed !== undefined) return this.host.saved({ state: "offline", pending: this.pending, detail: failed, actions: [{ id: "retry", label: "Retry", run: () => this.flush() }] });
    if (this.draft !== null || this.saving) return this.host.saved({ state: "saving" });
    this.host.saved({ state: "saved", at: this.changed });
  }

  /** The editor's text changed by his hand. */
  edit(text: string): void {
    if (this.view.is !== "text" || this.view.locked !== null || this.view.offer) return;
    this.draft = text;
    this.pending += 1;
    this.journal();
    if (this.conflicted) return this.line();
    this.line();
    this.host.clearTimeout ? this.host.clearTimeout(this.timer) : clearTimeout(this.timer as ReturnType<typeof setTimeout>);
    const later = (): void => void this.flush();
    this.timer = this.host.setTimeout ? this.host.setTimeout(later, SAVE_AFTER_MS) : setTimeout(later, SAVE_AFTER_MS);
  }

  /** Sends what waits, now. One save at a time: text typed while one is under way goes in the next. */
  flush(): Promise<void> {
    this.host.clearTimeout ? this.host.clearTimeout(this.timer) : clearTimeout(this.timer as ReturnType<typeof setTimeout>);
    this.timer = null;
    if (this.saving) return this.saving.then(() => (this.draft !== null && !this.conflicted ? this.flush() : undefined));
    if (this.draft === null || this.conflicted || this.view.is !== "text") return Promise.resolve();
    const text = this.draft;
    const sent = this.pending;
    this.saving = (async () => {
      const encoded = encodeText(text, this.file);
      // Kept until its answer: a send whose answer is lost is named by the next, and a resend of these bytes is this save.
      // Worked out beside the send, never before it: the send goes at once.
      const digest = sha256Hex(encoded).catch(() => null);
      try {
        const got = await this.host.request<FileSaved>("work.files.write", { ...this.ref(), text: encoded, version: this.version, ...(this.tried.length ? { tried: this.tried } : {}) });
        this.tried = [];
        if ("conflict" in got) {
          this.conflicted = true;
          this.gone = "gone" in got.conflict;
          if (!("gone" in got.conflict)) this.changed = got.conflict.changed;
        } else if ("version" in got) {
          this.version = got.version;
          this.changed = got.changed;
          // Text typed since it was sent still waits, now on the version the host answered.
          if (this.draft === text) this.draft = null;
          if (this.draft === null) this.unjournal();
          else this.journal();
          this.pending = Math.max(0, this.pending - sent);
        }
        this.saving = null;
        this.line();
      } catch (err) {
        const lost = await digest;
        if (lost && !this.tried.includes(lost)) this.tried = [...this.tried, lost].slice(-8);
        this.saving = null;
        this.line(textOf(err));
      }
    })();
    // Under way: a line that said the words wait says they are going (a copy's send-back follows its saving to saved).
    this.line();
    return this.saving;
  }

  /** The link to the host opened again: what waited for it is sent, by the version it read, as a save always is. */
  reopened(): Promise<void> {
    return this.draft !== null && !this.conflicted && !this.disposed ? this.flush() : Promise.resolve();
  }

  /** The file as it is on the host now, in place of what is here. */
  async reload(): Promise<void> {
    this.draft = null;
    this.unjournal();
    await this.load();
  }

  /** His text kept beside the file under a name of its own, then the file as it is now. */
  async keepMine(): Promise<void> {
    if (this.draft === null || this.view.is !== "text") return;
    try {
      const got = await this.host.request<FileSaved>("work.files.write", { ...this.ref(), text: encodeText(this.draft, this.file), version: this.version, copy: true });
      if ("copy" in got) this.host.say?.(`Kept as ${got.copy.name}`);
      this.draft = null;
      this.unjournal();
      if (this.gone) return this.line();
      await this.load();
    } catch (err) {
      this.line(textOf(err));
    }
  }

  /**
   * The folder said something changed, or the window came forward: the file is looked at again. One that changed
   * with nothing waiting here is read again; with text waiting, the line says so and nothing is replaced.
   */
  async check(): Promise<void> {
    if (this.view.is !== "text" || this.saving || this.conflicted) return;
    const got = await this.host.request<{ entries: (FileEntry | null)[] }>("work.files.stat", { workspaceId: this.of.workspaceId, refs: [this.of.source] }).catch(() => null);
    if (!got || this.disposed || this.saving || this.view.is !== "text") return;
    const entry = got.entries[0] ?? null;
    if (entry && entry.changed === this.changed) return;
    if (entry && this.draft === null) return void (await this.load());
    this.conflicted = true;
    this.gone = entry === null;
    if (entry?.changed) this.changed = entry.changed;
    this.line();
  }

  /**
   * The file was renamed or moved, and its item now names where it lies (files/moved.ts): saves go there, by the
   * version read, which a rename keeps. A save the old path answered as gone, or a look that found it gone, is
   * undone: what waits is sent to the new path.
   */
  follow(source: CanvasSource): void {
    if (JSON.stringify(source) === JSON.stringify(this.of.source)) return;
    this.of = { ...this.of, source };
    if (!this.conflicted || !this.gone) return;
    this.conflicted = false;
    this.gone = false;
    if (this.draft !== null) void this.flush();
    else this.line();
  }

  /** Drawn again after another tab was shown: the editor takes the words that wait here, and the line is said again. */
  shown(): void {
    if (this.view.is === "text" && this.draft !== null && this.view.text !== this.draft) this.set({ ...this.view, text: this.draft, rev: this.view.rev + 1 });
    this.line();
  }

  /** The offered draft, made on the version the file still is: in the editor again, and sent by that version. */
  restore(): Promise<void> {
    const d = this.offering;
    if (!d || d.body.kind !== "text" || this.view.is !== "text" || d.base !== this.version) return Promise.resolve();
    this.offers = [];
    this.set({ is: "text", text: d.body.text, rev: this.view.rev + 1, locked: null });
    this.draft = d.body.text;
    this.pending = 1;
    this.journal();
    return this.flush();
  }

  /** The offered draft kept beside the file under a name of its own: the file, newer than it, is left as it is. */
  async keepDraft(): Promise<void> {
    const d = this.offering;
    if (!d || d.body.kind !== "text") return;
    try {
      const got = await this.host.request<FileSaved>("work.files.write", { ...this.ref(), text: encodeText(d.body.text, d.body), version: d.base, copy: true });
      if ("copy" in got) this.host.say?.(`Kept as ${got.copy.name}`);
      this.host.drafts?.drop(d);
      if (this.offering === d) this.nextOffer();
    } catch (err) {
      this.host.say?.(`Not kept: ${textOf(err)}`);
    }
  }

  /** He let the offered draft go. */
  discardDraft(): void {
    const d = this.offering;
    if (!d) return;
    this.host.drafts?.drop(d);
    this.nextOffer();
  }

  /** The tab closed, here or from another window: what waits is sent, and nothing more is said. What the host does not take is kept on this computer, offered when the file opens again. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    void this.flush().finally(() => {
      if (this.draft !== null && this.journaled) this.host.drafts?.release(this.journaled);
    });
  }
}

/** The sha256 of a text as the host writes it (UTF-8), in hex. */
async function sha256Hex(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
