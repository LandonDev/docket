import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { setUploadsOwed, uploadsOwed } from './owed'

/** The keeper hears of uploads owed through one seam, and the VM pillar pulls no Files module in with it (b0a5ac224). */
describe('uploads owed', () => {
  it('says what the Files pillar set, and nothing before it is set', () => {
    expect(uploadsOwed()).toBe(false)
    setUploadsOwed(() => true)
    expect(uploadsOwed()).toBe(true)
    setUploadsOwed(() => false)
  })

  it('is the VM pillar\'s only way to the Files pillar: no module of it imports one of Files', () => {
    for (const name of readdirSync(import.meta.dirname).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      expect(readFileSync(join(import.meta.dirname, name), 'utf8'), name).not.toMatch(/from '\.\.\/files\//)
    }
  })
})
