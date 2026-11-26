import { createComputerBanner } from './computerBanner'
import { computerBannerHooks } from './server/computer/hold'
import { app, shell, dialog, net, BrowserWindow, Notification, ipcMain, powerMonitor, powerSaveBlocker } from 'electron'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import { flushCompileCache, getCompileCacheDir } from 'node:module'
import { REVEAL_NO_WINDOW } from '@shared/contract-work-reveal'
import { bootMark } from './server/boot'
import { noteInstallOnQuit, registerUpdates, selfUpdate, setCodeStatus } from './update'
import { applyHarness, bakedHarness, harnessIdentity } from './harness'
import { codeBoot } from './codeBoot'
import { dataMoveBoot } from './dataMoveBoot'
import { appRoot } from './server/appRoot'
import { SOAK_SWITCHES, soakWindow } from './soakWindow'
import { configureAliax, upstream } from './aliax'
import { loadEnvironmentId } from './server/remote/environment'
import { aliaxCallCounts, registerAliaxHandlers, registerAliaxPages, vaultStartFreshHooks } from './aliaxPages'
import { givenComputerHooks } from './server/devices/given'
import { registerAppshotIpc, startAppshots } from './appshots'
import { EditorLauncher, defaultEditorLaunchDeps, editorChoice, type EditorTarget } from './editorLaunch'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { isProdData } from './server/processGuard'
import { startServer, type RunningServer } from './server'
import { listEnvironments } from './server/remote/environments'
import type { LaunchMirrorSnapshot, MirrorWrite } from '@shared/launchMirror'
import { forgetUnsavedHosts, readBootMirror, type BootRead } from './bootMirror'
import { bootDesktop, deferred } from './desktopBoot'
import { windowsGate } from './windowGate'
import { preconnectAccount } from './server/preconnect'
import { spawnExecBrokerChild } from './execBrokerSpawn'
import { spawnGatewayChild } from './gatewaySpawn'
import { spawnAddonHostChild } from './addonHostSpawn'
import { mayClaimShim, releaseGateway } from './server/gateway'
import { killTrackedChildren } from './server/spawnBudget'
import { handleAssetRequest, pagesRoot, registerAssetProtocol, registerSchemes, setRemoteMedia, setRemotePages } from './assets'
import { registerAppProtocol } from './appScheme'
import { migrateLocalStorage } from './originMigration'
import { isHeadless, noDisplay, personsDesktop, publishLocalPort, quitsOnAllClosed, unpublishLocalPort } from './headless'
import { declareUserActivity, MacPresenceWatcher, macScreenReader, presenceFromEnv, screenOfIdleState } from './presence'
import { AttentionWatcher } from './attention'
import { PersonIdle } from './personIdle'
import { htmlPreviewer } from './htmlPreview'
import { registerOfficeLive } from './officeLive'
import { setHtmlPreviewer, setHtmlRenderRoot } from './server/htmlRender'
import { killAllPtys, listPtys, ptyFlowCounters, registerPty } from './pty'
import { clickMenuItem, registerMenu } from './menu'
import { registerCapture } from './capture'
import { registerPresent } from './present'
import { queueNextPick, registerDialogs } from './dialogs'
import { registerDownloads } from './downloads'
import { registerDrafts } from './drafts'
import { dragOutPaths } from './dragOut'
import {
  activateWindows,
  isAppWindow,
  createWindow,
  describeWindows,
  hasQuitSubscriber,
  isQuitting,
  openSavedWindows,
  registerDock,
  registerWindows,
  requestQuit,
  targetWindow
} from './windows'
import { setSignInParent } from './aliax/signInWindow'
import { aboutPanelOptions, buildInfo } from './buildInfo'
import { installWarningLog } from './warningLog'
import { registerRevealWindow } from './revealWindow'
import { queueWorkHandoff, registerWorkHandoff } from './workHandoff'
import { APP_USER_MODEL_ID, localUserData } from './windowFrame'
import { APP_NAME } from '../shared/appName'

// First statement of the bundle: everything before this mark is Electron's
// own init plus the compile of out/main/index.js (through boot.js). `start=`
// is the process start as an epoch, so renderer marks can be aligned to it.
bootMark(
  'index',
  `start=${Date.now() - Math.round(process.uptime() * 1000)} compile-cache=${getCompileCacheDir() ? 'on' : 'off'}`
)

// Every Node warning from here on lands in the log with the site that
// raised it (warningLog.ts): a MaxListenersExceededWarning names its
// emitter and its listener, which Node's own print leaves out.
installWarningLog()

let server: RunningServer | null = null

/** Node writes the compile cache (boot.ts) to disk only at its own exit, which
 *  Electron's quit never reaches: flush once boot has settled, and again in
 *  before-quit for modules required lazily since. No-ops when the cache is off. */
const FLUSH_AFTER_MS = 10_000

// Deliberately NOT raising the fd soft limit: Chromium's 8192 default is
// the containment wall that keeps a runaway fd consumer an app problem
// instead of a machine problem. The v70 raise let per-file watchers starve
// the system file/vnode tables — network down, reboot required. Watchers
// are one-fd-per-tree now (treewatch.ts); if the app ever nears 8192
// again, find the leak, don't raise the wall.

// Parallel dev instances (worktrees) get their own userData + database so
// they never contend with the primary checkout's running app. A packaged
// test build carries the same overrides in its package.json (harness.ts).
const baked = bakedHarness(app.getAppPath())
applyHarness(process.env, baked)
// Windows: the data dir sits under %LOCALAPPDATA%, off the roaming profile (windowFrame.ts).
const winUserData = localUserData(process.platform, process.env, app.getPath('userData'))
if (winUserData) app.setPath('userData', winUserData)
/** The app's own userData before any override: the installed app's data dir, the prod one on a Mac (Docket once boot.ts moved it). */
const defaultUserData = app.getPath('userData')
const identity = harnessIdentity(app.isPackaged, baked, process.env, {
  name: app.getName(),
  defaultUserData,
  execPath: process.execPath,
  version: app.getVersion(),
  pid: process.pid
})
if (identity) {
  try {
    mkdirSync(dirname(identity.path), { recursive: true })
    writeFileSync(identity.path, JSON.stringify(identity.record))
  } catch {
    // a proof's record, never a reason to stop the app
  }
}
if (process.env.TEMP_CODE_USER_DATA) {
  app.setPath('userData', process.env.TEMP_CODE_USER_DATA)
  // A proof's ballast: this many MiB resident in main, so a fork here costs what it costs on the box (scripts/e2e-exec-broker.ts). Isolated instances only.
  const ballastMb = Number(process.env.TEMP_CODE_E2E_BALLAST_MB ?? 0)
  if (ballastMb > 0) (globalThis as { __tcBallast?: Buffer }).__tcBallast = Buffer.alloc(ballastMb * 1024 * 1024, 1)
}
if (process.env.TEMP_CODE_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.TEMP_CODE_DEBUG_PORT)
}
// The renderer soak's window: shown inactive and never throttled (soakWindow.ts).
if (soakWindow()) for (const name of SOAK_SWITCHES) app.commandLine.appendSwitch(name)
// An agent host with no desktop (headless.ts): no window, menu, dock or
// updater, and no GPU worth probing. Without any display server at all,
// Chromium's headless Ozone backend stands in for one so the hidden
// preview window can still paint.
const headless = isHeadless()
const refuseHandoff = (words: string): void => {
  console.warn('[handoff]', words)
  void app.whenReady().then(() => {
    if (Notification.isSupported()) new Notification({ title: APP_NAME, body: words }).show()
  })
}
const handoff = queueWorkHandoff(async (params) => {
  if (!server) throw new Error(REVEAL_NO_WINDOW)
  await server.revealLocal(params)
}, refuseHandoff)
if (process.platform === 'darwin' && !headless) registerWorkHandoff(app, handoff.receive, refuseHandoff)
/** Set once openSavedWindows has run: before that, a hidden helper's going is not a quit. */
let userWindowsOpened = false
if (headless) {
  app.disableHardwareAcceleration()
  if (noDisplay()) app.commandLine.appendSwitch('ozone-platform', 'headless')
}

// Two hard walls against sharing a database. A dev instance without its own
// userData would open the installed app's database — a second SQLite writer
// there stalls the running app's event writes mid-turn (threads freeze on
// "Working…") and its boot-time status reset scribbles over live sessions.
// So: dev builds REQUIRE the env override, and any userData accepts only
// one instance, ever (the lock is per userData dir). Both run first, ahead of
// any window (desktopBoot.ts).
function guardDatabase(): boolean {
  if (!app.isPackaged && !process.env.TEMP_CODE_USER_DATA) {
    console.error(
      'refusing to run: dev instances must set TEMP_CODE_USER_DATA ' +
        "(see CLAUDE.md) — this would open the installed app's database"
    )
    app.exit(1)
    return false
  }
  if (!app.requestSingleInstanceLock()) {
    console.error('refusing to run: another instance already owns this userData directory')
    app.exit(1)
    return false
  }
  return true
}

/** The running server, for the handlers a window may call before it is up: they wait for it. */
const serverUp = deferred<RunningServer>()
// boot.ts moved temp-code.db to docket.db and left a link (dataMove.ts); Windows and a held move keep the old name.
const dbPath = (): string => join(app.getPath('userData'), dataMoveBoot()?.db ?? 'temp-code.db')
/** The launch mirror as the boot read it, before the server opened the database (bootMirror.ts). */
let bootRead: BootRead = { snapshot: null, workOn: false }
/** What prepare() makes for the server's options. */
let presence: MacPresenceWatcher
let personIdle: PersonIdle | null = null
let revealWindow: ReturnType<typeof registerRevealWindow> | undefined

void bootDesktop<RunningServer>({
  headless,
  guard: guardDatabase,
  // Privileged scheme registration only takes effect before the app is ready.
  beforeReady: registerSchemes,
  ready: () => app.whenReady(),
  prepare,
  // Before the first window reads localStorage on the app scheme: the
  // file:// origin's entries move over once (originMigration.ts).
  migrateLocalStorage: () =>
    migrateLocalStorage({
      rendererDir: join(__dirname, '../renderer'),
      userData: app.getPath('userData')
    }),
  // A live Office file's tickets, before any window can ask for one (officeLive.ts).
  registerOfficeLive,
  readMirror: () => {
    const t0 = Date.now()
    bootRead = readBootMirror(dbPath())
    bootMark('boot-mirror', `${Date.now() - t0}ms`)
  },
  openWindows: () => {
    // The walls are up: a Dock click or New Window that came sooner runs now (windowGate.ts).
    windowsGate.open()
    const up = openSavedWindows()
    userWindowsOpened = true
    return up
  },
  startServer: (windowUp) => {
    // Work's code loads at once only while Work is on for this host; else once the first window is up (load.ts).
    const workAfter = bootRead.workOn ? undefined : windowUp
    return startServer(dbPath(), {
      prodData: isProdData(app.getPath('userData'), defaultUserData),
      // Counted from the code that runs, never app.getAppPath(): under a code-only update that is the
      // bundle, and its out/ is the older one (docs/agents/code-only-updates.md).
      appPath: appRoot(),
      claimShim: mayClaimShim({ isPackaged: app.isPackaged }),
      assets: handleAssetRequest,
      watchMaster: !headless,
      // The gateway's byte path runs in a utility process of its own, on the Mac and on the headless box alike.
      spawnGatewayChild,
      // So do the add-on registry's downstream MCP servers: the add-on host's own process (addonHostSpawn.ts).
      spawnAddonHost: spawnAddonHostChild,
      // An add-on's sign-in and its values' probe ride the provider fetch; the sign-in opens the person's browser.
      addonFetch: (input, init) => upstream().fetch(input, init),
      openExternal: (url) => shell.openExternal(url),
      // So do the helper children (git, gh, ps): the exec broker forks them, never this process.
      // TEMP_CODE_EXEC_BROKER=0 keeps them here (the before side of scripts/e2e-exec-broker.ts).
      spawnExecBroker: process.env.TEMP_CODE_EXEC_BROKER === '0' ? undefined : spawnExecBrokerChild,
      // Its pre-connect when it falls back into this process (three exits in a minute).
      preconnect: (provider, account) => void preconnectAccount(provider, account, { upstream: upstream() }),
      // A release this app published, or the box's word that one landed, is fetched at once (update.ts).
      selfUpdate: headless ? undefined : (version) => selfUpdate(version),
      // A code-only update from a linked host is staged for boot.ts and offered on the update row (codeUpdates.ts).
      code: headless ? undefined : { boot: codeBoot(), onStatus: setCodeStatus },
      presence,
      revealWindow,
      personIdle: personIdle ?? undefined,
      // The display stays awake while threads work (server/keepAwake.ts): a Mac or a Windows PC with a desktop.
      keepAwake:
        (process.platform === 'darwin' || process.platform === 'win32') && !headless
          ? {
              blocker: {
                start: () => powerSaveBlocker.start('prevent-display-sleep'),
                stop: (id) => powerSaveBlocker.stop(id)
              },
              power: {
                onBattery: () => powerMonitor.isOnBatteryPower(),
                onChange: (listener) => {
                  powerMonitor.on('on-ac', listener)
                  powerMonitor.on('on-battery', listener)
                }
              }
            }
          : undefined,
      workAfter
    })
  },
  serverFailed: onServerFailed,
  serverUp: onServerUp
}).catch((err: unknown) => console.error('[boot] the boot failed:', err))

/** After ready, before any window: protocols, presence, and every handler a window may call. */
function prepare(): void {
  // Windows only (a no-op elsewhere): toasts and the taskbar button group under the installer's shortcut.
  electronApp.setAppUserModelId(APP_USER_MODEL_ID)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerAssetProtocol()
  registerAppProtocol()
  // A sign-in window opens over the app window in front.
  setSignInParent(targetWindow)
  // About: "Version 1.0.N (abc1234)" and the copyright, not Electron's defaults.
  // Under a code-only update: the bundle's version plus the commit that runs (codeChoice.ts).
  if (!headless) {
    const boot = codeBoot()
    app.setAboutPanelOptions(aboutPanelOptions(buildInfo(appRoot()), boot?.running ? { bundleVersion: boot.bundle.version, commit: boot.running.commit } : null))
  }
  // Agent HTML pages: stored under userData, previewed in the hidden window.
  setHtmlRenderRoot(pagesRoot())
  setHtmlPreviewer(htmlPreviewer)
  // The core compares every profile's owner to this id (aliax-core sync.ts).
  configureAliax(loadEnvironmentId(app.getPath('userData')))
  // This host's screen and power state for the relay (presence.ts): a Mac
  // with a desktop follows powerMonitor and reads the lock once at boot; a
  // headless host or another platform reports unknown/awake, and either
  // takes TEMP_CODE_PRESENCE on an isolated instance.
  // The person's idle time with computer use's own session-tier input taken out (personIdle.ts): the
  // scheduler and attention both read it, so a step the app posts never reads as the person coming back.
  personIdle = headless ? null : new PersonIdle(powerMonitor)
  const fromEnv = presenceFromEnv(process.env)
  presence = new MacPresenceWatcher({ initial: { screen: 'unknown', power: 'awake', ...fromEnv } })
  if (process.platform === 'darwin' && !headless) {
    // A passwordless screen saver is told from a lock by its facts (shared/screenState.ts); dismissing it
    // declares user activity, which is the app's own input, never the person coming back.
    const declare = declareUserActivity()
    if (!fromEnv.screen) {
      presence.useMac(macScreenReader(), async () => {
        const armedAt = Date.now()
        const idleAtArmMs = powerMonitor.getSystemIdleTime() * 1000
        const own = personIdle?.beginOwn()
        try {
          await declare()
        } finally {
          own?.end([{ armedAt, idleAtArmMs, lastInputAt: Date.now() }])
        }
      }, () => (personIdle ?? powerMonitor).getSystemIdleTime())
    }
    presence.attach(powerMonitor)
    if (!fromEnv.screen) void presence.readInitialLock()
  }
  if (process.platform === 'win32' && !headless) {
    // Windows says its lock and its sleep through powerMonitor alone, and a lock there is always a lock:
    // there is no passwordless saver to tell from one, so no reader and nothing to dismiss.
    if (!fromEnv.screen) presence.set({ screen: screenOfIdleState(powerMonitor.getSystemIdleState(1)) })
    presence.attach(powerMonitor)
  }
  // Whether the person is at this machine (attention.ts): the renderer names its focused thread only then.
  const attention = new AttentionWatcher(presence, personIdle ?? { getSystemIdleTime: () => 0 })
  ipcMain.handle('app:attention', () => attention.isPresent())
  if (!headless) {
    attention.onChange((present) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('app:attention', present)
    })
    attention.start()
  }
  if (process.platform === 'darwin' && !headless) computerBannerHooks.current = createComputerBanner()
  revealWindow = personsDesktop() ? registerRevealWindow(ipcMain, {
    target: targetWindow,
    presence: () => presence.snapshot(),
    dismissSaver: () => presence.dismissSaver(),
    onReady: () => {
      if (presence.snapshot().screen === 'unknown') void presence.refresh().then(handoff.windowReady)
      else handoff.windowReady()
    }
  }) : undefined
  registerWindowHandlers()
  // A Dock click before the first window is heard, and waits for the walls (windowGate.ts).
  app.on('activate', function () {
    if (!headless) windowsGate.run(activateWindows)
  })
}

/** Every handler a window may call, registered before the first window exists; one that needs the server waits for it. */
function registerWindowHandlers(): void {
  if (!headless) {
    // Windows: the installer cannot replace a file a running child holds open, so "Restart to update" shuts
    // the app's work down before it starts the installer (update.ts); before-quit then has nothing left to do.
    registerUpdates({
      beforeInstall:
        process.platform === 'win32'
          ? () => {
              stoppedForInstall = true
              shutDown()
            }
          : undefined
    })
  }
  // The accounts pages' handlers: a call made before the server is up waits for its hooks (aliaxPages.ts).
  registerAliaxHandlers(aliaxPagesReady.promise)
  registerPty()
  registerWindows({
    dropSnapshot: (slot) => void serverUp.promise.then((s) => s.store.dropWorkspaceSnapshot(slot)).catch(() => undefined),
    onMounted: () => void serverUp.promise.then((s) => s.codeWindowMounted()).catch(() => undefined)
  })
  if (!headless) registerPresent()
  registerDialogs()
  registerDownloads()
  // Drafts his windows journal while he edits (drafts.ts): under this computer's own data, for app windows alone.
  void registerDrafts(app.getPath('userData'), isAppWindow).catch((err: unknown) => console.error('[drafts] not registered', err))
  if (!headless) {
    registerMenu()
    registerDock()
    // Capture from anywhere (capture.ts): his key opens the capture window while Work is on here.
    registerCapture(serverUp.promise.then((running) => ({ work: running.workSwitch, port: () => running.port })))
  }
  if (!app.isPackaged) registerDebug()
  // A window announces appshot-ready once, as it mounts: its listener exists before the first window does.
  if (process.platform === 'darwin' && !headless) registerAppshotIpc()
  // The port answers once the server is up: a window made before it waits, and asks once (lib/tcserver/link.ts).
  ipcMain.handle('server-port', async () => (await serverUp.promise).port)
  // The launch mirror (src/main/server/launchMirror.ts): the renderer paints the rail from it before any socket
  // is up. While the server boots, the boot's own read-only read answers (bootMirror.ts); after, the server's.
  ipcMain.handle('launch-mirror:read', () => {
    const t0 = Date.now()
    const snapshot = server ? serverMirror(server) : bootRead.snapshot
    if (!snapshot) return serverUp.promise.then(serverMirror)
    console.log(`[boot] launch-mirror read ${Date.now() - t0}ms hosts=${snapshot.hosts.length} bytes=${JSON.stringify(snapshot).length}${server ? '' : ' from=boot'}`)
    return snapshot
  })
  ipcMain.on('launch-mirror:write', async (_e, write: MirrorWrite) => {
    try {
      await (await serverUp.promise).launchMirror.write(write)
    } catch (err) {
      console.error('[launch-mirror] write failed', err)
    }
  })
  ipcMain.handle('pick-directory', async (_e, defaultPath?: string) => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath || homedir()
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  ipcMain.handle('reveal-in-finder', (_e, path: string) => {
    shell.showItemInFolder(path)
  })
  // Files dragged out of the Files place to the desktop (dragOut.ts): the system carries real files of this machine.
  ipcMain.handle('drag-files-out', async (e, paths: unknown) => {
    const files = await dragOutPaths(paths)
    if (!files) return false
    const icon = await app.getFileIcon(files[0]!).catch(() => null)
    if (!icon || icon.isEmpty()) return false
    e.sender.startDrag({ file: files[0]!, files, icon })
    return true
  })
  // The user's editor (editorLaunch.ts): only where a window can be, so a
  // headless box answers null and the renderer hides the item.
  const editorLauncher = headless ? null : serverUp.promise.then((s) => new EditorLauncher(defaultEditorLaunchDeps(s.store)))
  // a server that did not start answers each editor call with its error (onServerFailed)
  editorLauncher?.catch(() => undefined)
  ipcMain.handle('editor-config', async () => (await editorLauncher)?.config() ?? null)
  ipcMain.handle('editor-set', async (_e, choice: unknown) => {
    const launcher = await editorLauncher
    launcher?.setChoice(editorChoice(typeof choice === 'string' ? choice : null))
    launcher?.refresh()
  })
  ipcMain.handle('editor-open', async (_e, target: EditorTarget) => {
    const launcher = await editorLauncher
    if (!launcher) throw new Error('No editor on this host')
    if (typeof target?.path !== 'string' || !target.path) throw new Error('A path is needed')
    return launcher.open({
      path: target.path,
      line: typeof target.line === 'number' ? target.line : undefined,
      column: typeof target.column === 'number' ? target.column : undefined
    })
  })
}

/** What the launch mirror holds now, from the server's own connection. */
function serverMirror(running: RunningServer): LaunchMirrorSnapshot {
  const environments = listEnvironments(running.store).map((row) => ({
    id: row.id,
    name: row.name,
    routes: row.routes.map((r) => ({ url: r.url, kind: r.kind })),
    ...(row.keyId !== undefined ? { keyId: row.keyId } : {}),
    ...(row.platform ? { platform: row.platform } : {})
  }))
  const hosts = running.launchMirror.read(['local', ...environments.map((row) => row.id)])
  return { environments, hosts } satisfies LaunchMirrorSnapshot
}

/** The accounts pages' hooks are in: their handlers' waiting calls run. */
const aliaxPagesReady = deferred<void>()

/**
 * The server did not start (an unreadable database, a port that cannot bind). Every call waiting for it hears the
 * error, and the process ends: before the window came first a failed start left a process with no window, so
 * now it says why and quits with a non-zero code rather than leave a splash that never fills.
 */
function onServerFailed(err: unknown): void {
  serverUp.reject(err)
  aliaxPagesReady.reject(err)
  bootMark('server-failed')
  console.error('[boot] the server did not start; quitting:', err)
  app.exit(1)
}

/** Everything that needs the running server; the windows are already up. */
function onServerUp(running: RunningServer): void {
  bootMark('server-returned')
  server = running
  serverUp.resolve(running)
  // The boot's read answered without forgetting the hosts no longer saved: the server's mirror forgets them now.
  // Best effort: a failed delete must not skip the accounts pages, appshots or the rest below.
  if (bootRead.snapshot) forgetUnsavedHosts(running.launchMirror, () => ['local', ...listEnvironments(running.store).map((row) => row.id)])
  if (!headless) {
    // Master's release.json again when a window comes forward after fifteen idle minutes (deployDrift.ts).
    app.on('browser-window-focus', () => running.masterRelease.focus())
  }
  setRemotePages({ environmentId: running.environmentId, read: running.remotePage })
  setRemoteMedia({ environmentId: running.environmentId, read: running.remoteMedia })
  // A throw here once ended the boot before the rest of it ran (2026-11-23, a refused watch);
  // the accounts pages are not worth the windows, the terminals and the remote port.
  try {
    registerAliaxPages(running)
  } catch (err) {
    console.error('[boot] the accounts pages did not register; the boot goes on:', err)
  } finally {
    aliaxPagesReady.resolve()
  }
  // A given computer's pins and identity went with the old vault: it is no longer given (devices/given.ts).
  vaultStartFreshHooks.push(() => givenComputerHooks.current?.startFresh())
  if (process.platform === 'darwin' && !headless) startAppshots(running, createWindow)

  if (headless) {
    // No window: the local socket's port goes to a file for an operator on
    // the host (scripts/box/tc-local.mjs); the renderer would get it over IPC.
    const file = publishLocalPort(app.getPath('userData'), running.port)
    console.log(`[headless] serving on 127.0.0.1:${running.port} (${file}); remote port ${running.remote?.port ?? 'off'}`)
  } else {
    void import('./printOut').then((m) => m.registerPrintOut()).catch((err: unknown) => console.error('[print] not registered', err))
  }
  setTimeout(() => flushCompileCache(), FLUSH_AFTER_MS).unref()
}

/** Dev-only hooks so the CDP exit test can drive things a page cannot. */
function registerDebug(): void {
  ipcMain.handle('debug:menu-click', (e, id: string) =>
    clickMenuItem(String(id), BrowserWindow.fromWebContents(e.sender))
  )
  ipcMain.handle('debug:dock-badge', () => (app.dock ? app.dock.getBadge() : null))
  ipcMain.handle('debug:window-title', (e) => BrowserWindow.fromWebContents(e.sender)?.getTitle())
  ipcMain.handle('debug:pty-flow', () => ptyFlowCounters())
  ipcMain.handle('debug:windows', () => describeWindows())
  ipcMain.handle('debug:ptys', () => listPtys())
  ipcMain.handle('debug:aliax-calls', () => aliaxCallCounts())
  ipcMain.handle('debug:next-pick', (_e, paths: string[]) => queueNextPick(paths.map(String)))
  // The old renderer's CSP forbids tempcode-asset:, so the scheme is
  // exercised from main instead.
  ipcMain.handle('debug:asset-fetch', async (_e, url: string) => {
    try {
      const res = await net.fetch(String(url))
      return { status: res.status, body: (await res.text()).slice(0, 200) }
    } catch (e) {
      return { status: 0, body: `threw ${(e as Error).message}` }
    }
  })
}

// macOS keeps the app in the dock after the last window closes (the donor
// does too); the kept slot comes back on the dock click. Elsewhere the last
// window is the app. A headless host has no window to speak of: the only
// ones it ever opens are html preview's hidden ones, and their going is
// not a quit.
app.on('window-all-closed', () => {
  if (quitsOnAllClosed({ headless, userWindowsOpened })) {
    app.quit()
  }
})

app.on('before-quit', (e) => {
  // A renderer that asked for the last word gets it once; after
  // `app:confirm-quit` the gate is open and we shut down for real.
  if (!isQuitting() && hasQuitSubscriber()) {
    e.preventDefault()
    requestQuit()
    return
  }
  // Windows: "Restart to update" already ran this, ahead of the installer it started (update.ts).
  if (stoppedForInstall) return
  shutDown()
})

/** Windows only: the updater shut the app's work down before it started the installer, so before-quit has nothing left to do. */
let stoppedForInstall = false

/** What a certain quit does to the app's own work. */
function shutDown(): void {
  flushCompileCache()
  // A downloaded release installs on this quit (Squirrel does that on its
  // own); remember it so the next boot can tell whether it landed.
  noteInstallOnQuit()
  // Threads mid-turn are remembered before their harnesses go: the next
  // boot resumes them (server/resumeAfterBoot.ts).
  recordResumeAfterBoot()
  // The server outlives every window and dies only here, with the PTYs
  // and every helper process it started.
  // The shim marker goes back to Aliax first: the async close may not finish.
  releaseGateway()
  if (headless) unpublishLocalPort(app.getPath('userData'))
  killAllPtys()
  void server?.close()
  killTrackedChildren()
}

/** The threads mid-turn right now, written for the next boot to resume
 *  (sessions.ts recordForResume). Synchronous: both callers exit at once.
 *  Never throws — a failed record must not keep the process from quitting. */
function recordResumeAfterBoot(): void {
  try {
    const ids = server?.registry.recordForResume() ?? []
    if (ids.length) console.log(`[resume] ${ids.length} thread(s) mid-turn recorded for the next boot`)
  } catch (error) {
    console.error('[resume] could not record threads mid-turn:', error)
  }
}

// Nothing of ours outlives the main process: a signal or a plain exit
// takes the helpers (git, gh, language servers) with it. Children stay in
// our process group, so a group kill from outside gets them as well.
process.on('exit', () => {
  releaseGateway()
  killTrackedChildren()
})
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    recordResumeAfterBoot()
    releaseGateway()
    killAllPtys()
    killTrackedChildren()
    process.exit(0)
  })
}
