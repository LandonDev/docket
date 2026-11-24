/**
 * The live Office fence, proven in real Chromium on the box (docs/agents/work-office-live.md "The fence"):
 *   heavy bun scripts/proof-office-live-fence.ts
 * Bundles scripts/proof-office-live/fence-main.ts (the real officeLive.ts and originAllowed.ts) and runs it in this
 * checkout's Electron under xvfb. The guest loads Microsoft's signed-out sign-in page; no account is used.
 * Passes when: a ticketed guest attaches and loads it, the unticketed one never attaches, the guest has no bridge and
 * no Node, it reaches no loopback address by fetch or WebSocket, and a page of another origin is refused by the server.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')
const dir = mkdtempSync(join(tmpdir(), 'tc-live-fence-'))
const keep = process.argv.includes('--keep')
try {
  for (const [entry, name] of [['fence-main.ts', 'main.js'], ['fence-preload.ts', 'preload.js']]) {
    const b = spawnSync('bun', ['build', join(REPO, 'scripts/proof-office-live', entry), '--target=node', '--format=cjs', '--external', 'electron', '--outfile', join(dir, name)], { stdio: 'inherit', cwd: REPO })
    if (b.status !== 0) throw new Error(`bundle ${entry} failed`)
  }
  const electron = join(REPO, 'node_modules', '.bin', 'electron')
  const out = join(dir, 'result.json')
  const run = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1280x900x24 -nolisten tcp', 'dbus-run-session', '--', electron, `--user-data-dir=${join(dir, 'data')}`, join(dir, 'main.js')], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PROOF_OUT: out, PROOF_DIR: dir },
    timeout: 200_000
  })
  const r = JSON.parse(readFileSync(out, 'utf8'))
  console.log(JSON.stringify(r, null, 2))
  const g = r.inGuest ?? {}
  const checks: [string, boolean][] = [
    ['one guest attached (the ticketed one)', r.attached === 1],
    ['the ticket was issued', r.page?.ticket?.ok === true],
    ['the guest is on Microsoft', /^https:\/\/login\.microsoftonline\.com\//.test(r.guestUrl ?? '')],
    ['the guest sees plain Chrome', !/Electron|TempCode/.test(r.guestPartitionAgent ?? 'Electron')],
    ['no bridge, no Node in the guest', g.api === 'undefined' && g.require === 'undefined' && g.process === 'undefined' && g.tcLive === 'undefined' && g.electron === 'undefined'],
    ['no loopback by fetch', g.fetchHttp === 'failed' && g.fetchHttps === 'failed' && g.fetchLocalhost === 'failed'],
    ['no loopback by WebSocket', g.ws !== 'open' && g.wss !== 'open'],
    ['the guest never reached the server', !(r.upgrades as { origin: string | null }[]).some((u) => /microsoft|sharepoint/.test(u.origin ?? ''))],
    ['a page of another origin is refused by the server', r.outerSocket === 'refused' && (r.upgrades as { ok: boolean }[]).some((u) => !u.ok)],
    ['no time out', !r.timedOut]
  ]
  let failed = 0
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
    if (!ok) failed++
  }
  if (run.status !== 0 && run.status !== null) console.log(`electron exited ${run.status}`)
  process.exitCode = failed ? 1 : 0
} finally {
  if (!keep) rmSync(dir, { recursive: true, force: true })
}
