import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makePassword, renderAnswerFile, xmlEscape } from './answer'
import { daemonEnv, rigConfig, rigPaths, snapshotName } from './config'
import { encodePowerShell, psQuote, psStdin, runInSessionScript, waitedProgramScript, winQuote } from './guest'
import { qemuArgs, swtpmArgs } from './qemu'
import { Qmp, qmp, screendump, sendKey } from './qmp'

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
