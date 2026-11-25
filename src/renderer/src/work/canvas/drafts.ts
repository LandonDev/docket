import { filesPaneWorkspace, type CanvasItem, type CanvasSource } from "@shared/work";
import { draftFileOf, type Draft, type DraftBody, type DraftKey, type DraftKind } from "@shared/work/drafts";
import { draftStore } from "../../lib/native";

/**
 * One item's drafts, for an editor that keeps its unacknowledged edits on this computer (docs/agents/work-files.md
 * "Drafts survive a crash"; the store is src/main/drafts.ts): the newest body under the version it was made on, an
 * older version's dropped as the base moves, all of it dropped once the host has it. A browser has no store: null.
 */
export interface DraftsPort {
  put(draft: Draft): void;
  drop(key: DraftKey): void;
  release(key: DraftKey): void;
  list(key: Omit<DraftKey, "base">): Promise<Draft[]>;
}

const sameKey = (a: DraftKey, b: DraftKey): boolean => a.workspaceId === b.workspaceId && a.holder === b.holder && a.file === b.file && a.base === b.base;

export class DraftJournal {
  private kept: DraftKey | null = null;

  constructor(
    private readonly port: DraftsPort,
    private readonly place: Omit<DraftKey, "base"> & { name: string },
    private readonly now: () => number = Date.now,
  ) {}

  /** The body that waits now, made on `base`; null when nothing waits. */
  keep(base: string, body: DraftBody | null): void {
    if (!body) return this.clear();
    const { name, ...where } = this.place;
    const key = { ...where, base };
    if (this.kept && !sameKey(this.kept, key)) this.port.drop(this.kept);
    this.port.put({ ...key, name, at: this.now(), body });
    this.kept = key;
  }

  /** The host has it all, or he let it go. */
  clear(): void {
    if (this.kept) this.port.drop(this.kept);
    this.kept = null;
  }

  /**
   * Edits the host refused for good (a conflict over a file that moved on): kept apart under `base`, the version they
   * were made on, and let go at once, so the next open offers them and what waits after never drops them.
   */
  setAside(base: string, body: DraftBody): void {
    const { name, ...where } = this.place;
    const key = { ...where, base };
    if (this.kept && sameKey(this.kept, key)) this.kept = null;
    this.port.put({ ...key, name, at: this.now(), body });
    this.port.release(key);
  }
  /** The editor goes with something unsent: it is offered on the next open. */
  release(): void {
    if (this.kept) this.port.release(this.kept);
  }

  /** Whether a draft is kept for what waits now. */
  get holding(): boolean {
    return this.kept !== null;
  }

  /** Drafts of this file of one kind no live editor holds, newest first. */
  async offered(kind: DraftKind): Promise<Draft[]> {
    const { name: _, ...where } = this.place;
    return (await this.port.list(where).catch(() => [] as Draft[])).filter((d) => d.body.kind === kind);
  }

  /** One offered draft answered: it goes. */
  drop(d: DraftKey): void {
    this.port.drop(d);
  }
}

/** The journal of an item's file on its host, where this window has a store. */
export function draftJournal(env: string, workspaceId: string | null | undefined, source: CanvasSource, name: string, port: DraftsPort | undefined = draftStore()): DraftJournal | null {
  if (!port || !workspaceId) return null;
  return new DraftJournal(port, { workspaceId, holder: env, file: draftFileOf(source), name });
}

/** The journal of an item's file: its workspace is the item's own, else its Files pane's. */
export function itemJournal(env: string, item: Pick<CanvasItem, "sessionId" | "source" | "title"> & { workspaceId?: string | null }): DraftJournal | null {
  return draftJournal(env, item.workspaceId ?? filesPaneWorkspace(item.sessionId), item.source, item.title);
}
