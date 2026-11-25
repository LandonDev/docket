import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { shareLines, shareProven, type ShareReport } from './lib/ios-work-seeds'

// The Share proof's verdict (scripts/ios-sim-proof-local.ts): the run is green only when the no-pick case held and
// the saved file was read back from Purdue Esports' folder by its hash.
describe('the Share proof verdict', () => {
  const folder = mkdtempSync(join(tmpdir(), 'share-verdict-'))
  const bytes = Buffer.from('bracket photo')
  writeFileSync(join(folder, 'Bracket photo.png'), bytes)
  const sha = createHash('sha256').update(bytes).digest('hex')
  const done: ShareReport = { name: 'Bracket photo.png', size: bytes.length, sha256: sha, state: 'done', unpicked: true, workspaceId: 'ws-purdue' }
  afterAll(() => rmSync(folder, { recursive: true, force: true }))

  it('fails with no report', () => {
    expect(shareProven(shareLines('ws-purdue', null, folder))).toBe(false)
  })

  it('fails on a refused upload', () => {
    expect(shareProven(shareLines('ws-purdue', { ...done, state: 'refused', words: 'too large' }, folder))).toBe(false)
  })

  it('fails on a hash that does not match', () => {
    expect(shareProven(shareLines('ws-purdue', { ...done, sha256: 'f'.repeat(64) }, folder))).toBe(false)
  })

  it('fails when the save went to another job, or the no-pick case did not hold', () => {
    expect(shareProven(shareLines('ws-purdue', { ...done, workspaceId: 'ws-other' }, folder))).toBe(false)
    expect(shareProven(shareLines('ws-purdue', { ...done, unpicked: false }, folder))).toBe(false)
  })

  it('passes on a real match', () => {
    const lines = shareLines('ws-purdue', done, folder)
    expect(lines).toHaveLength(2)
    expect(shareProven(lines)).toBe(true)
  })
})
