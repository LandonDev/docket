/**
 * The main process's boot in its order (docs/agents/launch-code-caches.md "Boot order"). The window comes first
 * and the server boots beside it: the splash and the rail from the launch mirror paint while the database opens.
 *
 * Ahead of any window, in this order and each ended: the walls against sharing a database (a dev build without
 * TEMP_CODE_USER_DATA exits, one instance per userData), the privileged schemes, Electron's ready, the handlers a
 * window may call (those that need the server wait for it), the localStorage move off file://, the live-Office
 * fence, and the mirror's read-only boot read. A headless host makes no window: its server starts after `prepare`.
 */
export interface DesktopBoot<S> {
  headless: boolean
  /** The dev guard and the single-instance lock; false when this process is exiting. */
  guard(): boolean
  /** Before ready: the privileged schemes (assets.ts). */
  beforeReady(): void
  ready(): Promise<void>
  /** Protocols, presence, and every IPC handler a window may call. */
  prepare(): void
  migrateLocalStorage(): Promise<void>
  registerOfficeLive(): void
  /** The launch mirror's rows through their own read-only connection (bootMirror.ts). */
  readMirror(): void
  /** The saved windows; resolves once the first is up (painted, or gone). */
  openWindows(): Promise<void>
  startServer(windowUp: Promise<void>): Promise<S>
  /** Everything that needs the running server. */
  serverUp(server: S): void | Promise<void>
}

export async function bootDesktop<S>(boot: DesktopBoot<S>): Promise<S | null> {
  if (!boot.guard()) return null
  boot.beforeReady()
  await boot.ready()
  boot.prepare()
  let windowUp = Promise.resolve()
  if (!boot.headless) {
    await boot.migrateLocalStorage()
    boot.registerOfficeLive()
    boot.readMirror()
    windowUp = boot.openWindows()
  }
  const server = await boot.startServer(windowUp)
  await boot.serverUp(server)
  return server
}

/** A promise and its resolver: the server for the handlers that wait for it. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
