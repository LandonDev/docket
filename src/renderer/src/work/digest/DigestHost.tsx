import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TellRow } from "@shared/work/tell";
import { useToastSync } from "../../chrome/toastSync";
import { requestSettings } from "../../lib/monaco/debugTab";
import { systemNotice } from "../../lib/native";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { digestOpensPort, openWorkView, workOpenPort, type OpenWorkView } from "../../lib/workSwitch";
import { useSelectedWorkspaceIds } from "../../stores/project";
import { shell } from "../../stores/shell";
import { wantOutboxItem } from "../outbox/store";
import { DigestSheet } from "./DigestSheet";
import { DIGEST_TOAST, digestNotice, nameOf, nowToasts, openInterrupts, systemNotices, type NowToast } from "./notice";
import { go, routeOf, type Routes } from "./open";
import { markSeen, openDigestSheet, useDigest, useDigestSheetOpen } from "./store";

/**
 * The digest on the desktop, mounted once while Work is on (WorkRailHost;
 * docs/agents/work-digest.md "Telling him (desktop)"). It draws the list's
 * sheet and nothing else: the two toasts and their system notifications are
 * mirrored from the ledger each host keeps.
 *
 *   The digest     one toast for the days he has not opened, with Open; it
 *                  stays until he opens or closes it here or anywhere.
 *   An interrupt   one toast a thing that cannot wait, with Open; it goes
 *                  when the thing is done, opened or closed.
 */

const DISMISSED_KEY = "work.digest.dismissed";

function readDismissed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}
function writeDismissed(names: ReadonlySet<string>): void {
  try {
    // The newest 200: an interrupt a day old no longer shows whatever this holds.
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...names].slice(-200)));
  } catch {
    // A full store only means a closed toast may come back after a reload.
  }
}


type Props = {
  /** Moves the window to a workspace by its folder (App's own). */
  onOpenWorkspace: (path: string) => void;
};

export function DigestHost({ onOpenWorkspace }: Props) {
  const view = useDigest();
  const sheetOpen = useDigestSheetOpen();
  const workspaces = useWorkspaces();
  const selected = useSelectedWorkspaceIds();
  const [dismissed, setDismissed] = useState(readDismissed);
  // The minute hand: an interrupt a day old leaves on its own.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  // Another window closed one: this window's goes too.
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === DISMISSED_KEY) setDismissed(readDismissed());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const dismiss = useCallback((rows: readonly TellRow[]) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      for (const row of rows) next.add(nameOf(row));
      writeDismissed(next);
      return next;
    });
  }, []);

  // A view of a workspace the window is not in: the window moves there first, and the view opens once it has.
  const [pending, setPending] = useState<OpenWorkView | null>(null);
  useEffect(() => {
    if (!pending || !selected?.includes(pending.workspaceId)) return;
    openWorkView(pending);
    setPending(null);
  }, [pending, selected]);

  const routes = useMemo<Routes>(
    () => ({
      thread: (sessionId) => workOpenPort.get()?.(sessionId),
      view: (wanted) => {
        const workspace = workspaces.find((w) => w.id === wanted.workspaceId);
        if (!workspace) return;
        if (selected?.includes(workspace.id)) return openWorkView(wanted);
        setPending(wanted);
        onOpenWorkspace(workspace.path);
      },
      place: (id) => {
        // Today's frame (`shell.openWorkPlace`), once it is on master: until then there is no such page.
        const open = (shell as { openWorkPlace?: (id: string) => void }).openWorkPlace;
        if (!open) return false;
        open(id);
        return true;
      },
      outbox: (item) => {
        if (item) wantOutboxItem(item);
        shell.openOutbox();
      },
      settings: (section) => requestSettings(section),
    }),
    [onOpenWorkspace, selected, workspaces],
  );
  const routesRef = useRef(routes);
  routesRef.current = routes;

  /** A row's press, from a toast or the list: its target, and the row is no longer a toast. */
  const openRow = useCallback(
    (row: TellRow) => {
      dismiss([row]);
      openDigestSheet(false);
      if (!go(routeOf(row), routesRef.current)) openDigestSheet(true);
    },
    [dismiss],
  );
  /** The digest's press: Today when it is registered, else the list. Every unseen day is seen. */
  const digest = useMemo(() => digestNotice(view), [view]);
  const openDigest = useCallback(() => {
    if (digest) markSeen(digest.days);
    const today = digestOpensPort.get();
    if (today) today();
    else openDigestSheet(true);
  }, [digest]);

  const toasts = useMemo(() => nowToasts(openInterrupts(view, dismissed, now)), [view, dismissed, now]);
  const openToast = useCallback(
    (toast: NowToast) => {
      if (toast.rows.length === 1) return openRow(toast.rows[0]!);
      dismiss(toast.rows);
      openDigestSheet(true);
    },
    [dismiss, openRow],
  );

  // A toast this code takes away is not one he closed.
  const taken = useRef(new Set<string>());
  useToastSync(
    toasts,
    (toast) => toast.id,
    (api, toast, id) => {
      api.warning(toast.title, {
        id,
        description: toast.detail,
        duration: Infinity,
        closeButton: true,
        action: { label: "Open", onClick: () => openToast(toast) },
        onDismiss: () => {
          if (!taken.current.delete(id)) dismiss(toast.rows);
        },
      });
      return () => void taken.current.add(id);
    },
    (toast) => `${toast.title}\0${toast.detail ?? ""}\0${toast.rows.length}`,
  );
  const digestItems = useMemo(() => (digest ? [digest] : []), [digest]);
  useToastSync(
    digestItems,
    () => DIGEST_TOAST,
    (api, notice, id) => {
      api(notice.line, {
        id,
        duration: Infinity,
        closeButton: true,
        action: { label: "Open", onClick: openDigest },
        // Closed is seen: it does not come back on the next window.
        onDismiss: () => {
          if (!taken.current.delete(id)) markSeen(notice.days);
        },
      });
      return () => void taken.current.add(id);
    },
    (notice) => notice.line,
  );

  // The same two things as system notifications, for a person looking at another app (src/main/notice.ts).
  const system = useMemo(() => systemNotices(digest, toasts), [digest, toasts]);
  const asked = useRef(new Map<string, string>());
  const actions = useRef({ openDigest, openToast, toasts });
  actions.current = { openDigest, openToast, toasts };
  useEffect(() => {
    const next = new Map(system.map((n) => [n.key, n.body]));
    for (const key of asked.current.keys()) if (!next.has(key)) void systemNotice.close(key);
    for (const notice of system) if (asked.current.get(notice.key) !== notice.body) void systemNotice.show(notice);
    asked.current = next;
  }, [system]);
  useEffect(() => {
    const off = systemNotice.onOpen((key) => {
      if (key.startsWith("digest:")) return actions.current.openDigest();
      const toast = actions.current.toasts.find((t) => t.id === key);
      if (toast) actions.current.openToast(toast);
    });
    return () => {
      off();
      for (const key of asked.current.keys()) void systemNotice.close(key);
      asked.current = new Map();
    };
  }, []);

  // The list is on screen: the days in it are seen.
  useEffect(() => {
    if (sheetOpen && digest) markSeen(digest.days);
  }, [sheetOpen, digest]);

  // Mounted only once opened, so the sheet's parts stay out of a window that never opens it.
  const [everOpen, setEverOpen] = useState(false);
  useEffect(() => {
    if (sheetOpen) setEverOpen(true);
  }, [sheetOpen]);
  if (!everOpen) return null;
  return <DigestSheet open={sheetOpen} onOpenChange={openDigestSheet} view={view} now={now} onOpenRow={openRow} />;
}

/** Test seam. */
export function resetDismissed(): void {
  try {
    localStorage.removeItem(DISMISSED_KEY);
  } catch {
    // no store, nothing kept
  }
}

