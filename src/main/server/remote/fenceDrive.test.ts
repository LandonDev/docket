import { afterEach, describe, expect, it } from 'vitest'
import { keepDrive, realSpelling, setRealpath } from './fence'

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

afterEach(() => setRealpath())

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
