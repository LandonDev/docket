import { useEffect } from "react";
// From the state's own module: a value import of the menu tree would put every row of it in the first paint.
import { EMPTY_MENU_STATE, sameMenuState, WORK_ONLY_IDS, type MenuState } from "@shared/menuState";
import { shellStore } from "../stores/shell";
import { editorHeld, workCommands } from "./appCommands";
import { awayEnabled, awayStore } from "./away";
import { workspaceTabsStore } from "../stores/workspace";
import { leafIds } from "./layout";
import { threadsToMarkRead } from "./markRead";
import { messageListFold } from "./messageListFold";
import { menuStateSender } from "./native";
import { rightPanel } from "./rightPanel";
import { loadLastSeen, seenFloor, subscribeLastSeen } from "./sessionSeen";
import { sessionStore } from "./tcserver/store";
import { workspaceStore } from "./tcserver/workspaces";
import type { BatchAction } from "./threadBatch";
import { batchCounts, type BatchCounts } from "./threadBatchMenu";
import { isUnread } from "./threadStripModel";
import { workFilePort, workSwitch } from "./workSwitch";

/**
 * What the native menu bar shows for this window (src/shared/menuTree.ts):
 * Show or Hide on the four toggles, the rows that would do nothing
 * greyed, and Away from Computer ticked while it is on. Sent to main over
 * `menu:state` when it changes; a no-op at /ui.
 */

export type MenuFacts = {
  sidebarOpen: boolean;
  /** The focused root thread's panel, or `none` with no root thread on screen or no room for it. */
  panel: "open" | "closed" | "none";
  dockOpen: boolean;
  /** The transcript's message list is open (lib/messageListFold.ts). */
  messageList: boolean;
  /** The active tab holds more than one pane: ⌘W reads Close Pane, else Close Tab. */
  split: boolean;
  /** The dock's cwd is a project: Show Terminal has somewhere to open. */
  dockUsable: boolean;
  unread: number;
  counts: BatchCounts;
  /** This machine's Away is on (lib/away.ts). */
  away: boolean;
  workFile: boolean;
  /** Some host has Work on: Search Work… has somewhere to look, the digest a list to open, and Work's own rows (Go → Today) are drawn. */
  workOn?: boolean;
  /** Today is the page on screen: its row reads Close Today, as its key closes it. */
  today?: boolean;
  /** A Work editor on screen answers Print… and Export… (lib/appCommands.ts `workCommands`). */
  print?: boolean;
  export?: boolean;
  /** A document of a Work workspace on screen answers Save as Word to… (work/docs/DocumentCanvas.tsx). */
  saveWord?: boolean;
  /** The rows whose keys the editor holding the caret owns (`editorHeld`). */
  editing?: string[];
  /** A live Office file's guest has the focus: Word owns its keys (src/shared/menuState.ts `LIVE_KEY_IDS`). */
  live?: boolean;
};

const FLEET_IDS: Record<BatchAction, string> = {
  pause: "pause_all_threads",
  resume: "resume_all_threads",
  stop: "stop_all_threads",
  archiveDone: "archive_done_threads",
};

export function menuStateOf(f: MenuFacts): MenuState {
  const open: string[] = [];
  const disabled: string[] = [];
  if (f.sidebarOpen) open.push("toggle_sidebar");
  if (f.panel === "open") open.push("toggle_panel");
  if (f.panel === "none") disabled.push("toggle_panel");
  if (f.dockOpen) open.push("toggle_terminal");
  if (f.messageList) open.push("toggle_message_list");
  if (f.split) open.push("close_tab");
  if (f.today) open.push("open_today");
  if (!f.dockUsable) disabled.push("toggle_terminal");
  if (f.unread === 0) disabled.push("mark_all_read");
  if (!f.workFile) disabled.push("open_file");
  if (!f.workOn) disabled.push("open_digest");
  if (!f.print) disabled.push("print");
  if (!f.export) disabled.push("export");
  if (!f.saveWord) disabled.push("save_word");
  for (const action of Object.keys(FLEET_IDS) as BatchAction[]) {
    if (f.counts[action] === 0) disabled.push(FLEET_IDS[action]);
  }
  // Work's own rows (Go → Today) are drawn only while some host has Work on.
  return { open, disabled, checked: { toggle_away: f.away }, ...(f.editing?.length ? { editing: f.editing } : {}), ...(f.live ? { live: true } : {}), ...(f.workOn ? {} : { hidden: [...WORK_ONLY_IDS] }) };
}

const EVERYWHERE = { kind: "all" } as const;

/** The caret is in a live Office file: its `<webview>` (work/office/live/LiveLayer.tsx marks it) holds the focus. */
export function liveFocused(target: EventTarget | null | undefined): boolean {
  return !!target && typeof (target as Element).matches === "function" && (target as Element).matches("webview[data-office-live]");
}

/** The store-backed facts, read now; `caret` is where the caret is going, when a focus event knows better than the document does. */
function readFacts(dock: { dockOpen: boolean; dockUsable: boolean }, caret?: EventTarget | null): MenuFacts {
  const metas = sessionStore.metas();
  const catalog = workspaceStore.getSnapshot();
  const lastSeen = loadLastSeen();
  const floor = seenFloor();
  // A subagent's view has no panel (ThreadView), so only a root thread can show one.
  const focusedId = rightPanel.focused();
  const focused = focusedId && !sessionStore.metaOf(focusedId)?.parentId ? focusedId : null;
  const markable = new Set(threadsToMarkRead(metas, catalog, null).ids);
  const tabs = workspaceTabsStore.getState();
  const active = tabs.tabs.find((tab) => tab.id === tabs.activeTabId);
  const unread = metas.filter((m) => markable.has(m.id) && isUnread(m, lastSeen, floor)).length;
  return {
    sidebarOpen: shellStore.getState().projectRailOpen,
    panel: !focused || !rightPanel.hasRoom(focused) ? "none" : rightPanel.get(focused).open ? "open" : "closed",
    ...dock,
    messageList: !messageListFold.get(),
    split: !!active && leafIds(active.layout).length > 1,
    unread,
    counts: batchCounts(metas, { catalog, lastSeen, floor, scope: EVERYWHERE, now: Date.now() }),
    away: awayEnabled(),
    workFile: workFilePort.get()?.can() ?? false,
    workOn: workSwitch.anyOn(),
    today: shellStore.getState().workPlace === "today",
    print: workCommands.has("print"),
    export: workCommands.has("export"),
    saveWord: workCommands.has("save_word"),
    editing: caret !== undefined ? editorHeld(caret) : typeof document === "undefined" ? [] : editorHeld(document.activeElement),
    live: liveFocused(caret !== undefined ? caret : typeof document === "undefined" ? null : document.activeElement),
  };
}

/** Thread metas move many times a second while turns stream; the menu reads them at most this often. */
export const MENU_STATE_THROTTLE_MS = 250;

/** Archive Done's age rule moves with the clock alone; the facts are read again this often. */
export const MENU_STATE_CLOCK_MS = 30_000;

type Send = (state: MenuState) => void;

/** Follows every store the facts come from and sends a state only when it changed. */
export function publishMenuState(
  dock: () => { dockOpen: boolean; dockUsable: boolean },
  send: Send,
): { refresh: () => void; stop: () => void } {
  let last: MenuState = EMPTY_MENU_STATE;
  let sent = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (caret?: EventTarget | null): void => {
    timer = null;
    const next = menuStateOf(readFacts(dock(), caret));
    if (sent && sameMenuState(next, last)) return;
    last = next;
    sent = true;
    send(next);
  };
  const schedule = (): void => {
    if (timer === null) timer = setTimeout(() => flush(), MENU_STATE_THROTTLE_MS);
  };
  const offs = [
    sessionStore.onMetaChange(schedule),
    workspaceStore.subscribe(schedule),
    subscribeLastSeen(schedule),
    rightPanel.subscribe(schedule),
    shellStore.subscribe(schedule),
    workspaceTabsStore.subscribe(schedule),
    messageListFold.subscribe(schedule),
    awayStore.subscribe(schedule),
    workSwitch.subscribe(schedule),
    workCommands.subscribe(schedule),
  ];
  // The caret entering or leaving a Work editor moves four keys between the menu and the page: said at once, not after
  // the throttle. Compared with what was last sent, so a state a throttled flush sent (an editor closed under the caret)
  // is never mistaken for the one in hand. A focusout names where the caret goes: the document still says the old place
  // then, and a move inside one editor says nothing.
  const onFocus = (event: FocusEvent): void => {
    const caret = event.type === "focusout" ? event.relatedTarget : event.target;
    if (editorHeld(caret).join() === (last.editing ?? []).join()) return;
    if (timer !== null) clearTimeout(timer);
    flush(caret);
  };
  document.addEventListener("focusin", onFocus);
  document.addEventListener("focusout", onFocus);
  const clock = setInterval(schedule, MENU_STATE_CLOCK_MS);
  flush();
  return {
    refresh: schedule,
    stop: () => {
      clearInterval(clock);
      if (timer !== null) clearTimeout(timer);
      for (const off of offs) off();
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onFocus);
    },
  };
}

/** App.tsx mounts this once with the dock's facts; it renders nothing. */
export function useNativeMenuState(dock: { dockOpen: boolean; dockUsable: boolean }): void {
  const { dockOpen, dockUsable } = dock;
  useEffect(() => {
    const setState = menuStateSender();
    if (!setState) return;
    const publisher = publishMenuState(() => ({ dockOpen, dockUsable }), setState);
    return publisher.stop;
  }, [dockOpen, dockUsable]);
}
