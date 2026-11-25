import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { refusePasskeys } from './livePasskey'

const page = () => {
  const get = vi.fn(async () => 'a password')
  const create = vi.fn(async () => 'made')
  class CredentialsContainer {}
  Object.assign(CredentialsContainer.prototype, { get, create })
  return { root: { CredentialsContainer, DOMException } as unknown as Parameters<typeof refusePasskeys>[0], credentials: new CredentialsContainer() as { get(o?: object): Promise<unknown>; create(o?: object): Promise<unknown> }, get, create }
}

describe('a live guest\'s passkey refusal', () => {
  it('refuses a passkey ask at once with NotAllowedError, to get and create alike', async () => {
    const { root, credentials, get, create } = page()
    refusePasskeys(root)
    const at = Date.now()
    await expect(credentials.get({ publicKey: { challenge: new Uint8Array(16) } })).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(credentials.create({ publicKey: {} })).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(Date.now() - at).toBeLessThan(100)
    expect(get).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('leaves every other credential ask to the browser', async () => {
    const { root, credentials, get } = page()
    refusePasskeys(root)
    expect(await credentials.get({ password: true })).toBe('a password')
    expect(get).toHaveBeenCalledWith({ password: true })
  })

  it('does nothing on a page with no credentials container', () => {
    expect(() => refusePasskeys({ DOMException })).not.toThrow()
  })

  it('is serialized whole into the page: it names nothing outside itself', () => {
    const src = refusePasskeys.toString()
    expect(() => new Function(`return (${src})`)()).not.toThrow()
    expect(src).not.toMatch(/require|import|ipc/i)
  })

  it('rides a preload that exposes nothing and holds no IPC', () => {
    const preload = readFileSync(join(__dirname, '../../preload/livePasskey.ts'), 'utf8')
    expect(preload).toMatch(/executeInMainWorld\(\{ func: refusePasskeys \}\)/)
    expect(preload).not.toMatch(/ipcRenderer|exposeInMainWorld|webUtils|process\./)
  })
})
