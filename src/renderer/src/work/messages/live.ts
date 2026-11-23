import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { makeFunctionReference } from "convex/server";
import { loadBytes } from "work-kit/mail/lib/bytes";
import { messagesPaneOf, type SectorKey } from "@shared/work";
import type { MessagesDraftsAnswer, MessagesSendAnswer } from "@shared/contract-work-messages";
import { isChatSource, type ChatDetail, type ChatDraft, type ChatFile, type ChatHit, type ChatMessage, type ChatRow, type ChatSourceState } from "@shared/work/messages";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { saveDownload } from "../../lib/native";
import { refusalWords } from "../../lib/settingsHome";
import { sessionStore } from "../../lib/tcserver/store";
import { shell } from "../../stores/shell";
import { openItem } from "../canvas/store";
import { discardItem, editItem, notSentWords, outboxNow, sendItem, useOutbox, wantOutboxItem, wentOut, type HostItem } from "../outbox/store";
import { useLifeosQuery, type LifeosQuery, type LifeosSession } from "../shell/lifeos";
import type { MessagesData, Paged, ThreadDraft } from "./data";
import { chatFileSource, fileVerb, viewKind } from "./files";
import type { ChatFilter } from "./model";

/**
 * The seam answered from LifeOS (docs/agents/work-messages.md "The view"):
 * live queries on the workspace's own sector session, so the view can list no
 * other job's chat, and the read mark written there. Every send goes through
 * the host (`work.messages.*`); a thread's held reply is the Outbox's own
 * item, pressed as the Outbox presses it.
 */

type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };
type SourceRow = { _id: string; kind: string; label: string; status: string; lastSyncAt?: number; reportedAt?: number; error?: string; enabled?: boolean; sector?: string };

/** The list grows by this many conversations as he nears its end; a conversation by this many messages as he scrolls up. */
export const CHAT_PAGE = 100;
export const MESSAGE_PAGE = 50;

/** A live query, or none while `args` is null: a session with no client waits and asks nothing. */
function useQuery<T>(session: LifeosSession, name: string, args: Record<string, unknown> | null): LifeosQuery<T> {
  return useLifeosQuery<T>(args ? session : { ...session, client: null, state: "connecting" }, name, args ?? {});
}

/**
 * One paged live query, grown in place: `more` asks for `step` more, and
 * while the bigger answer is on its way the smaller one stays on screen.
 * `reset` names what the pages belong to; a new one starts over.
 */
function usePaged<T>(session: LifeosSession, name: string, args: Record<string, unknown> | null, step: number, reset: string): LifeosQuery<Paged<T>> {
  const [want, setWant] = useState({ reset, count: step });
  const count = want.reset === reset ? want.count : step;
  const query = useQuery<Page<T>>(session, name, args ? { ...args, paginationOpts: { numItems: count, cursor: null } } : null);
  const held = useRef<{ reset: string; value: Paged<T> } | null>(null);
  const ready = query.status === "ready" ? query.value : null;
  const value = useMemo<Paged<T> | null>(() => {
    if (!ready) return null;
    // One ask a page: until the answer fills what was asked, asking again changes nothing.
    const more = (): void =>
      setWant((w) => {
        const asked = w.reset === reset ? w.count : step;
        return ready.isDone || ready.page.length < asked ? w : { reset, count: asked + step };
      });
    return { rows: ready.page, done: ready.isDone, more };
  }, [ready, reset, step]);
  if (value) held.current = { reset, value };
  if (!args) return { status: "loading" };
  if (query.status === "failed") return query;
  if (value) return { status: "ready", value };
  const kept = held.current?.reset === reset ? held.current.value : null;
  return kept ? { status: "ready", value: kept } : { status: "loading" };
}

/** The minute, moved on as it turns. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = (): void => setNow(Date.now());
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}


/** The source rows of this job that are chat, as the sync line and the empty list read them. */
export function chatSources(rows: readonly SourceRow[], sector: SectorKey): ChatSourceState[] {
  return rows
    .filter((row) => isChatSource(row.kind) && row.enabled !== false && (!row.sector || row.sector === sector))
    .map((row) => ({
      kind: row.kind as ChatSourceState["kind"],
      label: row.label,
      status: row.status === "error" ? "error" : row.status === "ok" ? "ok" : "idle",
      lastSyncAt: row.lastSyncAt,
      reportedAt: row.reportedAt,
      error: row.error,
    }));
}

export function liveData(session: LifeosSession, sector: SectorKey, env: string, workspaceId: string): MessagesData {
  /** A call to the host, refused in its own words (LifeOS's sentence where LifeOS said no). */
  const host = async <T = unknown>(method: string, args: Record<string, unknown>): Promise<T> => {
    try {
      return await registry.linkOf(env).request<T>(method, args);
    } catch (err) {
      throw new Error(refusalWords(err) || "The host did not answer");
    }
  };
  const write = (name: string, id: string, failed: string, onFailed?: () => void): void => {
    const client = session.client;
    if (!client) return void onFailed?.();
    client.mutation(makeFunctionReference<"mutation">(name), { id }).catch(() => {
      onFailed?.();
      void loadToast().then((toast) => toast.error(failed));
    });
  };
  return {
    useChats: (filter: ChatFilter) => usePaged<ChatRow>(session, "chats:list", { sector, filter }, CHAT_PAGE, filter),
    useUnread: () => {
      const unread = useLifeosQuery<{ count: number }>(session, "chats:unread", { sector });
      return unread.status === "ready" ? unread.value.count : null;
    },
    useChat: (id: string | null) => {
      return useQuery<ChatDetail | null>(session, "chats:get", id ? { id } : null);
    },
    useMessages: (chatId: string | null) => usePaged<ChatMessage>(session, "chats:messages", chatId ? { chatId } : null, MESSAGE_PAGE, chatId ?? ""),
    useSources: () => {
      const rows = useLifeosQuery<SourceRow[]>(session, "sources:list", {});
      const value = rows.status === "ready" ? rows.value : null;
      const sources = useMemo(() => (value ? chatSources(value, sector) : null), [value]);
      if (rows.status === "failed") return rows;
      return sources ? { status: "ready", value: sources } : { status: "loading" };
    },
    useSearch: (text: string) => {
      const query = text.trim();
      const hits = useQuery<ChatHit[]>(session, "chats:search", query ? { sector, text: query, limit: 50 } : null);
      return query ? hits : { status: "ready", value: [] };
    },
    useDrafted: () => {
      const held = useHeldReplies(env, workspaceId);
      const copies = useCopyDrafts(env, workspaceId);
      // The row's mark says a draft waits: a held reply whose press failed is the Outbox's to say, not the row's.
      return useMemo(() => new Set([...held.flatMap((item) => (item.state === "held" ? (chatOf(item) ?? []) : [])), ...copies.map((d) => d.chatId)]), [held, copies]);
    },
    useNow: useMinute,
    markRead: (chatId: string) => write("chats:markRead", chatId, "Couldn't mark it read"),
    markUnread: (chatId: string, onFailed?: () => void) => write("chats:markUnread", chatId, "Couldn't mark it unread", onFailed),
    send: async (chatId, text) => {
      await host<MessagesSendAnswer>("work.messages.send", { workspaceId, chatId, text });
    },
    undo: async (chatId, id) => (await host<{ text: string }>("work.messages.undo", { workspaceId, chatId, id })).text,
    retry: async (chatId, id) => {
      await host("work.messages.retry", { workspaceId, chatId, id });
    },
    useDrafts: (chatId) => {
      const held = useHeldReplies(env, workspaceId);
      const copies = useCopyDrafts(env, workspaceId);
      return useMemo(
        () =>
          chatId
            ? [
                ...held.filter((item) => chatOf(item) === chatId).map(heldDraft),
                ...copies.filter((d) => d.chatId === chatId).map((d): ThreadDraft => ({ id: d.id, held: false, text: d.text, threadId: d.sessionId, ...(threadTitle(d.sessionId, d.thread) ? { thread: threadTitle(d.sessionId, d.thread) } : {}) })),
              ]
            : [],
        [held, copies, chatId],
      );
    },
    sendDraft: async (draft, text) => {
      const item = heldItem(env, draft.id);
      if (!item) throw new Error("This draft is no longer waiting");
      const payload = (item.payload ?? {}) as { text?: string };
      const pressed = payload.text === text ? item : { ...(await editItem(item, { ...payload, text })), environmentId: env };
      const after = await sendItem(pressed);
      if (!wentOut(after)) throw Object.assign(new Error(notSentWords(after)), { failed: after.state === "failed", unknown: after.outcomeUnknown === true });
    },
    openOutbox: (draft) => {
      // That very item, in whichever tab holds it, whatever tab was open last.
      if (draft.outboxKey) wantOutboxItem(draft.outboxKey);
      shell.openOutbox();
    },
    saveDraft: async (draft, text) => {
      const item = heldItem(env, draft.id);
      if (!item) throw new Error("This draft is no longer waiting");
      const payload = (item.payload ?? {}) as { text?: string };
      if (payload.text !== text) await editItem(item, { ...payload, text });
    },
    dropDraft: async (draft) => {
      if (draft.held) {
        const item = heldItem(env, draft.id);
        if (item) await discardItem(item);
      } else {
        await host("work.messages.dropDraft", { workspaceId, id: draft.id });
        void loadCopyDrafts(env, workspaceId);
      }
    },
    requestFiles: async (messageId) => {
      const client = session.client;
      if (!client) throw new Error("LifeOS is not connected");
      await client.mutation(makeFunctionReference<"mutation">("chats:requestFiles"), { messageId });
    },
    // One file by its id, on the workspace's sector session: LifeOS's `chats:file` row (status and address).
    useFile: (fileId) => useQuery<ChatFile | null>(session, "chats:file", fileId ? { id: fileId } : null),
    fileVerb,
    openFile: (chatId, messageId, file) => {
      const kind = viewKind(file);
      if (kind) {
        void openItem(env, messagesPaneOf(workspaceId), { kind, source: chatFileSource(chatId, messageId, file), title: file.name.slice(0, 200) });
        return;
      }
      void saveFile(file).then(
        (saved) => loadToast().then((toast) => (saved ? toast("Saved to Downloads") : toast.error(`${file.name} is still on its way from LifeOS`))),
        () => loadToast().then((toast) => toast.error(`Couldn't save ${file.name}`)),
      );
    },
  };
}

// ── Files ──

/** Saves a stored file to Downloads under its own name; false while LifeOS has not stored it yet. */
async function saveFile(file: ChatFile): Promise<boolean> {
  if (!file.url) return false;
  const blob = await loadBytes(file.url);
  await saveDownload(file.name, new Uint8Array(await blob.arrayBuffer()));
  return true;
}

// ── A thread's drafts ──

const chatOf = (item: HostItem): string | undefined => ((item.payload ?? {}) as { chatId?: string }).chatId;
/** A thread's title, from the host's own threads first, else the name the draft kept. */
const threadTitle = (sessionId: string | null, kept?: string): string | undefined => (sessionId ? sessionStore.metaOf(sessionId)?.title?.trim() : undefined) || kept?.trim() || undefined;
const heldDraft = (item: HostItem): ThreadDraft => {
  const title = threadTitle(item.sessionId);
  return {
    id: item.ref.id,
    held: true,
    text: String(((item.payload ?? {}) as { text?: unknown }).text ?? ""),
    threadId: item.sessionId,
    ...(title ? { thread: title } : {}),
    outboxKey: `${item.environmentId}:${item.ref.at}:${item.ref.id}`,
    ...(item.state === "failed" ? { failed: item.error ?? "It couldn't be sent", ...(item.outcomeUnknown ? { unknown: true } : {}) } : {}),
  };
};
const heldItem = (env: string, id: string): HostItem | undefined => outboxNow().waiting.find((item) => item.environmentId === env && item.ref.id === id && item.kind === "chat.reply");

/** This workspace's held replies still waiting, and those whose press failed, from the Outbox's own list of the host. */
function useHeldReplies(env: string, workspaceId: string): readonly HostItem[] {
  const { waiting } = useOutbox();
  return useMemo(() => waiting.filter((item) => item.environmentId === env && item.workspaceId === workspaceId && item.kind === "chat.reply" && (item.state === "held" || item.state === "failed")), [waiting, env, workspaceId]);
}

// The copy-only drafts a workspace holds, read once and again on the host's `work.messages` push.
const copyDrafts = new Map<string, readonly ChatDraft[]>();
const copyListeners = new Set<() => void>();
const watchedDrafts = new Set<string>();
const NO_COPIES: readonly ChatDraft[] = [];
const draftsKey = (env: string, workspaceId: string): string => `${env}\u0000${workspaceId}`;

function loadCopyDrafts(env: string, workspaceId: string): Promise<void> {
  return registry
    .linkOf(env)
    .request<MessagesDraftsAnswer>("work.messages.drafts", { workspaceId })
    .then(
      ({ drafts }) => void copyDrafts.set(draftsKey(env, workspaceId), drafts),
      () => {},
    )
    .finally(() => {
      for (const fn of copyListeners) fn();
    });
}

function useCopyDrafts(env: string, workspaceId: string): readonly ChatDraft[] {
  const key = draftsKey(env, workspaceId);
  useEffect(() => {
    if (watchedDrafts.has(key)) return;
    watchedDrafts.add(key);
    void loadCopyDrafts(env, workspaceId);
    registry.linkOf(env).onPush((push) => {
      if (push.push === "work.messages" && push.workspaceId === workspaceId) void loadCopyDrafts(env, workspaceId);
    });
  }, [env, workspaceId, key]);
  return useSyncExternalStore(
    (fn) => {
      copyListeners.add(fn);
      return () => void copyListeners.delete(fn);
    },
    () => copyDrafts.get(key) ?? NO_COPIES,
  );
}
