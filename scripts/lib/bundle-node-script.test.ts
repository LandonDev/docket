import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { bundleNodeScript } from './bundle-node-script'

const repo = resolve(import.meta.dirname, '../..')

describe('bundleNodeScript', () => {
  it('turns a ?modulePath import into its source path and keeps other packages external', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bundle-node-')))
    writeFileSync(join(dir, 'worker.ts'), 'export {}\n')
    writeFileSync(join(dir, 'entry.ts'), "import workerPath from './worker?modulePath'\nimport { z } from 'zod'\nconsole.log(workerPath, z)\n")
    const out = join(dir, 'out.mjs')
    expect(await bundleNodeScript(repo, join(dir, 'entry.ts'), out, { server: true })).toBeNull()
    const text = readFileSync(out, 'utf8')
    expect(text).toContain(JSON.stringify(join(dir, 'worker')))
    expect(text).toMatch(/from "zod"/)
  })

  it('names the failure instead of throwing', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bundle-node-')))
    writeFileSync(join(dir, 'entry.ts'), "import './missing'\n")
    expect(await bundleNodeScript(repo, join(dir, 'entry.ts'), join(dir, 'out.mjs'))).toMatch(/^esbuild failed:/)
  })
})
