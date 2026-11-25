import { describe, expect, it } from 'vitest'
import { FULL_SHUTDOWN } from './sshGuest'

describe("the guest's shutdown", () => {
  it('is a full one that Windows takes: /s alone, never /hybrid, never forced, no /full', () => {
    // `shutdown /?` in the guest lists /s, /hybrid, /f and no /full: a line with /full is refused whole
    const flags = FULL_SHUTDOWN.split(' ').slice(1)
    expect(flags).toContain('/s')
    for (const no of ['/full', '/hybrid', '/f', '/h']) expect(flags).not.toContain(no)
  })
})
