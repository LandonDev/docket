import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * What F2 gave the pillars in place of reaching across folders
 * (docs/agents/work.md "The context"): an item and its pane through
 * `ctx.canvas`, the data folder through `ctx.dataDir`, the listener's path
 * fence through `ctx.reaches`. No pillar but the canvas takes the canvas's
 * store, and none asks the job runner for the data folder or reads the
 * roots from the database itself.
 */
const WORK = import.meta.dirname
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [join(dir, e.name)] : []))

describe('the pillars reach the frame through the context', () => {
  const pillars = sources(WORK).filter((file) => {
    const rel = relative(WORK, file)
    return rel.includes('/') && !rel.startsWith('canvas/')
  })

  it('reads no canvas item through the canvas store', () => {
    expect(pillars.length).toBeGreaterThan(20)
    for (const file of pillars) expect(readFileSync(file, 'utf8'), relative(WORK, file)).not.toMatch(/canvasStoreOf/)
  })

  it("takes the data folder from ctx.dataDir, not from the job runner's toolchain", () => {
    for (const file of pillars.filter((f) => !relative(WORK, f).startsWith('formats/'))) expect(readFileSync(file, 'utf8'), relative(WORK, file)).not.toMatch(/tools\.dataDir/)
  })

  it('reads no fence roots from the database: the listener\'s fence is ctx.reaches', () => {
    for (const file of pillars) expect(readFileSync(file, 'utf8'), relative(WORK, file)).not.toMatch(/SELECT cwd AS p FROM projects/)
  })
})
