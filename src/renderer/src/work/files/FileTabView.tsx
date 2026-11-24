import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { confirmAction, confirmChoice } from "../../chrome/ConfirmDialog";
import type { CopyBack, FileTab } from "@shared/contract-work-files";
import type { OfficeLiveOf } from "@shared/contract-work-office";
import { filesPaneOf, type CanvasItem, type CanvasKind, type ContextChip } from "@shared/work";
import { kindOfEntry } from "@shared/work/files";
import { Maximize2, Minimize2, MoreHorizontal, X } from "../../chrome/icons";
import { RowsMenu, type MenuRow } from "../../chrome/menuRows";
import { Tip, TruncateTip } from "../../components/tip";
import { Button } from "../../components/ui/button";
import { Progress } from "../../components/ui/progress";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { shortcutFor } from "../../lib/settings";
import { shell as appShell } from "../../stores/shell";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { CanvasPane } from "../canvas/CanvasPane";
import { sayError, useFrame } from "../canvas/frame";
import { ItemSkeleton } from "../canvas/ItemBones";
import type { CanvasKindDef, CanvasSelection, SavedAction, SavedLine } from "../canvas/kind";
import { keepItem } from "../canvas/fetched";
import { flushedItem } from "../canvas/flush";
import { liveLayer, STAGE_SHARE, useLiveState } from "../office/live/layer";
import { LiveBody } from "../office/live/LiveBody";
import { leaveLive } from "../office/live/leave";
import { LiveControl, useLiveOf, type LiveDesktop } from "../office/live/LiveControl";
import { APP_NAME, liveSourceOf, switchTo, type LiveSetAnswer } from "../office/live/liveSwitch";
import { Ask } from "../icons";
import { KindGlyph } from "./KindGlyph";
import { Dock, DockSash } from "./Dock";
import type { DockThread } from "./dockThread";
import { dockShape, type ActRow, type EntryAct } from "./model";
import { saveWordFile, sendCopyBack, setWordAuto, useDock, useDockWidth } from "./store";
import { askAutosave, saveAsWord, serviceOf, wordLine } from "./wordSave";
import { NameField, useSideOver } from "./rowParts";
import { copyBackDue, copyLine, isCopyBack, newestBack, type CopyAsk, type HeaderLine } from "./fileText";
import { SaveActions, SaveLine } from "./SaveLine";
import { SidePane, SideSash, sideWidth } from "./SideFile";

/**
 * A file open as itself in a Files tab (docs/DESIGN.md "The Files place"): its own header, then its kind's bar and
 * body exactly as beside a thread. The header is two lines at the left (the kind's glyph in its tint and the name;
 * under it where the file is kept, or whose copy this is) and, at the right, the file's menu and Ask. The thread
 * is never the first thing he sees, and opening a file makes none: Ask docks a chat at the file's right
 * (Dock.tsx), the thread that holds this file or a draft that becomes one only when he sends. Open to the Side puts
 * a second file at the right of the tab's own (SideFile.tsx), between the file and the dock.
 */

/** What can be done to a file from its own tab: its row's verbs, asked of the file's own host. */
export interface FileManage {
  rows: readonly ActRow[];
  run(act: EntryAct): void;
  rename(name: string): void;
  /** its bytes to this computer; absent where they cannot be read from here */
  download?(): void;
}

/** Where a copy's file lies, as its line says it. */
export interface CopyWords {
  /** the computer, as he names it: "MacBook", "the Windows VM" */
  host: string;
  /** opens the file itself on that computer; absent where it cannot be asked */
  openThere?(): void;
  /** a copy that saves back (`tab.back`): send it to its file, read the file into it again, keep his beside the file */
  send?(): Promise<unknown>;
  reload?(): Promise<void>;
  keepBoth?(): Promise<void>;
}

/**
 * The header's line for a copy that saves back: the words `copyLine` writes, with the presses its state needs (at
 * most two): Reload and Keep Both over a file that changed there, Keep Both over one that went, Retry where its
 * computer did not answer or refused. Reload drops what was not sent, so it asks first.
 */
function savingCopyLine(kind: SavedLine | null, tab: FileTab, back: CopyBack, copy: CopyWords, ask: CopyAsk, reloaded: () => void, send: () => Promise<void>): HeaderLine {
  const line = copyLine(kind, back, copy.host, Date.now(), ask);
  if (line.words === undefined) return line;
  const retry = copy.send ? [{ id: "retry", label: "Retry", run: send }] : [];
  if (ask.failed && back.is === "ok") return { ...line, actions: retry };
  const keep = copy.keepBoth ? [{ id: "keep", label: "Keep Both", run: copy.keepBoth }] : [];
  const reload = copy.reload
    ? [
        {
          id: "reload",
          label: "Reload",
          run: async () => {
            if (!(await confirmAction({ title: `Reload ${tab.name}?`, body: `Your changes that have not reached ${copy.host} are dropped.`, action: "Reload", danger: true }))) return;
            await copy.reload!();
            reloaded();
          },
        },
      ]
    : [];
  switch (back.is) {
    case "changed":
      return { ...line, actions: [...reload, ...keep] };
    case "gone":
      return { ...line, actions: keep };
    case "away":
    case "refused":
      return { ...line, actions: retry };
    default:
      return line;
  }
}

/**
 * The frame's own save line, for an item whose kind says nothing of saving: a copy of a file on another computer
 * (its changes stay here, and the file itself opens there) and a mail's file (read only until he keeps it).
 */
function frameLine(copy: CopyWords | null, item: CanvasItem | null, env: string): SavedLine | null {
  if (copy) return { state: "copy", detail: copy.host, ...(copy.openThere ? { actions: [{ id: "there", label: `Open on ${copy.host}`, run: copy.openThere }] } : {}) };
  if (item?.source.at === "mail") return { state: "readonly", detail: "a mail's file", ...(item.workspaceId ? { actions: [{ id: "keep", label: "Keep", run: () => keepItem(env, item.id).then(() => undefined) }] } : {}) };
  return null;
}

/**
 * A file's header: 48px, two lines at the left (the kind's glyph in its tint and the name; under it the save
 * line, or where the file is kept while its kind says nothing of saving), then the line's presses, the file's
 * menu and Ask.
 */
export function FileHeader({
  name,
  line,
  where,
  running,
  onRun,
  onShowFolder,
  rows,
  onPick,
  rename,
  ask,
  leave,
  note,
  progress,
  end,
}: {
  name: string;
  line: SavedLine | null;
  where: string | null;
  /** the id of the line's press that is under way */
  running: string | null;
  onRun(action: SavedAction): void;
  onShowFolder?(): void;
  rows: MenuRow[];
  onPick(id: string): void;
  /** the name is a press that renames it in place; absent where the file cannot be renamed here */
  rename?: { on: boolean; start(): void; done(next: string | null): void };
  /** Ask is a toggle: it opens the chat beside the file, and closes it */
  ask: { disabled: boolean; pressed: boolean; run(): void };
  /** in the full window: the way back, and room at the header's start for the window's own controls */
  leave?(): void;
  /** the frame's own words in the line's place while something is under way ("Opening in Word…") */
  note?: string | null;
  /** a load the frame can measure: a 4px bar along the header's foot, in place of its rule */
  progress?: number | null;
  /** a control before ⋯ (a shared Office file's Edit here or Live) */
  end?: ReactNode;
}) {
  return (
    <header data-files-header className={`relative flex h-12 shrink-0 items-center gap-2.5 border-b border-border pe-2 ${leave ? "ps-20" : "ps-3"}`}>
      <KindGlyph kind={kindOfEntry(name).kind} />
      <div className="flex min-w-0 flex-1 flex-col">
        {rename?.on ? (
          <NameField name={name} className="h-5 flex-none text-sm font-semibold" onDone={rename.done} />
        ) : (
          <TruncateTip text={name}>
            {rename ? (
              <h2 className="min-w-0 truncate text-sm leading-5 font-semibold text-foreground">
                <Button variant="link" data-files-rename-name className="h-5 max-w-full min-w-0 justify-start rounded-sm p-0 text-sm leading-5 font-semibold hover:no-underline" onClick={rename.start}>
                  <span className="truncate">{name}</span>
                </Button>
              </h2>
            ) : (
              <h2 className="min-w-0 truncate text-sm leading-5 font-semibold text-foreground">{name}</h2>
            )}
          </TruncateTip>
        )}
        {note ? (
          <p className="min-w-0 truncate text-xs leading-4 text-muted-foreground">{note}</p>
        ) : line ? (
          <SaveLine line={line} where={where} onShowFolder={onShowFolder} />
        ) : where ? (
          <p className="min-w-0 truncate text-xs leading-4 text-muted-foreground">In {where}</p>
        ) : null}
      </div>
      {line?.actions?.length && !note ? <SaveActions actions={line.actions} busy={running} onRun={onRun} /> : null}
      {end}
      <RowsMenu
        label="File"
        align="end"
        rows={rows}
        onPick={onPick}
        tip={{ label: "More" }}
        trigger={
          <Button variant="ghost" size="icon-sm" aria-label={`More for ${name}`} className="shrink-0 text-muted-foreground">
            <MoreHorizontal />
          </Button>
        }
      />
      {leave ? (
        <Tip label="Leave Full Window" shortcut={shortcutFor("Files (Work)", "Leave Full Window")}>
          <Button variant="ghost" size="icon-sm" aria-label="Leave Full Window" className="shrink-0 text-muted-foreground" onClick={leave}>
            <Minimize2 />
          </Button>
        </Tip>
      ) : null}
      {/* A pressed toggle is `muted` and flat: the raised button's own layer would hide a fill under it. */}
      <Button variant={ask.pressed ? "ghost" : "secondary"} size="sm" className="shrink-0 aria-pressed:bg-muted" aria-pressed={ask.pressed} disabled={ask.disabled} onClick={ask.run}>
        <Ask />
        Ask
      </Button>
      {progress != null ? <Progress aria-label={note ?? "Loading"} value={progress} className="absolute inset-x-0 -bottom-px gap-0 [&_[data-slot=progress-track]]:rounded-none" /> : null}
    </header>
  );
}

export function FileTabView({
  tab,
  item,
  panelId,
  workspace,
  where,
  copy,
  manage,
  sideItem = null,
  onCloseSide,
  onClose,
  onShowFolder,
  kinds,
  dockPreset,
  desktopsOf,
}: {
  tab: FileTab;
  /** the tab's item; null until the pane's list has come */
  item: CanvasItem | null;
  panelId: string;
  workspace: Pick<WorkspaceMeta, "id" | "environmentId" | "path">;
  /** the folder the file is kept in, as the trail names it */
  where: string | null;
  /** the tab shows a copy of a file on another computer */
  copy: CopyWords | null;
  /** the verbs for the file, as its row's menu has them (`actsFor`); absent where nothing here changes it */
  manage?: FileManage;
  /** the item of the file at the tab's side (`tab.side`); null until the pane's list has come */
  sideItem?: CanvasItem | null;
  /** closes the file at the side alone */
  onCloseSide?(): void;
  onClose(): void;
  /** shows the folder the file is kept in, in a page tab */
  onShowFolder?(): void;
  /** a preview's kinds and docked thread (Dock.preview.tsx); the app passes neither */
  kinds?: Record<CanvasKind, CanvasKindDef>;
  dockPreset?: DockThread;
  /** the computers whose desktop app opens a shared Office file, from the host's answer, as he names them */
  desktopsOf?(of: OfficeLiveOf): LiveDesktop[];
}) {
  const owner = filesPaneOf(workspace.id);
  const [docked, setDocked] = useDock(workspace.id, tab.id);
  // What a selection's (or a kind's own) Ask hands the dock, until its thread is known and the chip is in.
  const [chip, setChip] = useState<ContextChip | null>(null);
  const takeChip = useCallback(() => setChip(null), []);
  // The composer takes the caret when he opens the dock, never when the window brings it back open.
  const [focus, setFocus] = useState(false);
  const ask = (): void => {
    if (!item) return;
    setFocus(!docked);
    setDocked(!docked);
  };
  const askWith = (next: ContextChip): void => {
    setFocus(true);
    setChip(next);
    setDocked(true);
  };
  const { feeds, shell } = useFrame(workspace.environmentId, owner, item, askWith);
  const body = useRef<HTMLDivElement>(null);
  const room = useWidth(body);
  const [kept, keep] = useDockWidth();
  const [dragged, setDragged] = useState<number | null>(null);
  const shape = dockShape(room, dragged ?? kept);
  // A second file at the side shares what the dock leaves, half each to start; with no room for two it lies over the tab's own.
  const [sideKept, setSideKept] = useState<number | null>(null);
  const filesRoom = room - (docked && !shape.over ? shape.width + 1 : 0);
  const sideW = tab.side ? sideWidth(filesRoom, sideKept) : 0;
  const sideOver = !!tab.side && sideW === 0 && room > 0;
  const dropSide = useSideOver() === tab.id;
  const name = tab.name || item?.title || "File";
  // Reload read the file into the copy: the kind draws it again from the start.
  const [fresh, setFresh] = useState(0);
  // What saved means: the kind's own word where it says one; else the frame's, for a copy and a mail's file. A copy's
  // kind saves into the copy: for one that saves back the line says where its file stands; for one that does not,
  // its saving and saved say nothing of the file, and the frame's line says the changes stay here.
  const kindLine = feeds.saved;
  // His window's own ask for a send: under way until the host answers, or refused in the host's words.
  // With the host's answer to it, which may know of a write of the copy the tab's own word does not yet.
  const [sendAsk, setSendAsk] = useState<CopyAsk & { got?: CopyBack }>({});
  const copySend = copy?.send;
  const sendBack = useCallback(
    async (base?: number): Promise<void> => {
      setSendAsk({ owed: true, base });
      try {
        // The copy's own send where the frame gives one (FilesView: the same ask on the workspace's link).
        const got = await (copySend ? copySend() : sendCopyBack(workspace.environmentId, workspace.id, tab.id));
        setSendAsk({ base, ...(isCopyBack(got) ? { got } : {}) });
      } catch (err: unknown) {
        setSendAsk({ failed: err instanceof Error ? err.message : String(err) });
      }
    },
    [copySend, workspace.environmentId, workspace.id, tab.id],
  );
  const back = tab.back ? newestBack(tab.back, sendAsk.got) : undefined;
  // A Word file opened as its document: whether the Word file holds his changes, and Save as Word (wordSave.ts).
  const saveWord = (): Promise<void> =>
    saveAsWord(tab, {
      choose: confirmChoice,
      confirm: confirmAction,
      save: (keep, replace) => saveWordFile(workspace.environmentId, workspace.id, tab.id, keep, replace),
      said: (text) => void loadToast().then((toast) => toast.message(text)),
    }).then(() => undefined);
  // The first time a Word file holds edits not in it: one notice, and his choice for the file (wordSave.ts).
  const asked = useRef(false);
  const word = tab.word;
  useEffect(() => {
    if (!copy || !word || word.auto !== undefined || !word.since || asked.current) return;
    asked.current = true;
    void askAutosave(tab, { choose: confirmChoice, set: (on) => setWordAuto(workspace.environmentId, workspace.id, tab.id, on) }).catch((err: unknown) => sayError(err, "The choice was not kept"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copy, word?.auto, word?.since]);
  const wordActions = (w: NonNullable<typeof word>): SavedAction[] => {
    const service = serviceOf(tab);
    const save = (keep: boolean, replace = false): Promise<void> => saveWordFile(workspace.environmentId, workspace.id, tab.id, keep, replace).then(() => undefined);
    if (w.stopped) return [{ id: "keep", label: "Keep Both", run: () => save(true) }, { id: "replace", label: "Replace", run: () => save(false, true) }];
    return w.auto || !w.since ? [] : [{ id: "word", label: `Save to ${service} as Word`, run: saveWord }];
  };
  const line: HeaderLine | null =
    copy && word && (!kindLine || kindLine.state === "saved" || kindLine.state === "saving")
      ? { ...wordLine(word, serviceOf(tab)), ...(wordActions(word).length ? { actions: wordActions(word) } : {}) }
      : copy && back
      ? savingCopyLine(kindLine, tab, back, copy, sendAsk, () => setFresh((n) => n + 1), () => sendBack())
      : copy
        ? kindLine && kindLine.state !== "saved" && kindLine.state !== "saving"
          ? kindLine
          : frameLine(copy, item, workspace.environmentId)
        : (kindLine ?? frameLine(null, item, workspace.environmentId));
  // Once a copy's kind has saved, the host sends the copy to its file (one send at a time there, the newest bytes).
  const saving = !!(copy && tab.back);
  const lastLine = useRef<SavedLine | null>(null);
  // The copy's writes as known when the kind began saving: the send it asks for must hold a write made after them.
  const baseRef = useRef<number | undefined>(undefined);
  const knownWrites = back?.writes;
  useEffect(() => {
    const was = lastLine.current;
    lastLine.current = kindLine;
    if (kindLine?.state === "saving" && was?.state !== "saving") baseRef.current = knownWrites;
    if (!saving || !copyBackDue(was, kindLine)) return;
    const base = was?.state === "saving" ? baseRef.current : undefined;
    baseRef.current = undefined;
    void sendBack(base);
  }, [kindLine, saving, sendBack, knownWrites]);
  const [running, setRunning] = useState<string | null>(null);
  const runAction = (action: SavedAction): void => {
    if (running) return;
    setRunning(action.id);
    void Promise.resolve()
      .then(() => action.run())
      .catch((err: unknown) => sayError(err, `${action.label} did not work`))
      .finally(() => setRunning(null));
  };
  // Full window: the file fills the app's window, the rail and the tabs gone; Escape returns.
  const [full, setFull] = useState(false);
  // The file's menu: the verbs its row has, less Open (it is open), then Download, Full Window and Close Tab.
  const verbs = (manage?.rows ?? []).filter((row) => row.act !== "open" && row.act !== "open-tab");
  const rows: MenuRow[] = [
    ...verbs.flatMap((row): MenuRow[] => [
      ...(row.rule ? ([{ kind: "sep" }] satisfies MenuRow[]) : []),
      { kind: "item", id: row.act, label: row.label, ...(row.refused ? { disabled: true, reason: row.refused } : {}), ...(row.danger ? { danger: true } : {}) },
    ]),
    ...(manage?.download ? ([{ kind: "sep" }, { kind: "item", id: "download", label: "Download" }] satisfies MenuRow[]) : []),
    { kind: "sep" },
    { kind: "item", id: "full", label: full ? "Leave Full Window" : "Full Window", icon: full ? Minimize2 : Maximize2 },
    { kind: "item", id: "close", label: "Close Tab", icon: X, shortcut: shortcutFor("Files (Work)", "Close Tab") },
    // A Word file's own choice: save it by itself, or ask each time.
    ...(copy && tab.word ? ([{ kind: "sep" }, { kind: "item", id: "word-auto", label: tab.word.auto ? "Ask Before Saving to Word" : "Save to Word Automatically" }] satisfies MenuRow[]) : []),
  ];
  // A shared Office file opens here or live in Office on the web (docs/agents/work-office-live.md): the header's control
  // switches it, the line says how far Word has come, and the body is the guest's place (LiveBody).
  const live = liveSourceOf(item);
  const liveState = useLiveState(live && item ? item.id : null);
  const link = workspace.environmentId;
  // Only the four forms Office for the web edits are asked about (the host's `LIVE_FORMS`).
  const offersLive = /\.(docx|xlsx|xlsm|pptx)$/i.test(tab.name) || !!live;
  const liveOf = useLiveOf(() => registry.linkOf(link).request<OfficeLiveOf>("work.office.live.of", { workspaceId: workspace.id, tabId: tab.id }), offersLive ? (item?.id ?? null) : null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);
  const runSwitch = (to: "here" | "live"): void => {
    if (switchBusy || !item) return;
    setSwitchBusy(true);
    void switchTo(
      to,
      { name, service: serviceOf(tab), sending: !!(copy && tab.back) },
      {
        set: (params) => registry.linkOf(link).request<LiveSetAnswer>("work.office.live.set", { workspaceId: workspace.id, tabId: tab.id, ...params }, { timeoutMs: 120_000, lane: "ui" }),
        flush: () => flushedItem(item.id),
        leave: () => leaveLive(item.id, name),
        typed: () => liveLayer.typed(item.id),
        confirm: confirmAction,
        saveWord: () =>
          saveAsWord(tab, {
            choose: confirmChoice,
            confirm: confirmAction,
            save: (keep) => saveWordFile(link, workspace.id, tab.id, keep),
            said: (text) => void loadToast().then((toast) => toast.message(text)),
          }).then((done) => done === "saved"),
        busy: setSwitching,
      },
    )
      .catch((err: unknown) => sayError(err, "The file did not switch"))
      .finally(() => setSwitchBusy(false));
  };
  const liveNote = live && liveState ? (liveState.site ? `Signing in at ${liveState.site}` : liveState.stage !== "ready" && !liveState.failed ? `Opening in ${APP_NAME[live.app]}…` : null) : null;
  const note = switching ?? liveNote;
  const liveProgress = live && liveState && liveState.stage !== "ready" && !liveState.failed ? STAGE_SHARE[liveState.stage] : null;
  const [renaming, setRenaming] = useState(false);
  // Escape leaves the full window, unless a menu, a dialog or the thing holding the key took it first.
  useEffect(() => {
    if (!full) return;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || (event.target as HTMLElement | null)?.closest?.('[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]')) return;
      setFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);
  const canRename = !!manage && verbs.some((row) => row.act === "rename" && !row.refused);
  return (
    <div
      role="tabpanel"
      id={panelId}
      data-files-file
      data-files-full={full || undefined}
      className={full ? "fixed inset-0 z-(--layer-dialog) flex min-h-0 min-w-0 flex-col bg-background" : "flex min-h-0 min-w-0 flex-1 flex-col bg-background"}
    >
      <FileHeader
        name={name}
        line={line}
        where={where}
        running={running}
        onRun={runAction}
        onShowFolder={onShowFolder}
        rows={rows}
        onPick={(id) => {
          if (id === "close") return onClose();
          if (id === "word-auto") return void setWordAuto(workspace.environmentId, workspace.id, tab.id, !tab.word?.auto).catch((err: unknown) => sayError(err, "The choice was not kept"));
          if (id === "full") return setFull(!full);
          if (id === "download") return manage?.download?.();
          if (id === "rename") return setRenaming(true);
          manage?.run(id as EntryAct);
        }}
        {...(canRename
          ? {
              rename: {
                on: renaming,
                start: () => setRenaming(true),
                done: (next) => {
                  setRenaming(false);
                  if (next !== null) manage!.rename(next);
                },
              },
            }
          : {})}
        ask={{ disabled: !item, pressed: docked, run: ask }}
        {...(full ? { leave: () => setFull(false) } : {})}
        note={note}
        progress={liveProgress}
        end={
          offersLive && registry.has(link) ? (
            <LiveControl
              inTab={liveLayer.can()}
              of={liveOf}
              live={!!live}
              busy={switchBusy}
              desktops={liveOf && desktopsOf ? desktopsOf(liveOf) : []}
              onSwitch={runSwitch}
              onNoAddress={(why) =>
                void loadToast().then((toast) => toast.message(why, { action: { label: "Open Settings", onClick: () => appShell.openSettings("work") } }))
              }
            />
          ) : null
        }
      />
      <div ref={body} data-files-body className="relative flex min-h-0 min-w-0 flex-1">
        {/* Under the chat that lies over it, the file takes no focus. */}
        <div inert={(docked && shape.over) || sideOver || undefined} className="flex min-h-0 min-w-0 flex-1 flex-col">
          {item && live ? (
            <LiveBody itemId={item.id} url={live.url} app={live.app} covered={(docked && shape.over) || sideOver || dropSide} full={full} />
          ) : item ? (
            <CanvasPane
              key={`${item.id}:${fresh}`}
              item={item}
              environmentId={workspace.environmentId}
              feeds={feeds}
              shell={shell}
              {...(kinds ? { kinds } : {})}
              onAsk={(selection: CanvasSelection) => {
                shell.selection(null);
                window.getSelection()?.removeAllRanges();
                askWith(selection.chip);
              }}
            />
          ) : (
            <ItemSkeleton />
          )}
        </div>
        {/* A tab dragged down onto the right half goes to the side: the half takes the fill until the drop. */}
        {dropSide ? <div data-files-side-drop aria-hidden className="pointer-events-none absolute inset-y-0 end-0 z-30 w-1/2 bg-muted/80" /> : null}
        {tab.side ? (
          sideOver ? (
            <div inert={(docked && shape.over) || undefined} className="absolute inset-0 z-10 flex">
              <SidePane workspace={workspace} side={tab.side} item={sideItem} width={0} onClose={() => onCloseSide?.()} onAsk={(selection) => askWith(selection.chip)} {...(kinds ? { kinds } : {})} />
            </div>
          ) : (
            <>
              <SideSash width={sideW} body={filesRoom} onWidth={setSideKept} />
              <SidePane workspace={workspace} side={tab.side} item={sideItem} width={sideW} onClose={() => onCloseSide?.()} onAsk={(selection) => askWith(selection.chip)} {...(kinds ? { kinds } : {})} />
            </>
          )
        ) : null}
        {docked && !shape.over ? (
          <DockSash
            width={shape.width}
            body={room}
            onWidth={(width, done) => {
              if (!done) return setDragged(width);
              setDragged(null);
              keep(width);
            }}
          />
        ) : null}
        {docked ? (
          <div data-files-dock-seat={shape.over ? "over" : "beside"} className={shape.over ? "absolute inset-0 z-20 flex" : "flex shrink-0"} style={shape.over ? undefined : { width: shape.width }}>
            <Dock key={tab.id} workspace={workspace} tab={tab} item={item} chip={chip} focus={focus} preset={dockPreset} onChipTaken={takeChip} onClose={() => setDocked(false)} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** An element's width, kept as it changes; 0 until measured. */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = (): void => setWidth(el.clientWidth);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, [ref]);
  return width;
}
