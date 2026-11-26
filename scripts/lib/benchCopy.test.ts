import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { benchCopyRefusal, IN_USE_MS } from './benchCopy'

describe('a bench refuses what it must not open', () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-copy-'))
  const live = join(root, 'docket-data')
  const scratch = join(root, 'scratch')
  mkdirSync(live)
  mkdirSync(scratch)
  writeFileSync(join(live, 'docket.db'), '')
  writeFileSync(join(scratch, 'docket.db'), '')
  symlinkSync(join(live, 'docket.db'), join(scratch, 'linked.db'))

  it("refuses the live folder's database, also by a link", () => {
    expect(benchCopyRefusal(join(live, 'docket.db'), { live: [live] })).toMatch(/app's own data/)
    expect(benchCopyRefusal(join(scratch, 'linked.db'), { live: [live] })).toMatch(/app's own data/)
    expect(benchCopyRefusal(join(scratch, 'docket.db'), { live: [live] })).toBeNull()
  })

  it('refuses a copy whose write-ahead log, or its cold one, moved in the last ten minutes', () => {
    const now = Date.now()
    writeFileSync(join(scratch, 'docket-cold.db-wal'), 'x')
    expect(benchCopyRefusal(join(scratch, 'docket.db'), { live: [live], now })).toMatch(/in use/)
    const old = (now - IN_USE_MS - 1000) / 1000
    utimesSync(join(scratch, 'docket-cold.db-wal'), old, old)
    expect(benchCopyRefusal(join(scratch, 'docket.db'), { live: [live], now })).toBeNull()
  })
})
