import type { FileBytes, FileSaved } from "@shared/contract-work-files";
import type { CanvasSource } from "@shared/work";
import { draftFileOf, type Draft, type DraftKey } from "@shared/work/drafts";
import { FILE_TEXT_MAX, kindOfEntry, refKey, type FileEntry } from "@shared/work/files";
import type { SavedLine } from "../canvas/kind";
import { savingNow } from "../canvas/calm";
import { bytesOfBase64, decodeText, encodeText, linkDropped, notSavedWords, triedAsText, whenWords, type TextFile } from "./fileText";

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

// The wire carries the host's sentence. A failed or refused read does not establish removal.
function readGone(err: unknown): boolean {
  return textOf(err) === "That file or folder is not there any more.";
}
/**
 * The journal's pace, for a text of any size (perf M11): each write copies the whole text and sends it to main, so an
 * edit is journaled at once after a quiet spell, then at most every `JOURNAL_MS` while he types, its last edit kept;
 * a save or a close writes the owed edit first. The journal is never a save: the line reads the host's write alone.
 */
export const JOURNAL_MS = 250;

/** The editor's text, unread: its length is known without copying it. */
export interface TextReader {
  length: number;
  read(): string;
}

export type FileView =
  | { is: "loading" }
  /** `rev` grows each time the text is replaced from the host, so the editor takes it; `locked`: why it cannot be changed here */
  | { is: "text"; text: string; rev: number; locked: string | null; offer?: true }
  /** its facts: what it is, how big, when it changed; `why` says in a sentence why it is not shown as text, when it might have been */
  | { is: "facts"; entry: FileEntry | null; why?: string; scoped?: true }
  | { is: "failed"; error: string };

export interface FileSessionHost {
  /** a request to the item's host */
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
  /** the kind's save line (`shell.saved`) */
  saved(line: SavedLine | null): void;
  /** said once, outside the line: his text was kept as a copy */
  say?(text: string): void;
  /** his clipboard: a draft no copy could keep goes there on Copy Text */
  copy?(text: string): Promise<void>;
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
  /**
   * The editor's text now, when it differs from what the host holds. An edit hands a reader, not the text: a key never
   * copies the whole file, and the text is read once when something needs it (the journal, a save), then kept until
   * the next edit.
   */
  private kept: string | null = null;
  private reader: TextReader | null = null;
  private get draft(): string | null {
    if (this.reader) {
      this.kept = this.reader.read();
      this.reader = null;
    }
    return this.kept;
  }
  private set draft(text: string | null) {
    this.reader = null;
    this.kept = text;
  }
  private journalTimer: unknown = null;
  private journalOwed = false;
  /** edits since the last save */
  private pending = 0;
  /** every edit he made, never reset: a read that saw it move kept his text */
  private edits = 0;
  /** why the last send failed, said until a send is answered (a key after it never turns the line back to Saved) */
  private failure: string | null = null;
  private timer: unknown = null;
  private saving: Promise<void> | null = null;
  /** when his last unsent edit was made, and when the send now out began (calm.ts): the save line's clock */
  private editedAt: number | null = null;
  private sentAt: number | null = null;
  /** the save line asked again once its words change by time alone */
  private lineTimer: unknown = null;
  private conflicted = false;
  private gone = false;
  private disposed = false;
  /** the draft this session last journaled */
  private journaled: DraftKey | null = null;
  /** drafts found on first open, offered one at a time, newest first */
  private offers: Draft[] = [];
  /** the offered draft whose Keep Both the holder could not make: Copy Text takes its place */
  private unkept: Draft | null = null;
  private looked = false;
  /** Reads of the whole file out now, and the changes noted while one was (a folder's word, a move): a read that
   *  saw one come is read again before its text and its save line go in, so Saved never names a file gone by. */
  private reading = 0;
  private noted = 0;

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
    return this.reader !== null || this.kept !== null;
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
      const edits = this.edits;
      const noted = this.noted;
      const source = this.of.source;
      this.reading += 1;
      let got: FileBytes;
      try {
        got = await this.host.request<FileBytes>("work.files.read", { ...this.ref(), itemId: this.of.itemId, offset: 0, length: FILE_TEXT_MAX });
      } finally {
        this.reading -= 1;
      }
      if (this.disposed) return;
      // He typed while it was read (a change made elsewhere, read again): his words stay, on the version they were
      // made on, and the line says the file changed, with Reload and Keep Both.
      if (this.edits !== edits && this.view.is === "text") {
        this.conflicted = true;
        this.gone = false;
        this.changed = got.changed;
        return this.line();
      }
      // The file changed or moved while it was read: what came may be the old file, so it is read again.
      if (this.noted !== noted || this.of.source !== source) return await this.load();
      if (!got.end) return await this.facts(`Over ${FILE_TEXT_MAX / 1024 / 1024} MB, too big to edit here.`);
      const text = decodeText(bytesOfBase64(got.data));
      if (!text) return await this.facts();
      this.file = text;
      this.version = got.version;
      this.tried = [];
      this.changed = got.changed;
      this.draft = null;
      this.pending = 0;
      this.failure = null;
      this.conflicted = false;
      this.gone = false;
      await this.lookForDrafts(text.text);
      if (this.disposed) return;
      // Checked again just before the text and its line go in: a change noted meanwhile reads again.
      if (this.noted !== noted || this.of.source !== source) return await this.load();
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
    const { source, workspaceId, itemId, name } = this.of;
    const got = await this.host.request<{ entries: (FileEntry | null)[] }>("work.files.stat", { workspaceId, refs: [source] }).catch(() => null);
    let entry = got?.entries[0] ?? null;
    let scoped = false;
    if (!entry && source.at === "file") {
      // Copies live outside the listed places. The item's own read can see the copy.
      try {
        const { size, changed } = await this.host.request<FileBytes>("work.files.read", { workspaceId, ref: source, itemId, offset: 0, length: 1 });
        entry = { key: refKey(source), ref: source, folder: null, name, kind: kindOfEntry(name).kind, size, changed };
        scoped = true;
      } catch (err) {
        if (!readGone(err)) {
          if (!this.disposed) this.set({ is: "failed", error: textOf(err) });
          return;
        }
      }
    }
    if (this.disposed) return;
    this.set({ is: "facts", entry, ...(why ? { why } : {}), ...(scoped ? { scoped: true } : {}) });
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
        actions: [
          same ? { id: "restore", label: "Restore", run: () => this.restore() } : this.unkept === offer && this.host.copy ? { id: "copy", label: "Copy Text", run: () => this.copyDraft() } : { id: "keep", label: "Keep Both", run: () => this.keepDraft() },
          { id: "discard", label: "Discard", run: () => this.discardDraft() },
        ],
      });
    }
    if (this.conflicted) {
      const actions = [...(this.gone ? [] : [{ id: "reload", label: "Reload", run: () => this.reload() }]), ...(this.dirty ? [{ id: "keep", label: "Keep Both", run: () => this.keepMine() }] : [])];
      return this.host.saved({ state: "conflict", detail: this.gone ? "This file was moved or deleted" : `This file changed at ${whenWords(this.changed, this.now())}`, actions });
    }
    // A copy says nothing of its own: the frame names the computer the file is on.
    if (this.view.locked !== null) return this.host.saved(this.view.locked.startsWith("This is a copy") ? null : { state: "readonly", detail: this.view.locked });
    // Saved names the last save the host answered; Saving… only once a send has been out a while, or his edits waited
    // past the pause with nothing sent (calm.ts). Inside that, the last Saved line stays.
    const { saving, again } = savingNow({ edited: this.dirty && !this.saving ? this.editedAt : null, pause: SAVE_AFTER_MS, sent: this.saving ? this.sentAt : null }, this.now());
    this.later(again);
    // A link that dropped: the edits wait here. A refusal (the host's own no) is not saved, with its reason: never Offline.
    // Said until a send is answered, a new send out a while being Saving…; nothing waiting, nothing is said of it.
    const failure = failed ?? (this.dirty ? this.failure : null);
    if (failure !== null && !(this.saving && saving)) {
      const retry = [{ id: "retry", label: "Retry", run: () => this.flush() }];
      return this.host.saved(linkDropped(failure) ? { state: "offline", pending: this.pending, detail: failure, actions: retry } : { state: "conflict", detail: notSavedWords(failure), actions: retry });
    }
    if (saving) return this.host.saved({ state: "saving" });
    this.host.saved({ state: "saved", at: this.changed });
  }

  /** Asks the line again in `ms`, once: none waits when null. */
  private later(ms: number | null): void {
    this.host.clearTimeout ? this.host.clearTimeout(this.lineTimer) : clearTimeout(this.lineTimer as ReturnType<typeof setTimeout>);
    this.lineTimer = null;
    if (ms === null) return;
    const again = (): void => this.line();
    this.lineTimer = this.host.setTimeout ? this.host.setTimeout(again, ms + 1) : setTimeout(again, ms + 1);
  }

  /** The editor's text changed by his hand: the text, or a reader of it (the editor's, so a key copies nothing). */
  edit(text: string | TextReader): void {
    if (this.view.is !== "text" || this.view.locked !== null || this.view.offer) return;
    if (typeof text === "string") this.draft = text;
    else this.reader = text;
    this.pending += 1;
    this.edits += 1;
    this.editedAt = this.now();
    this.journalSoon();
    if (this.conflicted) return this.line();
    this.line();
    this.host.clearTimeout ? this.host.clearTimeout(this.timer) : clearTimeout(this.timer as ReturnType<typeof setTimeout>);
    const later = (): void => void this.flush();
    this.timer = this.host.setTimeout ? this.host.setTimeout(later, SAVE_AFTER_MS) : setTimeout(later, SAVE_AFTER_MS);
  }

  /**
   * The newest text journaled now where it is the first edit in a while, else once `JOURNAL_MS` is up: a write the
   * span owed starts the next span, so a steady stream of keys writes once each `JOURNAL_MS`, never twice in one.
   */
  private journalSoon(): void {
    if (!this.host.drafts) return;
    if (this.journalTimer !== null) return void (this.journalOwed = true);
    this.journal();
    this.journalSpan();
  }
  private journalSpan(): void {
    const due = (): void => {
      this.journalTimer = null;
      if (!this.journalOwed) return;
      this.journalDue();
      this.journalSpan();
    };
    this.journalTimer = this.host.setTimeout ? this.host.setTimeout(due, JOURNAL_MS) : setTimeout(due, JOURNAL_MS);
  }
  /** An edit not yet journaled is journaled now. */
  private journalDue(): void {
    if (!this.journalOwed) return;
    this.journalOwed = false;
    this.journal();
  }

  /** Sends what waits, now. One save at a time: text typed while one is under way goes in the next. */
  flush(): Promise<void> {
    this.host.clearTimeout ? this.host.clearTimeout(this.timer) : clearTimeout(this.timer as ReturnType<typeof setTimeout>);
    this.timer = null;
    // A send may fail or not answer: what it sends is in the journal first.
    this.journalDue();
    if (this.saving) return this.saving.then(() => (this.dirty && !this.conflicted ? this.flush() : undefined));
    if (this.draft === null || this.conflicted || this.view.is !== "text") return Promise.resolve();
    const text = this.draft;
    const sent = this.pending;
    this.sentAt = this.now();
    this.saving = (async () => {
      const encoded = encodeText(text, this.file);
      // Kept until its answer: a send whose answer is lost is named by the next, and a resend of these bytes is this save.
      // Worked out beside the send, never before it: the send goes at once.
      const digest = sha256Hex(encoded).catch(() => null);
      try {
        const got = await this.host.request<FileSaved>("work.files.write", { ...this.ref(), text: encoded, version: this.version, ...(this.tried.length ? { tried: this.tried } : {}) });
        this.tried = [];
        this.failure = null;
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
        this.sentAt = null;
        this.line();
      } catch (err) {
        const lost = await digest;
        if (lost && !this.tried.includes(lost)) this.tried = [...this.tried, lost].slice(-8);
        this.failure = textOf(err);
        this.saving = null;
        this.sentAt = null;
        this.line();
      }
    })();
    // Under way: a line that said the words wait says they are going (a copy's send-back follows its saving to saved).
    this.line();
    return this.saving;
  }

  /** The link to the host opened again: what waited for it is sent, by the version it read, as a save always is. */
  reopened(): Promise<void> {
    return this.dirty && !this.conflicted && !this.disposed ? this.flush() : Promise.resolve();
  }

  /** The file as it is on the host now, in place of what is here. */
  async reload(): Promise<void> {
    this.draft = null;
    this.unjournal();
    await this.load();
  }

  /**
   * His text kept beside the file under a name of its own, then the file as it is now. Keys typed while it was out
   * are not in the copy: the editor and the journal keep them, and the line still offers Reload and Keep Both.
   */
  async keepMine(): Promise<void> {
    const text = this.draft;
    if (text === null || this.view.is !== "text") return;
    try {
      const got = await this.host.request<FileSaved>("work.files.write", { ...this.ref(), text: encodeText(text, this.file), version: this.version, copy: true });
      if ("copy" in got) this.host.say?.(`Kept as ${got.copy.name}`);
      if (this.draft !== text) return this.line();
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
    // A read of the whole file is out (the first, or a reload): the change is noted, and that read reads again.
    if (this.reading > 0 || this.view.is === "loading") return void (this.noted += 1);
    if (this.view.is !== "text" || this.saving || this.conflicted) return;
    const of = this.of;
    const version = this.version;
    let got: FileBytes | null;
    try {
      got = await this.host.request<FileBytes>("work.files.read", { ...this.ref(), itemId: of.itemId, offset: 0, length: 1 });
    } catch (err) {
      if (!readGone(err)) return;
      got = null;
    }
    if (this.disposed || this.saving || this.conflicted || this.view.is !== "text" || this.of !== of || this.version !== version) return;
    if (got?.version === version) return;
    if (got && !this.dirty) return void (await this.load());
    this.conflicted = true;
    this.gone = got === null;
    if (got) this.changed = got.changed;
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
    this.noted += 1;
    if (!this.conflicted || !this.gone) return;
    this.conflicted = false;
    this.gone = false;
    if (this.dirty) void this.flush();
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
      // Nowhere would keep it: his words are still his to copy, never stranded behind a press that fails again.
      this.unkept = d;
      if (this.offering === d) this.line();
    }
  }

  /** The offered draft's text to his clipboard; the draft stays offered until he lets it go. */
  async copyDraft(): Promise<void> {
    const d = this.offering;
    if (!d || d.body.kind !== "text" || !this.host.copy) return;
    try {
      await this.host.copy(d.body.text);
      this.host.say?.("Copied");
    } catch (err) {
      this.host.say?.(`Not copied: ${textOf(err)}`);
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
    this.later(null);
    if (this.journalTimer !== null) {
      this.host.clearTimeout ? this.host.clearTimeout(this.journalTimer) : clearTimeout(this.journalTimer as ReturnType<typeof setTimeout>);
      this.journalTimer = null;
    }
    void this.flush().finally(() => {
      this.journalDue();
      if (this.dirty && this.journaled) this.host.drafts?.release(this.journaled);
    });
  }
}

/** The sha256 of a text as the host writes it (UTF-8), in hex. */
async function sha256Hex(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
