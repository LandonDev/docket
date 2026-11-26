import { beforeEach, describe, expect, it, vi } from 'vitest'

/** The window's launch-mirror read is one invoke, never a synchronous IPC (docs/agents/launch-mirror.md). */
const ipc = vi.hoisted(() => ({
  invoke: vi.fn(async (channel: string) => (channel === 'launch-mirror:read' ? { environments: [], hosts: [] } : null)),
  sendSync: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))
const exposed = vi.hoisted(() => new Map<string, unknown>())
vi.mock('electron', () => ({
  ipcRenderer: ipc,
  contextBridge: { exposeInMainWorld: (name: string, value: unknown) => exposed.set(name, value) },
  webUtils: { getPathForFile: () => '' }
}))
vi.mock('@electron-toolkit/preload', () => ({ electronAPI: {} }))

beforeEach(() => {
  vi.stubGlobal('process', { ...process, contextIsolated: true })
})

describe('the preload launch mirror', () => {
  it('reads with one invoke and no sendSync, and writes fire and forget', async () => {
    await import('./index')
    const api = exposed.get('api') as { launchMirror: { read(): Promise<unknown>; write(w: unknown): void } }
    await expect(api.launchMirror.read()).resolves.toEqual({ environments: [], hosts: [] })
    expect(ipc.invoke.mock.calls.filter(([channel]) => channel === 'launch-mirror:read')).toHaveLength(1)
    api.launchMirror.write({ environmentId: 'local' })
    expect(ipc.send).toHaveBeenCalledWith('launch-mirror:write', { environmentId: 'local' })
    expect(ipc.sendSync).not.toHaveBeenCalled()
  })
})
