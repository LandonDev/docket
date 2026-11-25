import { describe, expect, it } from 'vitest'
import { ANON_MAX_BYTES, anonBytes, DONE_FILE, holdEnd, instanceEnv, mergeToolStates, otherScratchVms, pairLine, pairMinutes } from './vmScreenMac'

describe("M8's isolated instance", () => {
  const o = { root: '/tmp/vm-screen-mac-x', data: '/tmp/vm-screen-mac-x/data', home: '/tmp/vm-screen-mac-x/home', remotePort: 41234, exe: null, uid: 1001 }

  it("carries no mark of the live app and asks for the throwaway machine; the scratch machine's three pass through", () => {
    const env = instanceEnv(
      { PATH: '/usr/bin', TEMP_CODE_THREAD: 't1', TEMP_CODE_USER_DATA: '/srv/agents/temp-code-data', CLAUDE_PID: '9', ANTHROPIC_API_KEY: 'k', CODEX_HOME: '/h', ELECTRON_RUN_AS_NODE: '1', XDG_RUNTIME_DIR: '/run/user/0', WINVM_DIR: '/dev/shm/m8', WINVM_TPM_DIR: '/tmp/m8-tpm', WINVM_SSH_PORT: '22251' },
      o
    )
    expect(env.TEMP_CODE_THREAD).toBeUndefined()
    expect(env.CLAUDE_PID).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.XDG_RUNTIME_DIR).toBeUndefined()
    expect(env).toMatchObject({ PATH: '/usr/bin', TEMP_CODE_USER_DATA: o.data, HOME: o.home, TEMP_CODE_REMOTE_PORT: '41234', TEMP_CODE_HEADLESS: '1', CODEX_HOME: `${o.home}/.codex`, WINVM_THROWAWAY: '1', WINVM_DIR: '/dev/shm/m8', WINVM_TPM_DIR: '/tmp/m8-tpm', WINVM_SSH_PORT: '22251' })
    expect(env.TEMP_CODE_WINVM_EXE).toBeUndefined()
    expect(instanceEnv({ XDG_RUNTIME_DIR: '/run/user/1001' }, { ...o, exe: '/x/tc-computer.exe' })).toMatchObject({ XDG_RUNTIME_DIR: '/run/user/1001', TEMP_CODE_WINVM_EXE: '/x/tc-computer.exe' })
  })

  it("reads the box's tools, and the run's cache for what it installed", () => {
    const box = { platform: 'linux-x64', tools: { ffmpeg: { ok: true, dir: 'ffmpeg/8' }, 'virtio-win': { ok: false } } }
    expect(mergeToolStates(box, { tools: { 'virtio-win': { ok: true, dir: 'virtio-win/0.1.302' }, broken: { ok: false } } })).toEqual({ platform: 'linux-x64', tools: { ffmpeg: { ok: true, dir: 'ffmpeg/8' }, 'virtio-win': { ok: true, dir: 'virtio-win/0.1.302' } } })
    expect(mergeToolStates(box, null)).toEqual(box)
  })
})

describe('the rules before a machine starts', () => {
  it("reads the slice's anonymous memory against the rig's 38 GiB", () => {
    expect(anonBytes('file 10\nanon 41231686041\nkernel 5\n')).toBe(41231686041)
    expect(anonBytes('file 10\n')).toBeNull()
    expect(41231686041 >= ANON_MAX_BYTES).toBe(true)
  })

  it("finds another scratch machine, never the owner's standing one", () => {
    const procs = [
      { pid: 1, comm: 'tc-win11-stand', cmdline: 'qemu-system-x86_64 -drive file=/srv/agents/win-vm/standing/run/disk.qcow2' },
      { pid: 2, comm: 'tc-win11-stand', cmdline: 'qemu-system-x86_64 -drive file=/dev/shm/other/standing/run/disk.qcow2' },
      { pid: 3, comm: 'tc-win11', cmdline: 'qemu-system-x86_64 -drive file=/dev/shm/rig/run/disk.qcow2' },
      { pid: 4, comm: 'bash', cmdline: 'bash' }
    ]
    expect(otherScratchVms(procs)).toEqual([2, 3])
    expect(otherScratchVms(procs.slice(0, 1))).toEqual([])
  })
})

describe('the hold', () => {
  it("ends at the Mac's DONE, else at the run's 30 minutes", () => {
    expect(holdEnd({ done: false, now: 10, deadline: 20 })).toBeNull()
    expect(holdEnd({ done: true, now: 10, deadline: 20 })).toBe('the Mac side is done')
    expect(holdEnd({ done: false, now: 20, deadline: 20 })).toBe('the run reached its 30 minutes')
  })

  it("gives the code the run's time left, in whole minutes from 1 to 30", () => {
    expect(pairMinutes(0, 45 * 60_000)).toBe(30)
    expect(pairMinutes(0, 12.5 * 60_000)).toBe(12)
    expect(pairMinutes(0, 20_000)).toBe(1)
  })

  it('prints what the Mac needs as one JSON line: the tunnel on the same port, the code and its link, the end', () => {
    const line = pairLine({ port: 41234, code: 'ABCDE-FGHIJ', codeExpires: Date.UTC(2026, 10, 25, 7, 10), holdsUntil: Date.UTC(2026, 10, 25, 7, 30), vm: { device: 'virtio', hwCursor: true } })
    expect(line).not.toContain('\n')
    expect(JSON.parse(line)).toEqual({
      m8: 'pair',
      ssh: 'ssh -N -L 41234:127.0.0.1:41234 box',
      origin: 'http://127.0.0.1:41234',
      code: 'ABCDE-FGHIJ',
      link: 'http://127.0.0.1:41234/pair#ABCDE-FGHIJ',
      codeExpires: '2026-11-25T07:10:00.000Z',
      holdsUntil: '2026-11-25T07:30:00.000Z',
      done: `ssh box touch ${DONE_FILE}`,
      vm: { device: 'virtio', hwCursor: true }
    })
  })
})
