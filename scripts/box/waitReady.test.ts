import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * box-update's wait_ready, cut out of the script and run with stubs: a failed
 * trial says which step failed, what the probe said and the unit's journal,
 * in the deploy log the window shows.
 */
const script = readFileSync(join(import.meta.dirname, 'box-update.sh'), 'utf8')
const fn = script.slice(script.indexOf('wait_ready() {'), script.indexOf('\n}\n', script.indexOf('wait_ready() {')) + 3)

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function run(o: { healthz: boolean; serverJson: boolean; probe: string; probeOk: boolean }): { code: number | null; err: string; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tc-wait-ready-'))
  dirs.push(dir)
  if (o.serverJson) writeFileSync(join(dir, 'server.json'), '{"port":1}')
  const stubs = `
curl() { ${o.healthz ? 'return 0' : 'return 7'}; }
probe() { echo ${JSON.stringify(o.probe)}; ${o.probeOk ? 'return 0' : 'return 1'}; }
journalctl() { echo "Error: ENOSPC: System limit for number of file watchers reached, watch '/home/.codex'"; echo "    at watchAuthJson"; }
sleep() { :; }
`
  const body = `set -Eeuo pipefail\n${stubs}\n${fn}\nBOX_READY_SECONDS=1 wait_ready build ${JSON.stringify(dir)} 4242 temp-code-trial-1.service`
  const r = spawnSync('bash', ['-c', body], { encoding: 'utf8', timeout: 20_000 })
  return { code: r.status, err: r.stderr, out: r.stdout }
}

describe('box-update wait_ready', () => {
  it('passes and keeps the probe\'s own line', () => {
    const r = run({ healthz: true, serverJson: true, probe: 'PROBE PASS: hello', probeOk: true })
    expect(r.code).toBe(0)
    expect(r.out).toContain('PROBE PASS: hello')
  })

  it('a boot that stopped before server.json says so, with the unit\'s last lines', () => {
    const r = run({ healthz: true, serverJson: false, probe: '', probeOk: false })
    expect(r.code).toBe(1)
    expect(r.err).toContain('ERROR: health/socket check failed on 4242')
    expect(r.err).toContain('never wrote')
    expect(r.err).toContain('the last lines of temp-code-trial-1.service:')
    expect(r.err).toContain('ENOSPC: System limit for number of file watchers reached')
  })

  it('a health check that never answers says so', () => {
    const r = run({ healthz: false, serverJson: false, probe: '', probeOk: false })
    expect(r.code).toBe(1)
    expect(r.err).toContain('/healthz on 4242 never answered')
  })

  it('a failed probe carries what the probe said', () => {
    const r = run({ healthz: true, serverJson: true, probe: 'assertion failed: version or contract mismatch', probeOk: false })
    expect(r.code).toBe(1)
    expect(r.err).toContain('the probe said:')
    expect(r.err).toContain('version or contract mismatch')
  })
})
