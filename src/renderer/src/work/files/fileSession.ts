import type { FileBytes, FileSaved } from "@shared/contract-work-files";
import type { CanvasSource } from "@shared/work";
import { FILE_TEXT_MAX, type FileEntry } from "@shared/work/files";
import type { SavedLine } from "../canvas/kind";
import { bytesOfBase64, decodeText, encodeText, triedAsText, whenWords, type TextFile } from "./fileText";

/**
 * One file open in the `file` kind (docs/agents/work-files.md "The file kind"): read once, shown as text to edit
 * or as its facts, and saved as he types. There is no save press. A change waits `SAVE_AFTER_MS` for the next
 * one, then goes to the host with the version this window read; the host writes it only over that version, so a
 * second writer is never written over: the line says the file changed, with Reload and Keep mine as a copy. A
 * save that cannot reach the host waits here and says how many changes wait. Closing the tab sends what waits.
 */

export const SAVE_AFTER_MS = 700;

export type FileView =
  | { is: "loading" }
  /** `rev` grows each time the text is replaced from the host, so the editor takes it; `locked`: why it cannot be changed here */
  | { is: "text"; text: string; rev: number; locked: string | null }
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
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(id: unknown): void;
}

export interface FileSessionOf {
  workspaceId: string;
  itemId: string;
  source: CanvasSource;
  name: string;
}

const textOf = (err: unknown): string => (err instanceof Error && err.message ? err.message : String(err));

export class FileSession {
  private view: FileView = { is: "loading" };
  private listeners = new Set<() => void>();
  private file: Pick<TextFile, "bom" | "crlf"> = { bom: false, crlf: false };
  /** the version the host last answered: what a save names */
  private version = "";
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

  constructor(
    private readonly host: FileSessionHost,
    private readonly of: FileSessionOf,
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
      this.changed = got.changed;
      this.draft = null;
      this.pending = 0;
      this.conflicted = false;
      this.gone = false;
      const rev = this.view.is === "text" ? this.view.rev + 1 : 0;
      this.set({ is: "text", text: text.text, rev, locked: got.locked ?? null });
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
    if (this.conflicted) {
      const actions = [...(this.gone ? [] : [{ id: "reload", label: "Reload", run: () => this.reload() }]), ...(this.draft !== null ? [{ id: "keep", label: "Keep mine as a copy", run: () => this.keepMine() }] : [])];
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
    if (this.view.is !== "text" || this.view.locked !== null) return;
    this.draft = text;
    this.pending += 1;
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
      try {
        const got = await this.host.request<FileSaved>("work.files.write", { ...this.ref(), text: encodeText(text, this.file), version: this.version });
        if ("conflict" in got) {
          this.conflicted = true;
          this.gone = "gone" in got.conflict;
          if (!("gone" in got.conflict)) this.changed = got.conflict.changed;
        } else if ("version" in got) {
          this.version = got.version;
          this.changed = got.changed;
          // Text typed since it was sent still waits.
          if (this.draft === text) this.draft = null;
          this.pending = Math.max(0, this.pending - sent);
        }
        this.saving = null;
        this.line();
      } catch (err) {
        this.saving = null;
        this.line(textOf(err));
      }
    })();
    return this.saving;
  }

  /** The file as it is on the host now, in place of what is here. */
  async reload(): Promise<void> {
    this.draft = null;
    await this.load();
  }

  /** His text kept beside the file under a name of its own, then the file as it is now. */
  async keepMine(): Promise<void> {
    if (this.draft === null || this.view.is !== "text") return;
    try {
      const got = await this.host.request<FileSaved>("work.files.write", { ...this.ref(), text: encodeText(this.draft, this.file), version: this.version, copy: true });
      if ("copy" in got) this.host.say?.(`Kept as ${got.copy.name}`);
      this.draft = null;
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

  /** The tab closed, here or from another window: what waits is sent, and nothing more is said. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    void this.flush();
  }
}
