import { createStore } from "zustand/vanilla";
import { WORK_CHATS } from "./tcserver/workspaces";
import type { ThreadRules } from "@server/shared/rules";
import type { ComposerSegment } from "./composerText";
import { HARNESS_LABEL, newThreadAccess, withNewThreadModel, type Attachment, type HarnessId, type RuntimeMode, type Session } from "./session";
import { stripScopeKey } from "./threadHeaderModel";
import type { ProjectMeta, ThreadType } from "./tcserver/types";

/**
 * One unsent draft per project (CLAUDE.md "Stability 2"): what its composer
 * held and what its pickers chose, kept across project switches and
 * relaunches under the strip order's key (`stripScopeKey`: a linked
 * project's copies share their link id, a loose chat its workspace's
 * `loose:` key). The record keeps the draft's session id, so the composer's
 * mount finds it and the first send keeps one id from draft to thread;
 * sending clears it.
 *
 * Pasted bytes (an attachment with no `path`) never reach localStorage: they
 * live in memory by draft id and rejoin the record within the run.
 *
 * A Work dock's draft (work/dock/dockThread.ts) keeps a record of its own,
 * under `dockDraftKey(subject)`: what he typed in a file's Ask comes back
 * after a quit and a launch, and never in the workspace's New thread draft
 * (nor that one's in the dock). Docks are capped apart from projects, so
 * many files opened never push a project's draft out, and a dock record
 * with nothing typed is never written to disk.
 */
export type DraftPlace = {
  environmentId: string;
  projectId: string | null;
  workspaceId: string | null;
  cwd: string;
};

export type DraftRecord = DraftPlace & {
  id: string;
  harness: HarnessId;
  model: string;
  modelSettings: Record<string, string>;
  runtimeMode: RuntimeMode;
  /** He picked the access himself (Session.accessPicked); without it the rebuilt draft takes his defaults as they are now. */
  accessPicked?: true;
  /** He picked the provider, model or effort himself (Session.modelPicked); without it the rebuilt draft takes his defaults as they are now. */
  modelPicked?: true;
  threadType: ThreadType;
  threadRules: ThreadRules | null;
  /** A chat draft's "Master thread" pick (Session.draftMaster). */
  master?: boolean;
  /** The name typed in the draft row (Session.draftTitle); the first send makes it the thread's title. */
  title?: string;
  /** "work": a Work Chat's draft (Session.scope), whose first send asks for Work. */
  scope?: "work";
  segments: ComposerSegment[];
  attachments: Attachment[];
  seenAt: number;
};

export type DraftRecords = Readonly<Record<string, DraftRecord>>;

const STORAGE_KEY = "docket.projectDrafts";
const DOCK_PREFIX = "dock:";

/** The key a dock subject's draft lives under (`DockSubject.key`). */
export const dockDraftKey = (subject: string): string => DOCK_PREFIX + subject;
/** Whether `key` is a dock's draft, not a project's or a workspace's. */
export const isDockDraftKey = (key: string): boolean => key.startsWith(DOCK_PREFIX);
const holdsNothing = (record: Pick<DraftRecord, "segments" | "attachments">): boolean =>
  record.attachments.length === 0 && record.segments.every((s) => "text" in s && !s.text.trim());
/** Projects kept; the least recently seen go first. */
export const PROJECT_DRAFTS_CAP = 64;
/** A draft not seen for this long drops on load, as the strip order does. */
export const PROJECT_DRAFTS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const WRITE_DELAY_MS = 500;

type Catalog = { projects: readonly Pick<ProjectMeta, "id" | "environmentId" | "linkId">[] };

/** The key a draft for `session` lives under: its project's strip key, else
 *  its workspace's loose key. */
export function draftKeyOf(
  session: Pick<Session, "projectId" | "environmentId" | "workspaceId"> & { scope?: string },
  catalog: Catalog,
): string {
  const project = session.projectId
    ? (catalog.projects.find((p) => p.id === session.projectId && p.environmentId === session.environmentId) ??
      catalog.projects.find((p) => p.id === session.projectId))
    : undefined;
  // A Work Chat's draft is not the code chats' draft.
  return stripScopeKey(project, session.workspaceId ?? (session.scope === "work" ? WORK_CHATS : null));
}

/** What localStorage may hold of an attachment: never bytes or a preview URL. */
function storable(file: Attachment): Attachment {
  const { data: _data, blob: _blob, previewUrl: _url, ...rest } = file;
  return rest;
}

const pasted = (file: Attachment) => !file.path;

/** The saved drafts, with stale ones dropped; a corrupt value reads as empty. */
export function loadProjectDrafts(now = Date.now()): DraftRecords {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, DraftRecord> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const record = value as Partial<DraftRecord> | null;
      if (!record || typeof record.id !== "string" || typeof record.seenAt !== "number") continue;
      if (now - record.seenAt > PROJECT_DRAFTS_TTL_MS) continue;
      out[key] = {
        ...(record as DraftRecord),
        segments: Array.isArray(record.segments) ? record.segments : [],
        attachments: Array.isArray(record.attachments) ? record.attachments : [],
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** The cap's count, for projects and for docks apart. */
function capped(records: DraftRecords): DraftRecords {
  const keys = Object.keys(records);
  const docks = keys.filter(isDockDraftKey);
  if (docks.length <= PROJECT_DRAFTS_CAP && keys.length - docks.length <= PROJECT_DRAFTS_CAP) return records;
  const newest = (some: string[]) => some.sort((a, b) => records[b]!.seenAt - records[a]!.seenAt).slice(0, PROJECT_DRAFTS_CAP);
  const keep = [...newest(keys.filter((key) => !isDockDraftKey(key))), ...newest(docks)];
  return Object.fromEntries(keep.map((key) => [key, records[key]!]));
}

function write(records: DraftRecords): void {
  const out: Record<string, DraftRecord> = {};
  for (const [key, record] of Object.entries(records)) {
    const attachments = record.attachments.filter((f) => !pasted(f)).map(storable);
    if (isDockDraftKey(key) && holdsNothing({ segments: record.segments, attachments })) continue;
    out[key] = { ...record, attachments };
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch {
    // private mode / quota
  }
}

export const projectDraftsStore = createStore<{ records: DraftRecords }>()(() => ({
  records: loadProjectDrafts(),
}));

/** Pasted attachments by draft id: this run only. */
const pastedById = new Map<string, Attachment[]>();
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleWrite(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    write(projectDraftsStore.getState().records);
  }, WRITE_DELAY_MS);
}

export type DraftPatch = Partial<Omit<DraftRecord, "seenAt">>;

export const projectDrafts = {
  /** The record, with this run's pasted attachments joined back in. */
  get(key: string): DraftRecord | undefined {
    const record = projectDraftsStore.getState().records[key];
    if (!record) return undefined;
    const kept = pastedById.get(record.id);
    return kept?.length ? { ...record, attachments: [...record.attachments, ...kept] } : record;
  },
  /** Merge `patch` into the key's record; a key with none needs the whole
   *  record (an `id` and its place) to start one. */
  put(key: string, patch: DraftPatch, now = Date.now()): void {
    const { records } = projectDraftsStore.getState();
    const prev = records[key];
    if (!prev && !patch.id) return;
    const { attachments, ...rest } = patch;
    const id = patch.id ?? prev!.id;
    let stored = prev?.attachments ?? [];
    if (attachments) {
      stored = attachments.filter((f) => !pasted(f)).map(storable);
      const inMemory = attachments.filter(pasted);
      if (inMemory.length) pastedById.set(id, inMemory);
      else pastedById.delete(id);
    }
    const next = { ...prev, ...rest, id, attachments: stored, seenAt: now } as DraftRecord;
    if (!next.segments) next.segments = [];
    projectDraftsStore.setState({ records: capped({ ...records, [key]: next }) });
    scheduleWrite();
  },
  clear(key: string): void {
    const { records } = projectDraftsStore.getState();
    const prev = records[key];
    if (!prev) return;
    pastedById.delete(prev.id);
    const { [key]: _gone, ...rest } = records;
    projectDraftsStore.setState({ records: rest });
    scheduleWrite();
  },
  /** The record under `from` goes to `to` whole: its id, picks, text and attachments (pasted bytes are kept by id,
   *  so they follow). A record `to` held is replaced; `movedDraftKey` never picks a key whose draft holds his words. */
  move(from: string, to: string, now = Date.now()): void {
    if (from === to) return;
    const { records } = projectDraftsStore.getState();
    const prev = records[from];
    if (!prev) return;
    const { [from]: _gone, ...rest } = records;
    const replaced = rest[to];
    if (replaced && replaced.id !== prev.id) pastedById.delete(replaced.id);
    projectDraftsStore.setState({ records: capped({ ...rest, [to]: { ...prev, seenAt: now } }) });
    scheduleWrite();
  },
  /** The key whose draft is session `id`, else null: only a remembered
   *  draft writes here, so a sent thread never makes a record again. */
  keyOfDraft(id: string): string | null {
    for (const [key, record] of Object.entries(projectDraftsStore.getState().records)) {
      if (record.id === id) return key;
    }
    return null;
  },
  /** Write now (pagehide, quit). */
  flush(): void {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = null;
    write(projectDraftsStore.getState().records);
  },
  /** Tests: read localStorage again, dropping this run's pasted bytes. */
  reload(now = Date.now()): void {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = null;
    pastedById.clear();
    projectDraftsStore.setState({ records: loadProjectDrafts(now) });
  },
};

if (typeof window !== "undefined") window.addEventListener("pagehide", () => projectDrafts.flush());

/** The picks of a draft session a record follows. */
export function draftPicks(session: Session): DraftPatch {
  return {
    id: session.id,
    environmentId: session.environmentId,
    projectId: session.projectId ?? null,
    workspaceId: session.workspaceId ?? null,
    cwd: session.cwd,
    harness: session.harness,
    model: session.model,
    modelSettings: session.modelSettings,
    runtimeMode: session.runtimeMode,
    ...(session.accessPicked ? { accessPicked: true as const } : {}),
    ...(session.modelPicked ? { modelPicked: true as const } : {}),
    threadType: session.threadType ?? "chat",
    threadRules: session.threadRules ?? null,
    master: !!session.draftMaster,
    title: session.draftTitle ?? "",
    ...(session.scope === "work" ? { scope: "work" as const } : {}),
  };
}

/** The draft's Session rebuilt from its record, at `place` when it moved. A
 *  draft outside every workspace is the home's and runs in its home: a record
 *  saved with a folder (an older build's boot seed in the window's last
 *  folder) never brings that folder back. */
export function sessionFromDraft(record: DraftRecord, place: DraftPlace | null, now = Date.now()): Session {
  const where = place ?? record;
  // A model seeded once is no pick either: the draft shows his defaults as they are now.
  return withNewThreadModel({
    id: record.id,
    environmentId: where.environmentId,
    harness: record.harness,
    model: record.model,
    modelSettings: record.modelSettings,
    ...(record.modelPicked ? { modelPicked: true as const } : {}),
    // A mode seeded once is no pick: the draft shows his defaults as they are now.
    ...(record.accessPicked
      ? { runtimeMode: record.runtimeMode, accessPicked: true as const }
      : { runtimeMode: newThreadAccess(where.environmentId, where) }),
    title: HARNESS_LABEL[record.harness],
    cwd: where.projectId || where.workspaceId ? where.cwd : "~",
    projectId: where.projectId,
    workspaceId: where.workspaceId,
    threadType: record.threadType,
    ...(record.threadRules ? { threadRules: record.threadRules } : {}),
    ...(record.master ? { draftMaster: true } : {}),
    ...(record.title ? { draftTitle: record.title } : {}),
    // A Work Chat's draft stays one: outside every workspace, it asks for Work at its first send.
    ...(record.scope === "work" && !where.projectId && !where.workspaceId ? { scope: "work" as const } : {}),
    createdAt: now,
    blocks: [],
  });
}

/** The tail a start about a thing adds to its scope's key (lib/sourceDraft.ts `sourceDraftKey`). */
const ABOUT = "#about:";
/** The tail of a moved draft's own key, when the scope's key holds another draft's words. */
const MOVED = "#draft:";

/**
 * The key a draft takes when he files it in another scope (a Work draft's filing control: a project, No project,
 * Another job). A start's own draft (`<scope>#about:<ref>`) stays about its thing under the new scope; any other takes
 * the new scope's key. A key whose draft holds his words, unsent, is never taken: the moved draft gets one of its own
 * (`<scope>#draft:<id>`) and his other words stay where he left them, as a start about a thing does (sourceDraft.ts).
 */
export function movedDraftKey(args: {
  fromKey: string;
  toScope: string;
  id: string;
  record: (key: string) => DraftRecord | undefined;
  /** whether draft `id` has become a thread: its record is no draft any more */
  sent: (id: string) => boolean;
}): string {
  const { fromKey, toScope, id, record, sent } = args;
  const at = fromKey.indexOf(ABOUT);
  const target = toScope + (at >= 0 ? fromKey.slice(at) : "");
  const other = record(target);
  if (!other || other.id === id || sent(other.id) || holdsNothing(other)) return target;
  return `${toScope}${MOVED}${id}`;
}

/** A draft filed at `to`: its place, and the defaults there for what he did not pick himself. His words, his
 *  attachments and its chips are not on the session (the composer, the record and Work's chip store keep them by id). */
export function filedDraft(session: Session, to: DraftPlace): Session {
  const moved: Session = {
    ...session,
    environmentId: to.environmentId,
    projectId: to.projectId,
    workspaceId: to.workspaceId,
    cwd: to.cwd,
    branch: undefined,
    worktreeCwd: undefined,
    ...(session.accessPicked ? {} : { runtimeMode: newThreadAccess(to.environmentId, to) }),
  };
  return withNewThreadModel(moved);
}

export type DraftCopy = Pick<ProjectMeta, "id" | "environmentId" | "workspaceId" | "cwd">;

/**
 * How New thread (and a project switch with nothing to land on) reaches a
 * project's draft:
 * - `focus`: it is already in a pane;
 * - `rebuild`: a record exists; `place` is set when its host has no live copy
 *   of a linked project and another connected copy takes it;
 * - `seed`: none yet (or its id has become a thread), the caller seeds one.
 * A `threadType` passed in retypes the draft, keeping its text.
 */
export type DraftRetype = { threadType: ThreadType; threadRules: ThreadRules | null };

export type DraftPlan =
  | { kind: "focus"; id: string; retype: DraftRetype | null }
  | { kind: "rebuild"; record: DraftRecord; place: DraftPlace | null; retype: DraftRetype | null }
  | { kind: "seed" };

export function planProjectDraft(args: {
  record: DraftRecord | undefined;
  /** Whether a pane shows session `id`. */
  inPane: (id: string) => boolean;
  /** Whether session `id` has a host meta (it was sent). */
  hasMeta: (id: string) => boolean;
  /** Every live copy of the record's project (empty for an unlinked one). */
  copies: readonly DraftCopy[];
  connected: (environmentId: string) => boolean;
  /** The host "New threads start on" names for the project (lib/projectHostChoice.ts `chooseCopy`), when it has a copy. */
  preferred: string | null;
  /** New thread… of a type (and its rules): the draft takes them. */
  threadType?: ThreadType;
  threadRules?: ThreadRules | null;
}): DraftPlan {
  const { record, inPane, hasMeta, copies, connected, preferred } = args;
  if (!record || hasMeta(record.id)) return { kind: "seed" };
  const asked = args.threadType ?? null;
  const rules = args.threadRules ?? null;
  const retype =
    asked && (asked !== record.threadType || JSON.stringify(rules) !== JSON.stringify(record.threadRules))
      ? { threadType: asked, threadRules: rules }
      : null;
  if (inPane(record.id)) return { kind: "focus", id: record.id, retype };
  const at = (place: DraftPlace | null): DraftPlan => ({ kind: "rebuild", record, place, retype });
  if (copies.length === 0) return at(null);
  const own = copies.find((c) => c.environmentId === record.environmentId);
  if (own && connected(own.environmentId)) return at(null);
  const live = copies.filter((c) => connected(c.environmentId));
  const copy = live.find((c) => c.environmentId === preferred) ?? live[0];
  if (!copy) return at(null);
  return at({ environmentId: copy.environmentId, projectId: copy.id, workspaceId: copy.workspaceId ?? null, cwd: copy.cwd });
}
