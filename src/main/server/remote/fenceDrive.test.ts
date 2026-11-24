import { afterEach, describe, expect, it } from 'vitest'
import { hostReal, keepDrive, realSpelling, setNativeRealpath, setRealpath, SHARE_FRESH_MS } from './fence'

/**
 * A mapped network drive keeps its letter. Windows' own realpath (Node's `fs.realpathSync.native`) answers the
 * share for a path on it; the JavaScript one (`fs.realpathSync`) walks the path and keeps the letter. Both are
 * stood in here, as each answers on a PC with `J:` mapped to `\\files\esports`.
 */
const native = (path: string): string => {
  if (/^j:/i.test(path)) return `\\\\files\\esports${path.slice(2)}`
  if (/^c:/i.test(path)) return `C:${path.slice(2)}`
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
}
const javascript = (path: string): string => {
  if (/^[cj]:/i.test(path)) return path
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
}

afterEach(() => (setRealpath(), setNativeRealpath()))

describe('a mapped drive keeps its spelling', () => {
  it.each([
    ['native', native],
    ['javascript', javascript]
  ])('the %s realpath', (_, realpath) => {
    expect(keepDrive('J:\\Esports\\Budget.xlsx', realpath)).toBe('J:\\Esports\\Budget.xlsx')
    expect(keepDrive('J:\\', realpath)).toBe('J:\\')
    expect(keepDrive('C:\\Users\\tc', realpath)).toBe('C:\\Users\\tc')
  })

  it('reads the long form of a share and a share this drive does not map', () => {
    expect(keepDrive('J:\\Esports', (p) => (/^j:\\?$/i.test(p) ? '\\\\?\\UNC\\files\\esports' : '\\\\?\\UNC\\files\\esports\\Esports'))).toBe('J:\\Esports')
    // A link on the drive that leads to another share: the path stays as he wrote it, never the share.
    expect(keepDrive('J:\\Away', (p) => (/^j:\\?$/i.test(p) ? '\\\\files\\esports' : '\\\\other\\share\\x'))).toBe('J:\\Away')
  })

  it('realSpelling keeps the letter under a stubbed native realpath', () => {
    setRealpath(native)
    expect(realSpelling('J:\\Esports')).toBe('J:\\Esports')
  })
})

describe("a host's own reads of its files on Windows", () => {
  it('ask Windows once a path however deep, and the share a drive maps once a while', () => {
    const asked: string[] = []
    setNativeRealpath((p) => (asked.push(p), native(p)))
    const deep = 'J:\\Bench\\A\\B\\C\\Report.pdf'
    expect(hostReal(deep, { platform: 'win32', now: 0 })).toBe(deep)
    expect(hostReal('J:\\Bench', { platform: 'win32', now: 1_000 })).toBe('J:\\Bench')
    expect(asked).toEqual([deep, 'J:\\', 'J:\\Bench'])
    hostReal('J:\\Bench', { platform: 'win32', now: SHARE_FRESH_MS + 1 })
    expect(asked.slice(3)).toEqual(['J:\\Bench', 'J:\\'])
  })

  it('is keepDrive as it was elsewhere', () => {
    setRealpath(javascript)
    setNativeRealpath(() => {
      throw new Error('not on this host')
    })
    expect(hostReal('J:\\Esports', { platform: 'darwin' })).toBe('J:\\Esports')
  })
})
