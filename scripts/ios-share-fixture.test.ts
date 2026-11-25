import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { guestRolesOf, guestTableOf, SHARE_REFUSALS } from '../src/shared/work/guestRoles'

/* The phone's Share sheet (ios/TempCodeClient/Sources/TempCodeClient/Work/Guests/ShareRules.swift) says the host's
 * refusals in the form's place and offers each item's roles as the desktop's sheet does. This test writes the host's
 * own words and roles to Fixtures/share/rules.json and holds the file to them; ShareRulesTests replays them on the
 * phone. UPDATE_FIXTURES=1 writes the file. */

const ROOT = resolve(__dirname, '..')
const FIXTURE = join(ROOT, 'ios/TempCodeClient/Tests/TempCodeClientTests/Fixtures/share/rules.json')

type Source = Parameters<typeof guestTableOf>[0]
const SOURCES: Source[] = [
  { at: 'lifeos', table: 'docs' },
  { at: 'lifeos', table: 'sheets' },
  { at: 'lifeos', table: 'projects' },
  { at: 'file', path: '/w/Travel memo.tcdoc' },
  { at: 'file', path: '/w/Budget.TCSHEET' },
  { at: 'file', path: '/w/Letter.docx' }
]

function compute(): unknown {
  return {
    refusals: Object.values(SHARE_REFUSALS),
    sources: SOURCES.map((source) => ({ source, table: guestTableOf(source), roles: guestTableOf(source) ? guestRolesOf(source) : [] }))
  }
}

describe('Share fixture', () => {
  it("holds the phone's Share rules to the host's", () => {
    const computed = `${JSON.stringify(compute(), null, 2)}\n`
    if (process.env.UPDATE_FIXTURES === '1') {
      mkdirSync(dirname(FIXTURE), { recursive: true })
      writeFileSync(FIXTURE, computed)
    }
    expect(readFileSync(FIXTURE, 'utf8'), 'run with UPDATE_FIXTURES=1, then carry the change to ShareRules.swift').toBe(computed)
  })
})
