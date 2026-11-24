import { afterEach, describe, expect, it } from 'vitest'
import type { TeamsLibrary } from '@shared/contract-work-office'
import { setRealpath } from '../../../remote/fence'
import { forgetLibraryRoots, libraryOf } from './library'

/** The one fence every library read passes (library.ts `libraryOf`): its own folder resolved once a while, a path resolved once a call. */

afterEach(() => {
  setRealpath()
  forgetLibraryRoots()
})

const lib = (path: string): TeamsLibrary => ({ id: `pc:${path}`, host: 'pc', path, team: 'Esports', library: null, tenant: null, kind: 'folder', channels: [], web: null, found: false })

describe('a library path', () => {
  it("resolves the library's own folder once for a burst of calls, and a path the caller resolved not again", () => {
    const asked: string[] = []
    setRealpath((p) => (asked.push(p), p))
    const libs = [lib('/srv/share/Esports')]
    for (let i = 0; i < 5; i++) expect(libraryOf(libs, `/srv/share/Esports/Row ${i}.docx`)).toMatchObject({ path: `/srv/share/Esports/Row ${i}.docx` })
    expect(libraryOf(libs, '/srv/share/Esports/Resolved.docx', { real: true })).not.toBeNull()
    expect(asked.filter((p) => p === '/srv/share/Esports')).toHaveLength(1)
    expect(asked.filter((p) => p.endsWith('Resolved.docx'))).toHaveLength(0)
  })

  it('still refuses a path that resolves outside, each call', () => {
    setRealpath((p) => (p.endsWith('Out.docx') ? '/srv/elsewhere/Out.docx' : p))
    expect(libraryOf([lib('/srv/share/Esports')], '/srv/share/Esports/Out.docx')).toBeNull()
  })
})
