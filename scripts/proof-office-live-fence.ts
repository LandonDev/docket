/**
 * The live Office fence, proven in real Chromium on the box (docs/agents/work-office-live.md "The fence"):
 *   heavy bun scripts/proof-office-live-fence.ts
 * Bundles scripts/proof-office-live/fence-main.ts (the real officeLive.ts and originAllowed.ts) and runs it in this
 * checkout's Electron under xvfb. The guest loads Microsoft's signed-out sign-in page; no account is used.
 * Passes when: a ticketed guest attaches and loads it, the unticketed one never attaches, the guest has no bridge and
 * no Node, it reaches no loopback address by fetch or WebSocket, a page of another origin is refused by the server,
 * the guest has no `PublicKeyCredential` and a passkey ask refuses within a second, and a made-up address
 * (`tc-proof@purdue.edu`, no account, no password) gets Microsoft's answer rather than a spinner.
 * `--shot <file.png>` keeps the guest's picture after that address.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')
const dir = mkdtempSync(join(tmpdir(), 'tc-live-fence-'))
const keep = process.argv.includes('--keep')
const shotAt = process.argv.indexOf('--shot')
const shot = shotAt > 0 ? resolve(process.argv[shotAt + 1]) : join(dir, 'signin.png')
try {
  // The live sessions' passkey refusal, where the fence looks for it: bun bakes this checkout in as the bundle's
  // __dirname, so the app's root is the checkout and the file is its out/preload/livePasskey.js.
  for (const [entry, name] of [['fence-main.ts', 'main.js'], ['fence-preload.ts', 'preload.js'], ['../../src/preload/livePasskey.ts', join(REPO, 'out/preload/livePasskey.js')]]) {
    const b = spawnSync('bun', ['build', join(REPO, 'scripts/proof-office-live', entry), '--target=node', '--format=cjs', '--external', 'electron', '--outfile', resolve(dir, name)], { stdio: 'inherit', cwd: REPO })
    if (b.status !== 0) throw new Error(`bundle ${entry} failed`)
  }
  const electron = join(REPO, 'node_modules', '.bin', 'electron')
  const out = join(dir, 'result.json')
  const run = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1280x900x24 -nolisten tcp', 'dbus-run-session', '--', electron, `--user-data-dir=${join(dir, 'data')}`, join(dir, 'main.js')], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PROOF_OUT: out, PROOF_DIR: dir, PROOF_SHOT: shot },
    timeout: 200_000
  })
  if (run.error || run.status !== 0) throw new Error(`Office fence Electron run: ${run.error?.message ?? run.signal ?? run.status}`)
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
    ['no PublicKeyCredential in the guest', g.publicKeyCredential === 'undefined'],
    ['a passkey ask refuses at once', g.passkeyGet === 'NotAllowedError' && g.passkeyCreate === 'NotAllowedError' && g.passkeyMs < 1000],
    ['a made-up address gets an answer, not a spinner', r.signIn?.answered === true],
    ['no time out', !r.timedOut]
  ]
  let failed = 0
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
    if (!ok) failed++
  }
  process.exitCode = failed ? 1 : 0
} finally {
  if (!keep) rmSync(dir, { recursive: true, force: true })
}
