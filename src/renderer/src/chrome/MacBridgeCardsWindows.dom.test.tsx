import { describe, expect, it, vi } from 'vitest'
import type { MacBridgeRequest } from '@server/shared/contract-macbridge'

// A Windows host decides a box's calls too (docs/agents/windows-host.md): its cards name it a PC.
vi.mock('../lib/native', async (original) => ({
  ...(await original<typeof import('../lib/native')>()),
  nativePlatform: () => 'win32',
  thisDesktopName: () => 'This PC'
}))

const { requestTitle } = await import('./MacBridgeCards')
const { localEnvironment } = await import('../lib/connection/registry')

const request = (patch: Partial<MacBridgeRequest>): MacBridgeRequest =>
  ({ id: 'c1', environmentId: 'env_box', hostName: 'box', sessionId: 's1', threadTitle: 't', kind: 'run', method: 'mac.run', argv: ['git', 'status'], cwd: 'C:\\x', createdAt: 0, expiresAt: 1, status: 'pending', ...patch }) as MacBridgeRequest

describe('a bridge card on Windows', () => {
  it('says "on this PC", for a command and for an app', () => {
    expect(requestTitle(request({}))).toBe('box wants to run on this PC')
    expect(requestTitle(request({ kind: 'computer', computer: { app: 'Notepad' } } as Partial<MacBridgeRequest>))).toBe('box wants to use Notepad on this PC')
  })

  it('the local host is called This PC', () => {
    expect(localEnvironment(1).name).toBe('This PC')
  })
})
