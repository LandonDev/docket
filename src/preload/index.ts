import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
// Mirrors the main-process asset URL builder so the renderer can turn a
// logo path into a URL without a round trip.
import { logoAssetUrl } from '../shared/assets'
import type { LaunchMirrorSnapshot, MirrorWrite } from '../shared/launchMirror'
import { aliaxApi } from './aliax'
import type { RevealNavigation } from '@shared/contract-work-reveal'
import type { EditorChoice, EditorConfig, EditorId, EditorTarget } from '../shared/editor'
import type { ShowAsk, ShowDisplay, ShowFrames } from '../shared/slidesShow'
import type { LiveTicketAsk } from '../shared/work/officeLive'
import type { CodeUpdateStatus } from '../shared/codeUpdate'
import type { Draft, DraftKey } from '../shared/work/drafts'

type DialogKind = 'info' | 'warning' | 'error'

interface OpenOptions {
  title?: string
  defaultPath?: string
  multiple?: boolean
  directory?: boolean
  filters?: { name: string; extensions: string[] }[]
}

interface AskOptions {
  title?: string
  kind?: DialogKind
  okLabel?: string
  cancelLabel?: string
}

interface MessageOptions {
  title?: string
  kind?: DialogKind
}

interface DraftsApi {
  put(draft: Draft): void
  drop(key: DraftKey): void
  release(key: DraftKey): void
  list(key: Omit<DraftKey, 'base'>): Promise<Draft[]>
}

interface PtySpawnArgs {
  id: string
  cwd: string
  cols: number
  rows: number
}

/** Subscribes to an IPC channel and hands back the unsubscribe. */
function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: unknown, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

interface UpdateStatus {
  current: string
  latest: string | null
  notes: string
  canApply: boolean
  checked: boolean
  phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'error'
  percent?: number
  error?: string
  /** A release this app handed to Squirrel's installer that did not land. */
  installFailure?: { version: string; reason: string }
  /** Code-only updates: the staged code that runs, one on its way or waiting for the restart, a line to say once. */
  code?: CodeUpdateStatus
}

interface AppshotAttachment {
  path: string
  name: string
  mime?: string
  kind: 'appshot'
  textPath?: string
}

interface CaptureKeyState {
  key: string | null
  defaultKey: string
  held: boolean
  error: string | null
  workOn: boolean
}

interface AppshotPermissions {
  available: boolean
  screen: boolean
  ax: boolean
}

const api = {
  /** This machine's `process.platform`, for its host glyph before the local hello. */
  platform: process.platform as string,
  getServerPort: (): Promise<number | null> => ipcRenderer.invoke('server-port'),
  /** Print… (src/main/printOut.ts): a PDF's bytes to the system's print dialog (macOS) or this computer's own PDF viewer. */
  printPdf: (name: string, bytes: Uint8Array): Promise<{ ok: true; via: 'dialog' | 'viewer'; refused?: true } | { ok: false; error: string }> => ipcRenderer.invoke('print:pdf', name, bytes),
  /** The capture key (src/main/capture.ts): the one set, the default, and whether it is held; `set(null)` turns it off. */
  captureKey: {
    get: (): Promise<CaptureKeyState> => ipcRenderer.invoke('capture:key:get'),
    set: (key: string | null): Promise<CaptureKeyState> => ipcRenderer.invoke('capture:key:set', key)
  },
  /** The launch mirror (src/shared/launchMirror.ts): what every host last
   *  showed, read synchronously so the rail paints before any socket is up;
   *  writes are fire-and-forget, coalesced by the renderer. */
  launchMirror: {
    read: (): LaunchMirrorSnapshot | null =>
      (ipcRenderer.sendSync('launch-mirror:read') as LaunchMirrorSnapshot | null) ?? null,
    write: (write: MirrorWrite): void => ipcRenderer.send('launch-mirror:write', write)
  },
  /** His unacknowledged edits, kept by this computer's main process (src/main/drafts.ts); writes are fire-and-forget. Absent in a browser, which keeps none. */
  drafts: {
    put: (draft: Draft): void => ipcRenderer.send('drafts:put', draft),
    drop: (key: DraftKey): void => ipcRenderer.send('drafts:drop', key),
    release: (key: DraftKey): void => ipcRenderer.send('drafts:release', key),
    list: (key: Omit<DraftKey, 'base'>): Promise<Draft[]> => ipcRenderer.invoke('drafts:list', key)
  } as DraftsApi | undefined,
  appshots: {
    /** Mounts the capture listener and flushes any queued captures. */
    onCapture: (cb: (a: AppshotAttachment) => void): (() => void) => {
      const listener = (_e: unknown, a: AppshotAttachment): void => cb(a)
      ipcRenderer.on('appshot', listener)
      ipcRenderer.send('appshot-ready')
      return () => ipcRenderer.removeListener('appshot', listener)
    },
    onError: (cb: (e: { code: string }) => void): (() => void) => {
      const listener = (_e: unknown, err: { code: string }): void => cb(err)
      ipcRenderer.on('appshot-error', listener)
      return () => ipcRenderer.removeListener('appshot-error', listener)
    },
    permissions: (prompt?: boolean): Promise<AppshotPermissions> =>
      ipcRenderer.invoke('appshot-permissions', prompt)
  },
  updates: {
    get: (): Promise<UpdateStatus> => ipcRenderer.invoke('update-get'),
    check: (): Promise<UpdateStatus> => ipcRenderer.invoke('update-check'),
    apply: (): Promise<UpdateStatus> => ipcRenderer.invoke('update-apply'),
    onStatus: (cb: (s: UpdateStatus) => void): (() => void) => {
      const listener = (_e: unknown, s: UpdateStatus): void => cb(s)
      ipcRenderer.on('update-status', listener)
      return () => ipcRenderer.removeListener('update-status', listener)
    }
  },
  pickDirectory: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('pick-directory', defaultPath),
  revealInFinder: (path: string): Promise<void> => ipcRenderer.invoke('reveal-in-finder', path),
  /** Files dragged out to the desktop (src/main/dragOut.ts): true once the system carries them. It answers when the drag ends on Windows and Linux, at once on a Mac. */
  dragFilesOut: (paths: string[]): Promise<boolean> => ipcRenderer.invoke('drag-files-out', paths),
  /** The user's editor (src/main/editorLaunch.ts): IDEA, VS Code or Xcode on this machine. */
  editor: {
    /** Null where no editor can run (a box with no display). */
    config: (): Promise<EditorConfig | null> => ipcRenderer.invoke('editor-config'),
    setChoice: (choice: EditorChoice): Promise<void> => ipcRenderer.invoke('editor-set', choice),
    /** Resolves to the editor used; rejects when none is installed. */
    open: (target: EditorTarget): Promise<{ editor: EditorId }> => ipcRenderer.invoke('editor-open', target)
  },
  /** Real disk path of a dropped File (File.path is gone in Electron ≥32). */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  pty: {
    /** Resolves to the requested directory when it was missing and the
     *  shell fell back to $HOME, else null. */
    spawn: (args: PtySpawnArgs): Promise<string | null> => ipcRenderer.invoke('pty-spawn', args),
    write: (id: string, data: string): Promise<void> => ipcRenderer.invoke('pty-write', id, data),
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke('pty-resize', id, cols, rows),
    status: (id: string): Promise<{ foreground: string | null }> =>
      ipcRenderer.invoke('pty-status', id),
    kill: (id: string): Promise<void> => ipcRenderer.invoke('pty-kill', id),
    killAll: (): Promise<void> => ipcRenderer.invoke('pty-kill-all'),
    /** Pay back the bytes xterm has written, so main can unpause the shell. */
    ack: (id: string, bytes: number): void => ipcRenderer.send('pty-ack', id, bytes),
    onData: (cb: (id: string, data: Uint8Array) => void): (() => void) =>
      on<[string, Uint8Array]>('pty-data', (id, data) => cb(id, new Uint8Array(data))),
    onExit: (cb: (id: string, code: number | null) => void): (() => void) =>
      on<[string, number | null]>('pty-exit', cb)
  },

  win: {
    /** This window's slot: names its bounds and its workspace snapshot. */
    slot: process.argv.find((a) => a.startsWith('--tc-window-slot='))?.slice(17) ?? 'main',
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    /** This window's pop-out keeps a picture of this width over height, with its bar under it. */
    /** This window, or its pop-out, over its whole display or back (main's fullScreen.ts); answers whether it was full before. */
    fullScreen: (ask: { on: boolean; popOut?: boolean }): Promise<boolean> => ipcRenderer.invoke('window:fullScreen', ask),
    /** This window's full screen, or its pop-out's, as it changes. */
    onFullScreen: (cb: (state: { on: boolean; popOut: boolean }) => void): (() => void) =>
      on<[{ on: boolean; popOut: boolean }]>('window:fullScreenChanged', cb),
    /** This window's picture holds the keyboard in full screen, or no longer does (main's keyboardHold.ts); answers whether main holds it. */
    keyboardHold: (on: boolean): Promise<boolean> => ipcRenderer.invoke('window:keyboardHold', on),
    /** What main says while it holds the keyboard: it let go, or ⌘Q was pressed (Alt+F4 for the picture). */
    onHeldKey: (cb: (key: 'freed' | 'closeWindow') => void): (() => void) => on<['freed' | 'closeWindow']>('window:heldKey', cb),
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke('window:toggle-maximize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
    isFocused: (): Promise<boolean> => ipcRenderer.invoke('window:is-focused'),
    setTitle: (title: string): Promise<void> => ipcRenderer.invoke('window:set-title', title),
    /** The theme this window wears and the kind of place it is on; main keeps them with the window's bounds. */
    setAppearance: (appearance: { scheme: 'dark' | 'light'; kind: 'code' | 'work' }): void =>
      ipcRenderer.send('appearance:scheme', appearance),
    hide: (): Promise<void> => ipcRenderer.invoke('window:hide'),
    destroy: (): Promise<void> => ipcRenderer.invoke('window:destroy'),
    create: (): Promise<void> => ipcRenderer.invoke('window:new'),
    stageTransfer: (payload: unknown): Promise<void> =>
      ipcRenderer.invoke('window:stage-transfer', payload),
    takeTransfer: <T>(): Promise<T | null> => ipcRenderer.invoke('window:take-transfer'),
    setButtonsVisible: (visible: boolean): Promise<void> =>
      ipcRenderer.invoke('window:buttons-visible', visible),
    setZoom: (factor: number): Promise<void> => ipcRenderer.invoke('window:set-zoom', factor),
    onResized: (cb: () => void): (() => void) => on('window:resized', cb),
    /** Subscribing makes main defer the close to you: answer with hide() or
     *  destroy(). Without a subscriber the window closes by itself. */
    onCloseRequested: (cb: () => void): (() => void) => {
      ipcRenderer.send('window:close-subscribe')
      return on('window:close-requested', cb)
    },
    /** Quit was confirmed in another window; write your snapshot now and
     *  call persisted() so the exit can go on. */
    onPersistRequested: (cb: () => void): (() => void) => on('window:persist-requested', cb),
    persisted: (): void => ipcRenderer.send('window:persisted')
  },

  menu: {
    onCommand: (cb: (id: string) => void): (() => void) =>
      on<[string]>('native:menu', (id) => cb(id)),
    /** What this window shows: main relabels the toggles and greys the idle rows. */
    setState: (state: { open: string[]; disabled: string[]; editing?: string[] }): void => ipcRenderer.send('menu:state', state)
  },

  dialog: {
    open: (options?: OpenOptions): Promise<string | string[] | null> =>
      ipcRenderer.invoke('dialog:open', options ?? {}),
    ask: (text: string, options?: AskOptions): Promise<boolean> =>
      ipcRenderer.invoke('dialog:ask', text, options ?? {}),
    message: (text: string, options?: MessageOptions): Promise<void> =>
      ipcRenderer.invoke('dialog:message', text, options ?? {})
  },

  app: {
    version: (): Promise<string> => ipcRenderer.invoke('app:version'),
    homeDir: (): Promise<string> => ipcRenderer.invoke('app:home-dir'),
    defaultCwd: (): Promise<string> => ipcRenderer.invoke('app:default-cwd'),
    openUrl: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-url', url),
    /** The box's full editor, carried on a loopback origin of this app's own, in a window with a session of its own (src/main/fullEditorCarry.ts). */
    openFullEditor: (address: string): Promise<void> => ipcRenderer.invoke('full-editor:open', address),
    /** Writes bytes the window holds into Downloads under a safe, free name; answers the path. */
    saveDownload: (name: string, bytes: Uint8Array): Promise<string> => ipcRenderer.invoke('files:save-download', name, bytes),
    dockBadge: (count: number): Promise<void> => ipcRenderer.invoke('app:dock-badge', count),
    /** Main's navigation-only request for this window. */
    onReveal: (prepare: (token: string) => void, open: (token: string, navigation: RevealNavigation) => void, cancel: (token: string) => void): (() => void) => {
      const arm = (_e: unknown, token: string): void => {
        prepare(token)
        ipcRenderer.send('app:reveal-prepared', token)
      }
      const navigate = (_e: unknown, token: string, navigation: RevealNavigation): void => open(token, navigation)
      const cancelled = (_e: unknown, token: string): void => cancel(token)
      ipcRenderer.on('app:reveal-prepare', arm)
      ipcRenderer.on('app:reveal-open', navigate)
      ipcRenderer.on('app:reveal-cancel', cancelled)
      ipcRenderer.send('app:reveal-ready')
      return () => {
        ipcRenderer.removeListener('app:reveal-prepare', arm)
        ipcRenderer.removeListener('app:reveal-open', navigate)
        ipcRenderer.removeListener('app:reveal-cancel', cancelled)
      }
    },
    /** A system notification while no window is in front, once per key (src/main/notice.ts); `onOpen` hears the key of the one he clicked. */
    notice: {
      show: (ask: { key: string; title: string; body: string; silent?: boolean; telling?: string }): Promise<void> => ipcRenderer.invoke('app:notice', ask),
      close: (key: string): Promise<void> => ipcRenderer.invoke('app:notice-close', key),
      onOpen: (cb: (key: string) => void): (() => void) => {
        const listener = (_e: unknown, key: string): void => cb(key)
        ipcRenderer.on('app:notice-open', listener)
        return () => void ipcRenderer.removeListener('app:notice-open', listener)
      }
    },
    confirmQuit: (): Promise<void> => ipcRenderer.invoke('app:confirm-quit'),
    /** The user said no to the quit dialog; a restart armed behind it is dropped. */
    declineQuit: (): void => ipcRenderer.send('app:quit-declined'),
    /** Subscribing makes main ask you before it exits. */
    onQuitRequested: (cb: () => void): (() => void) => {
      ipcRenderer.send('app:quit-subscribe')
      return on('app:quit-requested', cb)
    },
    logoUrl: (absolutePath: string): string => logoAssetUrl(absolutePath),
    /** Whether the person is at this machine: unlocked, awake, input in the last two minutes. */
    attention: (): Promise<boolean> => ipcRenderer.invoke('app:attention'),
    onAttention: (cb: (present: boolean) => void): (() => void) => on('app:attention', cb)
  },

  /** Dev builds only; the handlers are not registered in a packaged app. */
  debug: {
    menuClick: (id: string): Promise<boolean> => ipcRenderer.invoke('debug:menu-click', id),
    dockBadge: (): Promise<string | null> => ipcRenderer.invoke('debug:dock-badge'),
    windowTitle: (): Promise<string | undefined> => ipcRenderer.invoke('debug:window-title'),
    ptyFlow: (): Promise<{ pauses: number; resumes: number }> =>
      ipcRenderer.invoke('debug:pty-flow'),
    nextPick: (paths: string[]): Promise<void> => ipcRenderer.invoke('debug:next-pick', paths),
    assetFetch: (url: string): Promise<{ status: number; body: string }> =>
      ipcRenderer.invoke('debug:asset-fetch', url),
    windows: (): Promise<unknown[]> => ipcRenderer.invoke('debug:windows'),
    ptys: (): Promise<unknown[]> => ipcRenderer.invoke('debug:ptys'),
    aliaxCalls: (): Promise<Record<string, number>> => ipcRenderer.invoke('debug:aliax-calls'),
    appshot: (): Promise<number | null> => ipcRenderer.invoke('debug:appshot')
  }
}

export type TempCodeApi = typeof api

/**
 * A show's windows (src/main/present.ts), under a name of its own: the slides canvas reads it in its own chunk, so
 * the app's first paint and the browser's stand-in (nativeWeb.ts) carry nothing of it.
 */
const show = {
  displays: (): Promise<ShowDisplay[]> => ipcRenderer.invoke('show:displays'),
  /** Asks for a show; answers the frame name to open each of its windows under (null: no such window this time). */
  begin: (ask: ShowAsk): Promise<ShowFrames> => ipcRenderer.invoke('show:begin', ask),
  end: (): Promise<void> => ipcRenderer.invoke('show:end'),
  onDisplayGone: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('show:display-gone', listener)
    return () => void ipcRenderer.removeListener('show:display-gone', listener)
  }
}
export type ShowApi = typeof show

/**
 * A live Office file's or Microsoft form's guest (src/main/officeLive.ts): the ticket its `<webview>` attaches on,
 * asked by this page alone, with a file's web address or `{forms: {tenant, formId, page}}` (main makes a form's address).
 */
const live = {
  ticket: (ask: LiveTicketAsk): Promise<{ ok: true; src: string; partition: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('office-live:ticket', ask),
  /** Escape is TempCode's while the tab fills the window (main's `forwardedKey`). */
  fullWindow: (guestId: number, on: boolean): Promise<void> => ipcRenderer.invoke('office-live:full-window', guestId, on),
  typed: (guestId: number): Promise<number> => ipcRenderer.invoke('office-live:typed', guestId),
  /** ms since his last key in the file, null before he typed. */
  quiet: (guestId: number): Promise<number | null> => ipcRenderer.invoke('office-live:quiet', guestId),
  /** Leaves the file: 'holding' while Word is still saving, until `force`. */
  unload: (guestId: number, force: boolean): Promise<'unloaded' | 'holding' | 'gone'> => ipcRenderer.invoke('office-live:unload', guestId, force),
  /** A key of TempCode's pressed in the guest, played to this page. */
  onKey: (cb: (init: KeyboardEventInit) => void): (() => void) => {
    const listener = (_e: unknown, init: KeyboardEventInit): void => cb(init)
    ipcRenderer.on('office-live:key', listener)
    return () => void ipcRenderer.removeListener('office-live:key', listener)
  }
}
export type LiveOfficeApi = typeof live

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('aliax', aliaxApi)
    contextBridge.exposeInMainWorld('tcShow', show)
    contextBridge.exposeInMainWorld('tcLive', live)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
  // @ts-ignore (define in dts)
  window.tcShow = show
  // @ts-ignore (define in dts)
  window.tcLive = live
}
