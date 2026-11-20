import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makePassword, renderAnswerFile, xmlEscape } from './answer'
import { daemonEnv, instanceName, locksFor, onTheBase, rigConfig, rigPaths, snapshotName } from '../../src/main/server/work/winvm/machine/config'
import { keepLiveTpm, kvmWrapped, liveTpmIsNewer } from '../../src/main/server/work/winvm/machine/daemons'
import { encodePowerShell, psQuote, psStdin, runInSessionScript, waitedProgramScript, winQuote } from '../../src/main/server/work/winvm/machine/guest'
import { qemuArgs, swtpmArgs } from '../../src/main/server/work/winvm/machine/qemu'
import { Qmp, qmp, screendump, sendKey } from '../../src/main/server/work/winvm/machine/qmp'

const cfg = rigConfig({ WINVM_DIR: '/srv/x/win-vm' }, 999)
const paths = rigPaths(cfg)

describe('the rig config', () => {
  it('caps the machine at 8 cores and 16 GB, keeps its files under its folder and its TPM under /tmp', () => {
    expect(cfg).toMatchObject({ cpus: 8, memory: '16G', sshPort: 22220, tpmDir: '/tmp/win-vm-tpm-999' })
    expect(paths.baseDisk).toBe('/srv/x/win-vm/base/disk.qcow2')
    expect(paths.runDisk).toBe('/srv/x/win-vm/run/disk.qcow2')
    expect(paths.tpmSock).toBe('/tmp/win-vm-tpm-999/swtpm.sock')
  })

  it('starts QEMU and swtpm with none of the marks the process guard kills by, and no tokens', () => {
    const env = daemonEnv({ HOME: '/h', TEMP_CODE_THREAD: 't', TEMP_CODE_CALL: 'c', CLAUDE_PID: '1', ANTHROPIC_BASE_URL: 'x', TEMP_CODE_HUB_TOKEN: 's' })
    expect(env).toEqual({ PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/h', LANG: 'C.UTF-8' })
  })

  it('takes a snapshot name only as a plain folder name', () => {
    expect(snapshotName('clean-1.2_x')).toBe('clean-1.2_x')
    for (const bad of ['', '.', '..', '../..', 'a/b', '-x', '.hidden', 'x.part', undefined]) expect(() => snapshotName(bad)).toThrow('bad snapshot name')
  })

  it('takes overrides from the environment', () => {
    expect(rigConfig({ WINVM_CPUS: '4', WINVM_MEM: '8G', WINVM_SSH_PORT: '2300' }, 1)).toMatchObject({ cpus: 4, memory: '8G', sshPort: 2300 })
  })
})

describe('two instances', () => {
  const sCfg = rigConfig({ WINVM_DIR: '/srv/x/win-vm' }, 999, 'standing')
  const s = rigPaths(sCfg)

  it('keeps the rig exactly where it was, and the standing machine in its own folder with 6 cores, 8 GB and ssh on 22230', () => {
    expect(cfg).toMatchObject({ instance: 'rig', dir: '/srv/x/win-vm', process: 'tc-win11', cdpPort: 9333 })
    expect([paths.run, paths.lock, paths.qmp, paths.knownHosts]).toEqual(['/srv/x/win-vm/run', '/srv/x/win-vm/.lock', '/srv/x/win-vm/run/qmp.sock', '/srv/x/win-vm/base/known_hosts'])
    expect(sCfg).toMatchObject({ instance: 'standing', root: '/srv/x/win-vm', dir: '/srv/x/win-vm/standing', cpus: 6, memory: '8G', sshPort: 22230, cdpPort: null })
    expect(sCfg.tpmDir).toBe('/tmp/win-vm-tpm-999-standing')
    expect(s.runDisk).toBe('/srv/x/win-vm/standing/run/disk.qcow2')
    expect(s.baseDisk).toBe(paths.baseDisk)
    expect(sCfg.process.length).toBeLessThanOrEqual(15) // /proc's comm, by which its pid file is checked
  })

  it('never share a file that changes, nor a port', () => {
    const own = (q: typeof paths) => [q.run, q.lock, q.shots, q.snapshots, q.knownHosts, q.tpmState, q.tpmSock, q.tpmPid, q.tpmLog]
    const rigOwn = own(paths)
    for (const f of own(s)) for (const r of rigOwn) expect(f === r || f.startsWith(`${r}/`) || r.startsWith(`${f}/`), `${f} / ${r}`).toBe(false)
    expect(sCfg.process).not.toBe(cfg.process)
    expect(sCfg.sshPort).not.toBe(cfg.sshPort)
  })

  it('gives each machine its own name, sockets, forwards and size', () => {
    const a = qemuArgs(sCfg, s, { disk: s.runDisk, vars: s.runVars })
    const valueOf = (flag: string) => a.filter((_, i) => a[i - 1] === flag)
    expect(valueOf('-name')).toEqual(['tc-win11-stand,process=tc-win11-stand'])
    expect(valueOf('-netdev')[0]).toBe('user,id=n0,hostfwd=tcp:127.0.0.1:22230-:22')
    expect(valueOf('-smp')).toEqual(['6,sockets=1,cores=6,threads=1'])
    expect(valueOf('-m')).toEqual(['8G'])
    expect(valueOf('-qmp')).toEqual(['unix:/srv/x/win-vm/standing/run/qmp.sock,server=on,wait=off'])
    expect(valueOf('-pidfile')).toEqual(['/srv/x/win-vm/standing/run/qemu.pid'])
    expect(a.join(' ')).toContain('file=/srv/x/win-vm/standing/run/OVMF_VARS.fd')
    expect(swtpmArgs(s).join(' ')).toContain('path=/tmp/win-vm-tpm-999-standing/swtpm.sock')
  })

  it('names the instance by flag, the rig by default, and refuses any other', () => {
    expect(instanceName(undefined)).toBe('rig')
    expect(instanceName('standing')).toBe('standing')
    expect(() => instanceName('prod')).toThrow('no instance "prod"')
    expect(rigConfig({}, 1).instance).toBe('rig')
  })

  it('locks each instance on its own, and install on both', () => {
    expect(locksFor('up', cfg)).toEqual(['/srv/x/win-vm/.lock'])
    expect(locksFor('down', sCfg)).toEqual(['/srv/x/win-vm/standing/.lock'])
    expect(locksFor('install', cfg)).toEqual(['/srv/x/win-vm/standing/.lock', '/srv/x/win-vm/.lock'])
  })

  it('starts QEMU through sg kvm when the shell lacks the group', () => {
    expect(kvmWrapped('qemu', ['-name', "a b'c"], true)).toEqual(['qemu', ['-name', "a b'c"]])
    expect(kvmWrapped('qemu', ['-name', "a b'c"], false)).toEqual(['sg', ['kvm', '-c', `'qemu' '-name' 'a b'\\''c'`]])
  })
})

describe('what stands on the base', () => {
  let root = ''
  afterEach(() => root && rmSync(root, { recursive: true, force: true }))
  const touch = (f: string) => {
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, '')
  }

  it("lists the rig's finished snapshots and the standing machine's disk", () => {
    root = mkdtempSync(join(tmpdir(), 'winvm-'))
    expect(onTheBase(root)).toEqual([])
    touch(join(root, 'snapshots', 'half.part', 'disk.qcow2'))
    touch(join(root, 'run', 'disk.qcow2'))
    expect(onTheBase(root)).toEqual([])
    touch(join(root, 'snapshots', 'clean', 'FROM'))
    touch(join(root, 'standing', 'run', 'disk.qcow2'))
    expect(onTheBase(root)).toEqual(['snapshot clean', `the standing machine's disk (${join(root, 'standing', 'run', 'disk.qcow2')})`])
  })

  const bun = [join(homedir(), '.bun', 'bin', 'bun'), '/srv/agents/home/.bun/bin/bun'].find((b) => existsSync(b))
  it.skipIf(!bun || process.platform !== 'linux')('install --force refuses while the standing disk stands on the base', () => {
    root = mkdtempSync(join(tmpdir(), 'winvm-'))
    touch(join(root, 'base', 'READY'))
    touch(join(root, 'standing', 'run', 'disk.qcow2'))
    const r = spawnSync(bun!, [join(__dirname, 'vm.ts'), 'install', '--force'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, WINVM_DIR: root, WINVM_TPM_DIR: join(root, 'tpm') } })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("the standing machine's disk")
    expect(existsSync(join(root, 'base', 'READY'))).toBe(true)
    expect(existsSync(join(root, 'standing', '.lock')) && existsSync(join(root, '.lock'))).toBe(true)
  })

  it.skipIf(!bun || process.platform !== 'linux')("holds each instance's lock on its own: the rig's down runs while the standing machine's is held", () => {
    root = mkdtempSync(join(tmpdir(), 'winvm-'))
    touch(join(root, 'standing', '.lock'))
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, WINVM_DIR: root, WINVM_TPM_DIR: join(root, 'tpm') }
    const underStandingLock = (...args: string[]) => spawnSync('flock', [join(root, 'standing', '.lock'), bun!, join(__dirname, 'vm.ts'), ...args], { encoding: 'utf8', env })
    const standing = underStandingLock('down', '--instance', 'standing')
    expect(standing.status).toBe(75)
    expect(standing.stderr).toContain('another install, up, down, snapshot or fetch of the standing machine is running')
    const rig = underStandingLock('down')
    expect(rig.status).toBe(0)
    expect(rig.stdout).toContain('not running')
  })
})

describe('the TPM after a crash or a guest\'s own stop', () => {
  let root = ''
  afterEach(() => root && rmSync(root, { recursive: true, force: true }))
  function machine(instance: 'rig' | 'standing') {
    root = mkdtempSync(join(tmpdir(), 'winvm-'))
    const c = rigConfig({ WINVM_DIR: root, WINVM_TPM_DIR: join(root, 'live') }, 1, instance)
    const p = rigPaths(c)
    const write = (dir: string, body: string, at: number) => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'tpm2-00.permall'), body)
      utimesSync(join(dir, 'tpm2-00.permall'), at, at)
    }
    // As up and startTpm leave them: the run's id, and the live state marked with it.
    mkdirSync(p.run, { recursive: true })
    writeFileSync(p.runId, 'run-1\n')
    mkdirSync(c.tpmDir, { recursive: true })
    writeFileSync(p.tpmRunId, 'run-1')
    return { c, p, write }
  }

  it('prefers the live state when it is newer than the run\'s copy, rather than roll back', async () => {
    const { c, p, write } = machine('rig')
    write(p.runTpm, 'saved at the last clean stop', 1000)
    write(p.tpmState, 'changed after it (a PIN set up), then QEMU crashed', 2000)
    expect(liveTpmIsNewer(p)).toBe(true)
    expect(await keepLiveTpm(c, p)).toBe(true)
    expect(readFileSync(join(p.runTpm, 'tpm2-00.permall'), 'utf8')).toBe('changed after it (a PIN set up), then QEMU crashed')
    expect(liveTpmIsNewer(p)).toBe(false)
  })

  it("keeps the run's copy after a clean stop, and saves a first state for a run that has none", async () => {
    const { c, p, write } = machine('standing')
    write(p.tpmState, 'live', 1000)
    write(p.runTpm, 'copied at the clean stop', 2000)
    expect(await keepLiveTpm(c, p)).toBe(false)
    expect(readFileSync(join(p.runTpm, 'tpm2-00.permall'), 'utf8')).toBe('copied at the clean stop')
    rmSync(p.runTpm, { recursive: true })
    expect(await keepLiveTpm(c, p)).toBe(true)
    expect(readFileSync(join(p.runTpm, 'tpm2-00.permall'), 'utf8')).toBe('live')
  })

  it("never takes a live state started for another run, or for a run from before ids", async () => {
    const { c, p, write } = machine('rig')
    write(p.runTpm, 'this run, saved', 1000)
    write(p.tpmState, 'a later run, put aside by hand, or a restore point gone back past', 2000)
    writeFileSync(p.tpmRunId, 'run-2')
    expect(await keepLiveTpm(c, p)).toBe(false)
    writeFileSync(p.tpmRunId, '')
    rmSync(p.runId)
    expect(await keepLiveTpm(c, p)).toBe(false)
    expect(readFileSync(join(p.runTpm, 'tpm2-00.permall'), 'utf8')).toBe('this run, saved')
  })

  it('does nothing with no live state or no run', async () => {
    const { c, p, write } = machine('rig')
    write(p.runTpm, 'saved', 1000)
    expect(await keepLiveTpm(c, p)).toBe(false)
    rmSync(p.run, { recursive: true, force: true })
    write(p.tpmState, 'live', 1000)
    expect(await keepLiveTpm(c, p)).toBe(false)
  })
})

describe('qemuArgs', () => {
  const args = qemuArgs(cfg, paths, { disk: paths.runDisk, vars: paths.runVars })
  const joined = args.join(' ')
  const valueOf = (flag: string) => args.filter((_, i) => args[i - 1] === flag)

  it('binds every forward to 127.0.0.1 and uses user-mode networking only', () => {
    const net = valueOf('-netdev')[0]
    expect(net.startsWith('user,')).toBe(true)
    const fwds = net.split(',').filter((s) => s.startsWith('hostfwd='))
    expect(fwds).toEqual(['hostfwd=tcp:127.0.0.1:22220-:22', 'hostfwd=tcp:127.0.0.1:9333-:9333'])
    expect(joined).not.toMatch(/tap|bridge|0\.0\.0\.0/)
  })

  it('applies the caps, Secure Boot firmware, the TPM and QMP, with no display', () => {
    expect(valueOf('-smp')).toEqual(['8,sockets=1,cores=8,threads=1'])
    expect(valueOf('-m')).toEqual(['16G'])
    expect(joined).toContain('OVMF_CODE_4M.secboot.fd')
    expect(joined).toContain(`file=${paths.runVars}`)
    expect(joined).toContain('tpm-crb,tpmdev=tpm0')
    expect(valueOf('-qmp')).toEqual([`unix:${paths.qmp},server=on,wait=off`])
    expect(valueOf('-display')).toEqual(['none'])
    expect(args).toContain('-daemonize')
  })

  it('adds the ISO and the answer-file stick only for an install', () => {
    expect(joined).not.toContain('media=cdrom')
    const inst = qemuArgs(cfg, paths, { disk: paths.baseDisk, vars: paths.baseVars, install: { iso: '/i/w.iso', configDir: '/b/config' } }).join(' ')
    expect(inst).toContain('file=/i/w.iso,if=none,id=cd0,media=cdrom,readonly=on')
    expect(inst).toContain('file=fat:/b/config,if=none,id=cfg,format=raw,readonly=on')
    expect(inst).toContain(`file=${paths.baseDisk},`)
  })

  it('runs swtpm as a TPM 2.0 daemon that ends with QEMU', () => {
    const s = swtpmArgs(paths)
    expect(s.slice(0, 2)).toEqual(['socket', '--tpm2'])
    expect(s).toContain('--terminate')
    expect(s.join(' ')).toContain(`dir=${paths.tpmState}`)
  })
})

describe('the answer file', () => {
  const template = readFileSync(join(__dirname, 'autounattend.xml'), 'utf8')
  const values = { ADMIN_USER: 'tcadmin', ADMIN_PASSWORD: 'a<b&c', STANDARD_USER: 'tcuser', STANDARD_PASSWORD: 'p"q' }

  it('fills every field, escaped, and leaves none behind', () => {
    const xml = renderAnswerFile(template, values)
    expect(xml).not.toMatch(/\{\{[A-Z_]+\}\}/)
    expect(xml).toContain('<Value>a&lt;b&amp;c</Value>')
    expect(xml).toContain('<Name>tcuser</Name>')
    expect(xml).toContain('<Group>Users</Group>')
    expect(xml).not.toMatch(/<ProductKey>/)
  })

  it('refuses a missing value and an unused one', () => {
    const { ADMIN_USER: _, ...missing } = values
    expect(() => renderAnswerFile(template, missing)).toThrow('{{ADMIN_USER}}')
    expect(() => renderAnswerFile(template, { ...values, EXTRA: 'x' })).toThrow('EXTRA')
  })

  it('escapes all five XML characters', () => {
    expect(xmlEscape(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;')
  })

  it('makes passwords with every character class and nothing to escape', () => {
    const pw = makePassword(Buffer.alloc(24, 7))
    expect(pw).toHaveLength(24)
    expect(pw).toMatch(/[A-Z]/)
    expect(pw).toMatch(/[a-z]/)
    expect(pw).toMatch(/\d/)
    expect(pw).toMatch(/^[\w-]+$/)
    expect(makePassword()).not.toBe(makePassword())
  })
})

describe('guest commands', () => {
  it('encodes PowerShell as base64 of UTF-16LE', () => {
    expect(Buffer.from(encodePowerShell("'é'"), 'base64').toString('utf16le')).toBe("'é'")
  })

  it('quotes for PowerShell and for CommandLineToArgvW', () => {
    expect(psQuote("it's")).toBe("'it''s'")
    expect(winQuote('plain')).toBe('plain')
    expect(winQuote('two words')).toBe('"two words"')
    expect(winQuote('')).toBe('""')
    expect(winQuote('say "hi"')).toBe('"say \\"hi\\""')
    expect(winQuote('C:\\dir with space\\')).toBe('"C:\\dir with space\\\\"')
  })

  it('sends a script on stdin behind a short fixed command line', () => {
    const big = 'Write-Output "é"; ' + 'x'.repeat(20_000)
    const { command, input } = psStdin(big)
    expect(command.length).toBeLessThan(4000)
    expect(command).toBe(psStdin('other').command)
    expect(Buffer.from(input, 'base64').toString('utf8')).toBe(big)
    // The bootstrap keeps a failure's exit code: the script's own exit, a native program's, else 1 on an error.
    const boot = Buffer.from(command.split(' ').pop()!, 'base64').toString('utf16le')
    expect(boot).toContain('if ($LASTEXITCODE) { exit $LASTEXITCODE } elseif ($global:failed) { exit 1 }')
    expect(boot).toContain('*>&1')
  })

  it('starts a program in the session through an interactive scheduled task, not over ssh', () => {
    const s = runInSessionScript({ argv: ['notepad.exe', 'C:\\a b.txt'], wait: false, timeoutSec: 600 }, 'tc-run-1')
    expect(s).toContain('$def.Principal.LogonType = 3')
    expect(s).toContain('New-Object -ComObject Schedule.Service')
    expect(s).not.toContain('ScheduledTask ')
    expect(s).toContain("$action.Path = 'notepad.exe'")
    expect(s).toContain("$action.Arguments = '\"C:\\a b.txt\"'")
    expect(s).toContain("$name = 'tc-run-1'")
    expect(s).toContain('$wait = $false')
    expect(s).toContain('Fail 125')
    expect(s).toContain('Fail 126')
    expect(s).not.toContain('powershell.exe')
  })

  it('with --wait, runs the program from an encoded script and passes its exit code on', () => {
    const s = runInSessionScript({ argv: ['where', 'git'], wait: true, timeoutSec: 30, cwd: "C:\\it's" }, 'tc-run-2')
    expect(s).toContain("$action.Path = 'powershell.exe'")
    expect(s).toContain('$wait = $true')
    expect(s).toContain('AddSeconds(30)')
    expect(s).toContain('exit $res')
    expect(s).toContain("$action.WorkingDirectory = 'C:\\it''s'")
    const inner = Buffer.from(/-EncodedCommand (\S+)'/.exec(s)![1], 'base64').toString('utf16le')
    expect(inner).toBe(waitedProgramScript(['where', 'git'], 'tc-run-2'))
  })

  it('gives the waited program a command line Windows reads back as the same arguments', () => {
    const inner = waitedProgramScript(['%LOCALAPPDATA%\\app.exe', 'a&b', '100%', 'say "hi"', "it's"], 'tc-run-3')
    expect(inner).toContain("ExpandEnvironmentVariables('%LOCALAPPDATA%\\app.exe')")
    expect(inner).toContain(`$psi.Arguments = 'a&b 100% "say \\"hi\\"" it''s'`)
    expect(inner).toContain("'tc-run\\tc-run-3.out'")
    expect(inner).toContain('exit 127')
    expect(inner).toContain('exit $proc.ExitCode')
  })

  it('refuses an empty command', () => {
    expect(() => runInSessionScript({ argv: [], wait: false, timeoutSec: 1 }, 'tc-run-4')).toThrow()
  })
})

describe('Qmp', () => {
  let server: Server | null = null
  let dir = ''
  afterEach(() => {
    server?.close()
    server = null
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  /** A fake QEMU: greets, answers each line through `answer`, and records what it got. */
  async function fakeQemu(answer: (cmd: { execute: string; arguments?: unknown }) => string[]) {
    dir = mkdtempSync(join(tmpdir(), 'qmp-'))
    const sock = join(dir, 'qmp.sock')
    const got: unknown[] = []
    server = createServer((c) => {
      c.write('{"QMP": {"version": {}, "capabilities": []}}\r\n')
      let buf = ''
      c.on('data', (d) => {
        buf += d.toString()
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const cmd = JSON.parse(buf.slice(0, nl))
          buf = buf.slice(nl + 1)
          got.push(cmd)
          for (const line of answer(cmd)) c.write(line + '\r\n')
        }
      })
    })
    await new Promise<void>((r) => server!.listen(sock, r))
    return { sock, got }
  }

  it('negotiates, skips events, and returns each answer in order', async () => {
    const { sock, got } = await fakeQemu((cmd) =>
      cmd.execute === 'query-status' ? ['{"event": "RESUME", "timestamp": {}}', '{"return": {"status": "running"}}'] : ['{"return": {}}']
    )
    const out = await qmp(sock, { execute: 'query-status' }, screendump('/tmp/s.png'), sendKey('ret'))
    expect(out).toEqual([{ status: 'running' }, {}, {}])
    expect(got).toEqual([
      { execute: 'qmp_capabilities' },
      { execute: 'query-status' },
      { execute: 'screendump', arguments: { filename: '/tmp/s.png', format: 'png' } },
      { execute: 'send-key', arguments: { keys: [{ type: 'qcode', data: 'ret' }] } }
    ])
  })

  it('turns an error answer into a rejection', async () => {
    const { sock } = await fakeQemu((cmd) =>
      cmd.execute === 'qmp_capabilities' ? ['{"return": {}}'] : ['{"error": {"class": "GenericError", "desc": "no such file"}}']
    )
    const q = await Qmp.open(sock)
    await expect(q.run(screendump('/nope/x.png'))).rejects.toThrow('QMP GenericError: no such file')
    q.close()
  })
})
