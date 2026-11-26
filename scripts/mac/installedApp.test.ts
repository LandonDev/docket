import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// The scripts that wait for the installed app to quit find it by its path, under both names: an
// install from before the rename is still /Applications/TempCode.app.
it.each(['split-data-dir.sh', 'cutover-run.sh'])('%s finds the installed app under either name', (script) => {
  const patterns = [...readFileSync(join(__dirname, script), 'utf8').matchAll(/pgrep -fq '(\/Applications\/[^']+)'/g)].map((m) => new RegExp(m[1]))
  expect(patterns).toHaveLength(1)
  for (const exe of ['/Applications/Docket.app/Contents/MacOS/Docket', '/Applications/TempCode.app/Contents/MacOS/TempCode']) expect(patterns[0].test(exe), exe).toBe(true)
})
