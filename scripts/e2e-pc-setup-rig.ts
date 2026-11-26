#!/usr/bin/env bun
/**
 * The whole setup-link run in the Windows rig (plan M7, docs/agents/pc-setup.md "The rig run"): a fresh install of
 * the Windows installer as tcuser, set up from a link made on a stand-in Mac, through a stand-in box, with a stand-in
 * LifeOS. None of it is his: the stand-ins are isolated instances on this box (scripts/lib/pcRigStandins.ts), the
 * LifeOS is a local backend, and the rig's overlay is thrown away at down.sh.
 *
 *   bun scripts/e2e-pc-setup-rig.ts --installer dist/temp-code-1.0.N-setup.exe [--rig-up] [--keep]
 *
 * Needs, already running on 127.0.0.1 (the header of docs/agents/pc-setup.md "The rig run" has the commands):
 *  - a local LifeOS backend on :3330 built from LifeOS main, with a desktop token for the stand-in Mac in
 *    /tmp/tc-pc-rig/lifeos/mac.token (0600), and its desktop installer, 0.1.10 or later, built for
 *    http://10.0.2.2:3330, with its latest.yml, in /tmp/tc-pc-rig/lifeos-feed;
 *  - a user-space SMB share of dummy files on :44500 (share JDRIVE, user jproof, its password in /tmp/tc-pc-rig/smb.pass),
 *    with Esports\readme.txt holding "Nothing here is real".
 * The lent sign-in is the box's own Claude CLI token (one year, no refresh token), read into the stand-in Mac's vault
 * and never printed; the run's own Remove takes it back from the PC.
 *
 * Pictures and times go to .temp-code/plans/landed/pc-setup/rig/.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { anonGiB, GUEST_HOME, GUEST_LOCAL, inSession, installedApp, openHostPorts, ps, Record, REPO, rpc, rpcAt, sleep, tunnel, until, vm, Window } from './lib/pcRig'
import { APP_PROCESSES } from './lib/winAppNames'
import { DUMMY, lentSignIn, PORTS, startStandins, type Standins } from './lib/pcRigStandins'

const arg = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const installer = resolve(arg('--installer') ?? '')
const rigUp = process.argv.includes('--rig-up')
const keep = process.argv.includes('--keep')
if (!existsSync(installer) || !/temp-code-(1\.0\.\d+)-setup\.exe$/.test(installer)) {
  console.error('usage: bun scripts/e2e-pc-setup-rig.ts --installer dist/temp-code-1.0.N-setup.exe [--rig-up] [--keep]')
  process.exit(64)
}
const version = /temp-code-(1\.0\.\d+)-setup\.exe$/.exec(installer)![1]!
const DIR = '/srv/agents/work/temp-code/.temp-code/plans/landed/pc-setup/rig'
const rec = new Record(DIR)
const STAND_LIFEOS = `http://10.0.2.2:${PORTS.lifeos}`
const USER_DATA = `${GUEST_LOCAL}\\temp-code-rig`
const GUEST_CDP = 9333
const CDP = 9338
const SERVER = 9339
const times: { step: string; s: number; ok: boolean }[] = []

/** One step: its time, and a failure that stops nothing after it unless it says so. */
async function step(name: string, fn: () => Promise<void>): Promise<boolean> {
  const t0 = Date.now()
  const before = rec.failures
  rec.log(`── ${name}`)
  try {
    await fn()
  } catch (err) {
    rec.check(`${name}: ran to its end`, false, err instanceof Error ? err.message : String(err))
  }
  times.push({ step: name, s: Math.round((Date.now() - t0) / 1000), ok: rec.failures === before })
  return rec.failures === before
}

let stand: Standins | null = null
let pc: Window | null = null
let mac: Window | null = null
const tunnels: ReturnType<typeof tunnel>[] = []
let startedRig = false
const pcRpc = <T = any>(method: string, params: unknown = {}, timeoutMs?: number): Promise<T> => rpcAt<T>(SERVER, method, params, timeoutMs)
let macShot = 0
const macPicture = async (name: string): Promise<void> => {
  const file = join(DIR, `mac-${String(++macShot).padStart(2, '0')}-${name}.png`)
  await mac!.png(file)
  rec.log(`picture ${file}`)
}
const stepsOf = async (): Promise<string> => {
  const t = await pc!.text()
  const i = t.indexOf('Link to the box')
  return i < 0 ? '' : t.slice(i, t.indexOf('Close', i) > 0 ? t.indexOf('Close', i) : i + 600).replace(/\n/g, ' | ')
}

async function startPc(): Promise<void> {
  const started = await inSession([(await installedApp()).exe])
  if (started.code !== 0) throw new Error(`the app did not start: ${started.out.slice(0, 200)}`)
  for (const t of tunnels.splice(0)) t.kill()
  tunnels.push(tunnel([`${CDP}:127.0.0.1:${GUEST_CDP}`]))
  await sleep(3000)
  pc = await Window.attach(CDP, 180_000)
  const port = await pc.eval<number>('window.api.getServerPort()')
  tunnels.push(tunnel([`${SERVER}:127.0.0.1:${port}`]))
  await sleep(2500)
}

async function run(): Promise<void> {
  const lent = lentSignIn()
  const lifeosToken = readFileSync('/tmp/tc-pc-rig/lifeos/mac.token', 'utf8').trim()
  if ((await fetch(`http://127.0.0.1:${PORTS.lifeos}/instance_name`).then((r) => r.text()).catch(() => '')) !== 'lifeos-local') throw new Error('no local LifeOS backend on :3330')

  await step('the rig, a fresh overlay', async () => {
    if (rigUp) return
    if (anonGiB() >= 45) throw new Error(`the agents slice holds ${anonGiB()} GiB; the rig waits for under 45`)
    const up = await vm('up', ['--guestfwd', '10.0.2.100:445=44500'], 900_000)
    if (up.code !== 0) throw new Error(up.out.slice(-300))
    startedRig = true
  })

  await step('the stand-ins: box, Mac (the giver), fake provider, LifeOS feed', async () => {
    stand = await startStandins('/tmp/tc-pc-rig/run', { lifeosToken, feedDir: '/tmp/tc-pc-rig/lifeos-feed', log: (m) => rec.log(m) })
    mac = await Window.attach(PORTS.macDebug, 60_000)
    const accounts = await rpc<{ providers: { claude: { profiles: { name: string }[] } } }>(stand.mac, 'accounts.list')
    rec.check('the stand-in Mac holds the two dummy accounts and the lent one', accounts.providers.claude.profiles.length === 3)
  })

  await step(`install ${basename(installer)} as tcuser, fresh`, async () => {
    // Nothing of a run before: the app's data and vault, and any LifeOS with its data and uninstall entry.
    await ps(
      [
        `Get-Process ${APP_PROCESSES},LifeOS -EA 0 | Stop-Process -Force -EA 0; Start-Sleep 2`,
        `Remove-Item -Recurse -Force '${USER_DATA}', "$env:APPDATA\\aliax" -EA 0`,
        `Get-ChildItem "$env:LOCALAPPDATA\\Programs" -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'LifeOS.exe') } | Remove-Item -Recurse -Force -EA 0`,
        `Get-ChildItem $env:LOCALAPPDATA, $env:APPDATA -Directory -Filter 'lifeos*' -EA 0 | Remove-Item -Recurse -Force -EA 0`,
        `Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like 'LifeOS*' } | Remove-Item -Recurse -Force`
      ].join('; ')
    )
    const copied = await vm('scp', [installer, 'guest:Downloads/'], 900_000)
    if (copied.code !== 0) throw new Error(copied.out.slice(-200))
    const t0 = Date.now()
    const installed = await vm('ssh', [`Downloads\\${basename(installer)} /S`], 1_800_000)
    rec.check('the installer runs silently as the standard user and exits 0', installed.code === 0, `${Math.round((Date.now() - t0) / 1000)} s`)
    const app = await installedApp()
    const v = await ps(`(Get-Content -Raw '${app.dir}\\resources\\app\\package.json' | ConvertFrom-Json).version`)
    rec.check(`${version} is in ${app.dir.slice(GUEST_LOCAL.length + 1)}`, v.out.trim() === version, v.out)
    const fw = await openHostPorts([PORTS.box, PORTS.lifeos, PORTS.lifeos + 1, PORTS.feed])
    rec.check("the guest's firewall lets it reach the stand-ins' ports, for this run", fw.code === 0, fw.out)
    // The harness marker and the stand-ins' addresses, honoured by the app only under TEMP_CODE_USER_DATA.
    const env = { TEMP_CODE_USER_DATA: USER_DATA, TEMP_CODE_DEBUG_PORT: String(GUEST_CDP), TEMP_CODE_LIFEOS_URL: STAND_LIFEOS, TEMP_CODE_LIFEOS_FEED: `http://10.0.2.2:${PORTS.feed}/` }
    await ps(Object.entries(env).map(([k, v]) => `[Environment]::SetEnvironmentVariable('${k}', '${v}', 'User')`).join('; '))
  })

  await step('J: mapped by tcuser from the box', async () => {
    const mapped = await inSession(['C:\\Windows\\System32\\cmd.exe', '/c', `(net use J: /delete /y >nul 2>&1) & net use J: \\\\10.0.2.100\\JDRIVE ${readFileSync('/tmp/tc-pc-rig/smb.pass', 'utf8').trim()} /user:jproof /persistent:no && dir /b J:\\Esports`], true, 90)
    rec.check('J: is mapped from the box over SMB, signing required', mapped.code === 0 && /readme\.txt/.test(mapped.out), mapped.out.slice(-160))
  })

  let link = ''
  await step('the link, made on the stand-in Mac', async () => {
    await mac!.click('Settings')
    await sleep(1500)
    await mac!.click('Hosts')
    await sleep(2500)
    await mac!.click('Set up a computer…')
    await sleep(2000)
    await macPicture('setup-dialog')
    await mac!.eval(`document.querySelector('[role=dialog] input').focus()`)
    await mac!.type('Rig PC')
    await mac!.click('Make link')
    await until('the link', 20_000, async () => !!(link = (await mac!.eval<string | null>(`(() => { for (const e of document.querySelectorAll('[role=dialog] *')) { const v = (e.value || (e.children.length ? '' : e.textContent) || '').trim(); if (/\\/setup#v1\\./.test(v)) return v } return null })()`)) ?? ''))
    rec.check('Make link gives a link on the box origin the PC reaches', link.startsWith(`http://10.0.2.2:${PORTS.box}/setup#v1.`), `${link.length} chars`)
    writeFileSync('/tmp/tc-pc-rig/setup.link', link, { mode: 0o600 })
    // The picture shows the link's end hidden.
    await mac!.eval(`(() => { for (const e of document.querySelectorAll('[role=dialog] *')) { if ('value' in e && /setup#/.test(e.value)) e.style.webkitTextSecurity = 'disc'; else if (!e.children.length && /setup#/.test(e.textContent)) e.textContent = e.textContent.replace(/#.*/, '#••••') } })()`)
    await macPicture('link-made')
    await mac!.click('Done')
  })

  let words = ''
  await step('paste the link on the PC, peek, Set up this PC', async () => {
    await startPc()
    await until('the first screen', 60_000, () => pc!.has('Paste the link from your Mac'))
    await rec.shot('pc-first-screen')
    await pc!.eval(`document.querySelector('[role=dialog] input').focus()`)
    await pc!.type(link)
    await pc!.eval(`document.querySelector('[role=dialog] input').style.webkitTextSecurity = 'disc'`)
    await pc!.click('Continue')
    await until('the peek', 30_000, () => pc!.has('Set up this PC'))
    const t = await pc!.text()
    const from = t.slice(t.indexOf('From '), t.indexOf('\n', t.indexOf('From ')))
    rec.check('the PC shows who gives what, from which box, before anything moves', /From .+ at 10\.0\.2\.2:47320: link to the box, your accounts, LifeOS with Outlook and Teams, folders in Files/.test(from), from)
    await rec.shot('pc-peek')
    await pc!.click('Set up this PC')
    await until('the words', 60_000, async () => !!(words = /([a-z]+ · [a-z]+ · [a-z]+)/.exec(await pc!.text())?.[1] ?? ''))
    rec.check('the PC waits for Allow with three words', !!words, words)
    await rec.shot('pc-waiting-for-allow')
  })

  await step('Allow on the stand-in Mac, the words matching', async () => {
    let toast = ''
    await until('the Allow notice', 60_000, async () => /wants to join/.test((toast = await mac!.eval<string>(`[...document.querySelectorAll('[data-sonner-toast]')].map((e) => e.innerText).join(' || ')`))))
    await macPicture('allow-notice')
    rec.check("the Mac's notice names the PC and shows the same three words", toast.includes('Rig PC wants to join') && toast.includes(words), toast.replace(/\n/g, ' '))
    await mac!.click('Allow', '[data-sonner-toast] button')
  })

  await step('every step done', async () => {
    let last = ''
    await until('the folders step', 600_000, async () => {
      const s = await stepsOf()
      if (s !== last) rec.log(`steps: ${(last = s)}`)
      return /Add folders…/.test(s) && !/Working/.test(s)
    }, 3000)
    await rec.shot('pc-steps-before-folders')
    // Add folders… opens the PC's own folder picker; the pick is typed into it as he would.
    await pc!.click('Add folders…')
    await sleep(4000)
    await rec.shot('pc-folder-picker')
    const { typeText, pressKeys } = await import('./lib/pcRig')
    await typeText('J:\\Esports')
    await pressKeys('ret')
    await sleep(2500)
    await pressKeys('ret')
    const picked = await until('the folder taken', 30_000, async () => /Folders in Files \| Done/.test(await stepsOf()))
    if (!picked) {
      rec.log('the native picker did not take the typed folder; the same pick goes through devices.setup.folders, the call the picker makes')
      await pressKeys('esc')
      await pcRpc('devices.setup.folders', { paths: ['J:\\Esports'] })
    }
    await until('Ready', 120_000, () => pc!.has('Ready'), 2000)
    rec.check('every step is done and the PC says Ready', await pc!.has('Ready'), await stepsOf())
    await rec.shot('pc-ready')
  })

  await step('the dummy accounts and the lent one arrive', async () => {
    const names = async (): Promise<string[]> => (await pcRpc<{ providers: { claude: { profiles: { name: string }[] } } }>('accounts.list')).providers.claude.profiles.map((p) => p.name).sort()
    const want = [...DUMMY.map((d) => d.name), lent.email].sort()
    await until('the accounts', 120_000, async () => JSON.stringify(await names()) === JSON.stringify(want), 2000)
    rec.check('the PC holds the two dummy accounts and the lent one, given', JSON.stringify(await names()) === JSON.stringify(want), `${(await names()).length} accounts`)
  })

  await step('a thread runs a turn on the lent account (Sonnet)', async () => {
    await ps(`New-Item -ItemType Directory -Force "${GUEST_HOME}\\tc-proof" | Out-Null`)
    const meta = await pcRpc<{ id: string }>('session.create', { provider: 'claude', cwd: `${GUEST_HOME}\\tc-proof`, title: 'Rig setup proof', threadType: 'chat', permission: 'auto' })
    await pcRpc('session.send', { sessionId: meta.id, text: 'Reply with exactly RIG-SETUP-OK and nothing else.', model: 'claude-sonnet-5-5', reasoning: 'low' })
    type Ev = { event: { type: string; text?: string; message?: string } }
    let said = ''
    const answered = await until('the answer', 300_000, async () => {
      const events = await pcRpc<Ev[]>('session.events', { sessionId: meta.id, afterSeq: 0 })
      said = events.map((e) => `${e.event.type}:${(e.event.text ?? e.event.message ?? '').slice(0, 80)}`).slice(-4).join(' | ')
      return events.some((e) => (e.event.text ?? '').includes('RIG-SETUP-OK') && !/user/i.test(e.event.type))
    }, 3000)
    rec.check('the thread answers on the PC through the lent account', answered, said)
  })

  await step('LifeOS installed and signed in against the stand-in, reading on and sending off', async () => {
    const folder = `lifeos-10.0.2.2-${PORTS.lifeos}`
    const got = await ps(`@(Get-Process LifeOS -EA 0).Count; [bool](Get-ChildItem "$env:LOCALAPPDATA\\Programs" -Recurse -Depth 1 -Filter LifeOS.exe -EA 0); Get-Content -Raw "$env:APPDATA\\${folder}\\purdue.json" -EA 0`)
    const [running, exe, ...json] = got.out.trim().split(/\r?\n/)
    rec.check('LifeOS is installed under %LOCALAPPDATA%\\Programs and running', Number(running) > 0 && exe === 'True', `${running} ${exe}`)
    const purdue = JSON.parse(json.join('') || '{}') as { read?: boolean; send?: boolean }
    rec.check("LifeOS's reader is on and its sender off", purdue.read === true && purdue.send !== true, JSON.stringify(purdue))
    const work = await pcRpc<{ lifeos: { state: string } }>('work.lifeos.status')
    rec.check("TempCode's Work on the PC is signed in to the stand-in LifeOS", work.lifeos.state === 'connected' || work.lifeos.state === 'enrolled', work.lifeos.state)
  })

  await step("J: listed and a file opened from the stand-in Mac's window, through the stand-in box", async () => {
    // The box reads J: through the PC's bridge for it: Read is enough (docs/agents/work-files.md); setup leaves it as it was.
    const box = (await pcRpc<{ id: string; name: string }[]>('remote.environments.list'))[0]
    const policy = (await pcRpc<{ environmentId: string; policy: string }[]>('macBridge.policy.get')).find((h) => h.environmentId === box?.id)?.policy
    rec.log(`the PC's bridge for the box after setup: ${policy}`)
    if (policy === 'off') {
      rec.log('his one press on the PC: Settings → Hosts → Mac bridge for the box → Access → Read')
      await pcRpc('macBridge.policy.set', { environmentId: box!.id, policy: 'read' })
    }
    await mac!.key('Escape')
    await sleep(1000)
    await mac!.click(/^Purdue \(rig\)$/)
    await sleep(2500)
    for (let k = 0; k < 3 && !(await mac!.has('Places')); k++) {
      await mac!.click('Files')
      await sleep(3500)
    }
    const listed = await until('Esports', 30_000, () => mac!.has('Esports'), 1000)
    await macPicture('files-places')
    rec.check("Esports (J:\\Esports on the PC) is under Places in the box workspace's Files", listed)
    for (let k = 0; k < 3 && !(await mac!.has('roster-dummy.csv')); k++) {
      await mac!.click('Esports', 'button, a, [role=button], [role=treeitem], [role=link], li, [role=row]')
      await sleep(3500)
    }
    rec.check('its files are listed', await mac!.has('roster-dummy.csv'))
    const at = await mac!.eval<{ x: number; y: number } | null>(`(() => { const el = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent.trim() === 'readme.txt').pop(); if (!el) return null; const r = el.closest('[role=option]').getBoundingClientRect(); return { x: r.left + r.width * 0.6, y: r.top + r.height / 2 } })()`)
    if (at) for (const n of [1, 2]) for (const type of ['mousePressed', 'mouseReleased'] as const) await mac!.cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: n })
    const opened = await until('the file', 60_000, () => mac!.has('Nothing here is real'), 1000)
    await macPicture('file-opened')
    rec.check('readme.txt opens in the Mac window, a copy made on the box', opened)
  })

  await step('an account removed on the stand-in Mac is gone from the PC', async () => {
    const gone = DUMMY[1]!.name
    await rpc(stand!.mac, 'accounts.delete', { service: 'claude-code', name: gone })
    const off = await until('the removal', 180_000, async () => !(await pcRpc<{ providers: { claude: { profiles: { name: string }[] } } }>('accounts.list')).providers.claude.profiles.some((p) => p.name === gone), 3000)
    rec.check(`${gone} is gone from the PC`, off)
  })

  await step('the vault folder copied to a second standard user is unreadable there, the original untouched', async () => {
    const hash = `Get-ChildItem -Recurse -File "C:\\Users\\tcuser\\AppData\\Roaming\\aliax" | Sort-Object FullName | ForEach-Object { (Get-FileHash $_.FullName).Hash } | Out-String`
    const before = (await ps(hash, 60_000, true)).out
    const key = (await ps(`(Get-Content -Raw "$env:APPDATA\\aliax\\vault.key").Substring(0, 14)`)).out.trim()
    rec.check('the vault key on the PC is sealed for its user (aliax-wrap:v1), never plain hex', key === 'aliax-wrap:v1:', key)
    for (const f of ['dpapi-try.ps1', 'batch-right.ps1']) await vm('scp', [join(REPO, 'scripts', 'win-vm', f), `guest:${f}`], 60_000)
    const copy = 'C:\\Users\\Public\\tc-vault-copy'
    const pass = `Rig${randomBytes(6).toString('hex')}!`
    // tcuser2: a second standard user made for the run, with a password logon (DPAPI needs one) through a task, which
    // needs the batch logon right on this throwaway overlay.
    await ps(
      [
        `Copy-Item -Force C:\\Users\\tcuser\\dpapi-try.ps1 C:\\Users\\Public\\dpapi-try.ps1`,
        `$p = ConvertTo-SecureString '${pass}' -AsPlainText -Force`,
        `if (Get-LocalUser tcuser2 -EA 0) { Set-LocalUser tcuser2 -Password $p } else { New-LocalUser tcuser2 -Password $p -PasswordNeverExpires | Out-Null; Add-LocalGroupMember Users tcuser2 }`,
        `Remove-Item -Recurse -Force '${copy}' -EA 0; New-Item -ItemType Directory -Force '${copy}' | Out-Null`,
        `Copy-Item -Recurse 'C:\\Users\\tcuser\\AppData\\Roaming\\aliax' '${copy}'; Copy-Item '${USER_DATA}\\Local State' '${copy}'`,
        `icacls '${copy}' /grant 'tcuser2:(OI)(CI)R' /T | Out-Null`
      ].join('; '),
      120_000,
      true
    )
    await ps(readFileSync(join(REPO, 'scripts', 'win-vm', 'batch-right.ps1'), 'utf8'), 60_000, true)
    const asOther = await ps(
      [
        `Remove-Item C:\\Users\\Public\\dpapi-tcuser2.json -EA 0`,
        `schtasks /create /tn tc-dpapi-tcuser2 /ru tcuser2 /rp '${pass}' /sc once /st 23:59 /f /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\Users\\Public\\dpapi-try.ps1 -LocalState '${copy}\\Local State' -Out C:\\Users\\Public\\dpapi-tcuser2.json" 2>&1 | Out-Null`,
        `schtasks /run /tn tc-dpapi-tcuser2 | Out-Null`,
        `for ($i = 0; $i -lt 30 -and -not (Test-Path C:\\Users\\Public\\dpapi-tcuser2.json); $i++) { Start-Sleep 2 }`,
        `schtasks /delete /tn tc-dpapi-tcuser2 /f | Out-Null`,
        `Get-Content -Raw C:\\Users\\Public\\dpapi-tcuser2.json`
      ].join('; '),
      180_000,
      true
    )
    const other = JSON.parse(asOther.out.trim().split(/\r?\n/).pop() || '{}') as { user?: string; ownWorks?: boolean; opened?: boolean }
    rec.check("as tcuser2 (DPAPI working for its own data), the copied vault's key does not open", other.user === 'tcuser2' && other.ownWorks === true && other.opened === false, JSON.stringify(other).slice(0, 220))
    // The control: tcuser on his own desktop opens the same copy.
    const asOwner = await inSession(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\Users\\Public\\dpapi-try.ps1', '-LocalState', `${copy}\\Local State`, '-Out', 'C:\\Users\\Public\\dpapi-tcuser.json'], true, 60)
    const mine = JSON.parse((await ps(`Get-Content -Raw C:\\Users\\Public\\dpapi-tcuser.json -EA 0`)).out.trim() || '{}') as { user?: string; opened?: boolean }
    rec.check('as tcuser, the same copy opens (the control)', mine.user === 'tcuser' && mine.opened === true, `${asOwner.code} ${JSON.stringify(mine).slice(0, 120)}`)
    const after = (await ps(hash, 60_000, true)).out
    rec.check("tcuser's vault folder is untouched", before === after && before.length > 0)
    await ps(`Remove-Item -Recurse -Force '${copy}', 'C:\\Users\\Public\\dpapi-*.json' -EA 0; Remove-LocalUser tcuser2 -EA 0`, 60_000, true)
  })

  await step('Remove on the stand-in Mac takes everything back and the key ends', async () => {
    const computers = await rpc<{ computers: { envId: string; name: string }[] }>(stand!.mac, 'devices.computers')
    const row = computers.computers.find((c) => c.name === 'Rig PC')
    if (!row) throw new Error('the Mac lists no Rig PC')
    await mac!.key('Escape')
    await sleep(800)
    await mac!.click('Settings')
    await sleep(1500)
    await mac!.click('Hosts')
    await sleep(2500)
    await macPicture('computers-before-remove')
    await rpc(stand!.mac, 'devices.computer', { envId: row.envId, action: 'remove' })
    const wiped = await until('the wipe', 180_000, async () => {
      const a = await pcRpc<{ providers: { claude: { profiles: unknown[] } } }>('accounts.list').catch(() => null)
      return !!a && a.providers.claude.profiles.length === 0
    }, 3000)
    rec.check('every given account is gone from the PC', wiped)
    const binding = await until('the receipt', 120_000, async () => (await rpc<{ bindings: { envId: string; state: string }[] }>(stand!.box, 'devices.list')).bindings.find((b) => b.envId === row.envId)?.state === 'retired', 3000)
    rec.check("the box retired the PC's binding on its signed receipt", binding)
    const keyId = (await rpc<{ bindings: { envId: string; keyId: string }[] }>(stand!.box, 'devices.list')).bindings.find((b) => b.envId === row.envId)?.keyId
    const keys = await rpc<{ keys: { id: string; revokedAt?: number | null; revoked?: boolean }[] } | { id: string; revokedAt?: number | null; revoked?: boolean }[]>(stand!.box, 'remote.keys.list')
    const mine = (Array.isArray(keys) ? keys : keys.keys).find((k) => k.id === keyId)
    rec.check("the PC's key on the box is revoked", !!keyId && (!mine || !!mine.revokedAt || mine.revoked === true), JSON.stringify(mine ?? { keyId, listed: false }).slice(0, 200))
    const hosts = await pcRpc<unknown[]>('remote.environments.list')
    rec.check('the PC holds no box any more', Array.isArray(hosts) && hosts.length === 0, JSON.stringify(hosts).slice(0, 120))
    const work = await pcRpc<{ lifeos: { state: string } }>('work.lifeos.status')
    rec.check("TempCode's LifeOS sign-in on the PC is gone", work.lifeos.state !== 'connected', work.lifeos.state)
    const purdue = await ps(`Get-Content -Raw "$env:APPDATA\\lifeos-10.0.2.2-${PORTS.lifeos}\\purdue.json" -EA 0`)
    rec.check("LifeOS's reader is off", /"read":\s*false/.test(purdue.out), purdue.out.slice(0, 80))
    await rec.shot('pc-after-remove')
    await macPicture('computers-after-remove')
  })
}

try {
  await run()
} catch (err) {
  rec.check('the run finished', false, err instanceof Error ? err.message : String(err))
} finally {
  await ps(`Get-Process ${APP_PROCESSES},LifeOS -EA 0 | Stop-Process -Force -EA 0; Remove-Item -Force "$env:USERPROFILE\\Downloads\\${basename(installer)}" -EA 0; foreach ($k in 'TEMP_CODE_USER_DATA','TEMP_CODE_DEBUG_PORT','TEMP_CODE_LIFEOS_URL','TEMP_CODE_LIFEOS_FEED') { [Environment]::SetEnvironmentVariable($k, $null, 'User') }`).catch(() => null)
  for (const t of tunnels) t.kill()
  pc?.close()
  mac?.close()
  if (!keep) await stand?.close()
  if (startedRig && !keep) await vm('down', [], 300_000)
  rmSync('/tmp/tc-pc-rig/setup.link', { force: true })
  writeFileSync(join(DIR, 'times.json'), JSON.stringify(times, null, 2))
  rec.save('run.log')
  console.log(rec.failures === 0 ? 'E2E PC SETUP RIG: PASS' : `E2E PC SETUP RIG: ${rec.failures} FAILED`)
  process.exit(rec.failures === 0 ? 0 : 1)
}
