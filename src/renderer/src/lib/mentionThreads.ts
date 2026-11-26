import { useState, useSyncExternalStore } from "react";
import { rankThreads } from "./composerTriggers";
import { timeAgo } from "./duration";
import { sessionStore } from "./tcserver/store";
import type { SessionMeta } from "./tcserver/types";

const NONE: readonly SessionMeta[] = [];
const noSubscribe = (): (() => void) => () => {};
const subscribeMetas = (l: () => void): (() => void) => sessionStore.onMetaChange(l);

/** What a thread row of the `@` menu draws and picks: a push that moves nothing here is no new list. */
const drawn = (m: SessionMeta): string =>
  `${m.id}\t${m.environmentId}\t${m.status}\t${m.title}\t${m.projectId ?? ""}\t${timeAgo(m.updatedAt)}`;

function threadReader() {
  let key = "";
  let rows: readonly SessionMeta[] = NONE;
  return (query: string, currentId: string | undefined, projectId: string | null): readonly SessionMeta[] => {
    const next = rankThreads(sessionStore.metas(), query, currentId, projectId);
    const nextKey = next.map(drawn).join("\n");
    if (nextKey !== key || rows === NONE) {
      key = nextKey;
      rows = next.length === 0 ? NONE : next;
    }
    return rows;
  };
}

/**
 * The threads the `@` menu offers, ranked on the metas only while `enabled`
 * (the menu open in `@` mode): the same array until a push changes what a
 * row draws, so a meta push that moves nothing shown renders no Composer.
 */
export function useMentionThreads(
  enabled: boolean,
  query: string,
  currentId: string | undefined,
  projectId: string | null,
): readonly SessionMeta[] {
  const [read] = useState(threadReader);
  return useSyncExternalStore(
    enabled ? subscribeMetas : noSubscribe,
    () => (enabled ? read(query, currentId, projectId) : NONE),
  );
}
