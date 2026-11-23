import { useEffect, useMemo, useRef, useState } from "react";
import { makeFunctionReference } from "convex/server";
import type { SectorKey } from "@shared/work";
import { isChatSource, type ChatDetail, type ChatHit, type ChatMessage, type ChatRow, type ChatSourceState } from "@shared/work/messages";
import { loadToast } from "../../components/ui/toaster";
import { useLifeosQuery, type LifeosQuery, type LifeosSession } from "../shell/lifeos";
import type { MessagesData, Paged } from "./data";
import type { ChatFilter } from "./model";

/**
 * The seam answered from LifeOS (docs/agents/work-messages.md "The view"):
 * live queries on the workspace's own sector session, so the view can list no
 * other job's chat, and the read mark written there. Every send goes through
 * the host, in the composer's phase.
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

const NONE: ReadonlySet<string> = new Set();

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

export function liveData(session: LifeosSession, sector: SectorKey): MessagesData {
  const write = (name: string, id: string, failed: string): void => {
    const client = session.client;
    if (!client) return;
    client.mutation(makeFunctionReference<"mutation">(name), { id }).catch(() => void loadToast().then((toast) => toast.error(failed)));
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
    // A thread's draft for a conversation is the host's, and comes with the composer's phase.
    useDrafted: () => NONE,
    useNow: useMinute,
    markRead: (chatId: string) => write("chats:markRead", chatId, "Couldn't mark it read"),
    markUnread: (chatId: string) => write("chats:markUnread", chatId, "Couldn't mark it unread"),
  };
}
