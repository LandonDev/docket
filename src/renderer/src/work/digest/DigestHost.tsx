import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TellRow } from "@shared/work/tell";
import { useToastSync } from "../../chrome/toastSync";
import { requestSettings } from "../../lib/monaco/debugTab";
import { systemNotice } from "../../lib/native";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { normalizeProjectPath } from "../../lib/recents";
import { workPlaceRow } from "../../lib/workPlaces";
import { digestOpensPort, openWorkView, workOpenPort } from "../../lib/workSwitch";
import { project } from "../../stores/project";
import { shell } from "../../stores/shell";
import { wantOutboxItem } from "../outbox/store";
import { DigestSheet } from "./DigestSheet";
import { DIGEST_TOAST, digestNotice, nowToasts, onlyToday, openInterrupts, systemNotices, tellingOf, toastOfNotice, type NowToast } from "./notice";
import { go, routeOf, type Routes } from "./open";
import { markSeen, openDigestSheet, setTellOpener, useDigest, useDigestSheetOpen } from "./store";

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


/** Today's id among the pages above the workspaces (work/today/open.ts). */
const TODAY = "today";

/** What the digest's notice opens: the page Today registered (`digestOpensPort`), else Today itself once its row is on the rail, else null: the digest's own list. */
export const digestOpens = (): (() => void) | null => digestOpensPort.get() ?? (workPlaceRow(TODAY) ? () => shell.openWorkPlace(TODAY) : null);

export function DigestHost() {
  const view = useDigest();
  const sheetOpen = useDigestSheetOpen();
  const workspaces = useWorkspaces();
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
      for (const row of rows) next.add(tellingOf(row));
      writeDismissed(next);
      return next;
    });
  }, []);

  const routes = useMemo<Routes>(
    () => ({
      thread: (sessionId) => workOpenPort.get()?.(sessionId),
      // The window moves to the job's workspace and opens the view on the thing, as a row of Today does (work/today/open.ts `goTo`).
      view: (wanted) => {
        const workspace = workspaces.find((w) => w.id === wanted.workspaceId);
        if (!workspace) return;
        shell.closeViews();
        project.enterWorkspace(normalizeProjectPath(workspace.path));
        openWorkView(wanted);
      },
      // A page above the workspaces, once its row is on the rail: until then there is no such page.
      place: (id) => {
        if (!workPlaceRow(id)) return false;
        shell.openWorkPlace(id);
        return true;
      },
      outbox: (item) => {
        if (item) wantOutboxItem(item);
        shell.openOutbox();
      },
      settings: (section) => requestSettings(section),
    }),
    [workspaces],
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
  /**
   * The digest's press. Every unseen day is seen, so he must land where all of them show: Today when the one
   * unseen day is today (Today shows that day alone), else the list, which holds every day.
   */
  const digest = useMemo(() => digestNotice(view), [view]);
  const openDigest = useCallback(() => {
    if (digest) markSeen(digest.days);
    const today = digest && onlyToday(digest.days, Date.now()) ? digestOpens() : null;
    if (today) today();
    else openDigestSheet(true);
  }, [digest]);
  // Today's own rows of the digest open through the same routes (today.ts).
  useEffect(() => {
    setTellOpener(openRow);
    return () => setTellOpener(null);
  }, [openRow]);

  const toasts = useMemo(() => nowToasts(openInterrupts(view, dismissed, now)), [view, dismissed, now]);
  const openToast = useCallback(
    (toast: NowToast) => {
      if (toast.rows.length === 1) return openRow(toast.rows[0]!);
      dismiss(toast.rows);
      openDigestSheet(true);
    },
    [dismiss, openRow],
  );

  // A toast is drawn again only when its words change, so its presses read what it stands for now: the same words may
  // come to mean another telling of the thing, or more rows than when it was drawn.
  const live = useRef({ toasts, digest, openToast, openDigest });
  live.current = { toasts, digest, openToast, openDigest };
  // A toast this code takes away is not one he closed.
  const taken = useRef(new Set<string>());
  useToastSync(
    toasts,
    (toast) => toast.id,
    (api, toast, id) => {
      // Shown again in place (its words changed): nothing was taken away, so his next close is his own.
      taken.current.delete(id);
      api.warning(toast.title, {
        id,
        description: toast.detail,
        duration: Infinity,
        closeButton: true,
        action: { label: "Open", onClick: () => live.current.openToast(live.current.toasts.find((t) => t.id === id) ?? toast) },
        onDismiss: () => {
          if (!taken.current.delete(id)) dismiss((live.current.toasts.find((t) => t.id === id) ?? toast).rows);
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
      taken.current.delete(id);
      api(notice.line, {
        id,
        duration: Infinity,
        closeButton: true,
        action: { label: "Open", onClick: () => live.current.openDigest() },
        // Closed is seen: it does not come back on the next window.
        onDismiss: () => {
          if (!taken.current.delete(id)) markSeen((live.current.digest ?? notice).days);
        },
      });
      return () => void taken.current.add(id);
    },
    (notice) => notice.line,
  );

  // The same two things as system notifications, for a person looking at another app (src/main/notice.ts).
  const system = useMemo(() => systemNotices(digest, toasts), [digest, toasts]);
  const asked = useRef(new Map<string, string>());
  useEffect(() => {
    // Its words: asked again when either line changes, so the notice says what the toast says.
    const next = new Map(system.map((n) => [n.key, `${n.title}\n${n.body}`]));
    for (const key of asked.current.keys()) if (!next.has(key)) void systemNotice.close(key);
    for (const notice of system) if (asked.current.get(notice.key) !== next.get(notice.key)) void systemNotice.show(notice);
    asked.current = next;
  }, [system]);
  useEffect(() => {
    const off = systemNotice.onOpen((key) => {
      if (key.startsWith("digest:")) return live.current.openDigest();
      const toast = live.current.toasts.find((t) => t.id === toastOfNotice(key));
      if (toast) live.current.openToast(toast);
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

