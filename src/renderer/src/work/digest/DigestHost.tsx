import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TellRow } from "@shared/work/tell";
import { useToastSync } from "../../chrome/toastSync";
import { requestSettings } from "../../lib/monaco/debugTab";
import { systemNotice } from "../../lib/native";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { normalizeProjectPath } from "../../lib/recents";
import { workPlaceRow } from "../../lib/workPlaces";
import { openWorkPlaceAt } from "../../lib/workPlaceAt";
import { choose, digestOpensPort, openWorkView, stillChosen, workEnterPort, workOpenPort, workViewNow } from "../../lib/workSwitch";
import { loadToast } from "../../components/ui/toaster";
import { refusalWords } from "../../lib/settingsHome";
import { project } from "../../stores/project";
import { shell } from "../../stores/shell";
import { wantOutboxItem } from "../outbox/store";
import { DigestSheet } from "./DigestSheet";
import { DIGEST_TOAST, digestNotice, nowToasts, onlyToday, openInterrupts, systemNotices, tellingOf, type NowToast } from "./notice";
import { go, routeOf, type Routes } from "./open";
import { todayShowsAll } from "./today";
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
/** A thing told longer than this before the window opened was heard already: its notice is shown without a sound. */
const HEARD_BEFORE_MS = 60_000;

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

  const routes = useMemo<Routes>(() => {
    /** The job's workspace, entered as a press on its rail row does, with every overlay closed; null: not in this window. */
    const enter = (workspaceId: string) => {
      const workspace = workspaces.find((w) => w.id === workspaceId);
      if (!workspace) return null;
      shell.closeOverlays();
      const toRail = workEnterPort.get();
      if (toRail) toRail(workspace.path);
      else project.enterWorkspace(normalizeProjectPath(workspace.path));
      return workspace;
    };
    return {
      thread: (sessionId) => workOpenPort.get()?.(sessionId),
      // The window moves to the job's workspace and opens the view on the thing, as a row of Today does (work/today/open.ts
      // `goTo`). Settings closes first: a press from its Digest section, or a toast over it, must not open behind it.
      view: (wanted) => {
        const workspace = enter(wanted.workspaceId);
        if (workspace) openWorkView(wanted);
        return !!workspace;
      },
      // A guest's edit: the document itself, in a Files tab of the job (the host names the tab by the document's title).
      // A refusal is said, and Files shown, only while this press is still his latest choice (`stillChosen`): a thread he
      // opened while the host made the tab keeps the window.
      file: (workspaceId, ref) => {
        const workspace = enter(workspaceId);
        if (!workspace) return false;
        const mine = choose();
        const before = workViewNow();
        void import("../files/openFrom").then(({ openInFiles }) => {
          const current = stillChosen(mine, before, workspaceId);
          // openInFiles takes the next number as it starts: still the latest at its end means nothing was chosen since.
          return openInFiles(workspace, { ref, name: "Untitled" }).catch((err: unknown) => {
            if (!current || !stillChosen(mine + 1, before, workspaceId)) return;
            openWorkView({ workspaceId, view: "files" });
            void loadToast().then((toast) => toast.error("It did not open", { description: refusalWords(err) || undefined }));
          });
        });
        return true;
      },
      // A page above the workspaces, once its row is on the rail: until then there is no such page. A moment it names
      // (the review's week) is where the page opens.
      place: (id, at) => {
        if (!workPlaceRow(id)) return false;
        const moment = at === undefined ? NaN : Number(at);
        openWorkPlaceAt(id, Number.isFinite(moment) ? moment : undefined);
        return true;
      },
      outbox: (item) => {
        if (item) wantOutboxItem(item);
        shell.openOutbox();
      },
      settings: (section) => requestSettings(section),
    };
  }, [workspaces]);
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
   * unseen day is today and Today has a row for each thing it counts (Today shows that day alone, and not
   * tomorrow's prep or next week's clash), else the list, which holds every day.
   */
  const digest = useMemo(() => digestNotice(view), [view]);
  const openDigest = useCallback(() => {
    if (digest) markSeen(digest.days);
    const now = Date.now();
    const onToday = !!digest && onlyToday(digest.days, now) && todayShowsAll(digest.rows, digest.days[0]!.day);
    const today = onToday ? digestOpens() : null;
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
  // A telling sounds once, when its notice is first asked; what was told before this window opened is not news to
  // the ear. So a fold that loses a thing, or breaks up into its things, is shown again without a sound.
  const heard = useRef(new Set<string>());
  const openedAt = useRef(Date.now() - HEARD_BEFORE_MS);
  const system = useMemo(() => systemNotices(digest, toasts, (row) => heard.current.has(tellingOf(row)) || (row.toldAt ?? 0) < openedAt.current), [digest, toasts]);
  const asked = useRef(new Map<string, string>());
  useEffect(() => {
    // Its words: asked again when either line changes, so the notice says what the toast says; and when what it tells
    // changes in the same words (a deadline brought forward), so that telling sounds.
    const next = new Map(system.map((n) => [n.key, `${n.title}\n${n.body}\n${n.telling ?? ""}`]));
    for (const key of asked.current.keys()) if (!next.has(key)) void systemNotice.close(key);
    for (const notice of system) if (asked.current.get(notice.key) !== next.get(notice.key)) void systemNotice.show(notice);
    asked.current = next;
    for (const toast of toasts) for (const row of toast.rows) heard.current.add(tellingOf(row));
  }, [system, toasts]);
  useEffect(() => {
    const off = systemNotice.onOpen((key) => {
      if (key.startsWith("digest:")) return live.current.openDigest();
      const toast = live.current.toasts.find((t) => t.id === key);
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

