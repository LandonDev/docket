import { describe, expect, it } from 'vitest'
import { NO_GRANT_FROM_CONSOLE, notGrantable } from './outbox'

/** An act the host read in a command line (outward.ts consoleRead) is one no grant may cover. */
describe('an act no grant may cover', () => {
  it('is one whose read says so, and only that', () => {
    expect(notGrantable({ read: { step: 0, why: 'console', label: 'Run', on: 'text "dir" in Terminal', grantable: false } })).toBe(true)
    expect(notGrantable({ read: { step: 0, why: 'control', label: 'Send', on: 'button "Send"' } })).toBe(false)
    expect(notGrantable({ read: null })).toBe(false)
    expect(notGrantable(null)).toBe(false)
    expect(NO_GRANT_FROM_CONSOLE).toMatch(/^refused: /)
  })
})
