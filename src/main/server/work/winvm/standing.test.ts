import { describe, expect, it } from 'vitest'
import { throwawayHost } from './machine/config'
import { pngSize, StandingMachine } from './standing'

/** A throwaway machine's disk takes cache=unsafe and survives no crash: the flag never reaches a machine outside a scratch root. */
describe('a throwaway machine', () => {
  const scratch = { WINVM_DIR: '/dev/shm/vm-screen-rig-t', WINVM_TPM_DIR: '/tmp/win-vm-tpm-vmscreen-t', WINVM_SSH_PORT: '22249' }

  it('is refused on the owner\'s machine, with any of the scratch environment unset', () => {
    expect(() => new StandingMachine('standing', {}, null, () => {}, { throwaway: true })).toThrow('a throwaway machine needs a scratch root')
    expect(() => new StandingMachine('standing', { ...scratch, WINVM_DIR: '/srv/agents/win-vm' }, null, () => {}, { throwaway: true })).toThrow("the owner's machines' folder")
    expect(() => new StandingMachine('standing', { ...scratch, WINVM_SSH_PORT: '22230' }, null, () => {}, { extra: () => [] })).toThrow("the owner's machine's")
  })

  it('is made on a scratch root, and a plain machine never asks', () => {
    expect(new StandingMachine('standing', scratch, null, () => {}, { throwaway: true }).c.dir).toBe('/dev/shm/vm-screen-rig-t/standing')
    expect(new StandingMachine('standing', {}).c.dir).toBe('/srv/agents/win-vm/standing')
  })
})

/** An isolated instance's keeper asks for a throwaway machine by WINVM_THROWAWAY=1; the owner's never gets one. */
describe('the host\'s throwaway switch', () => {
  const scratch = { WINVM_DIR: '/dev/shm/vm-screen-mac/root', WINVM_TPM_DIR: '/tmp/vm-screen-mac/tpm', WINVM_SSH_PORT: '22251', WINVM_THROWAWAY: '1' }
  const same = (p: string): string => p

  it('is off when nobody asks, on any machine', () => {
    expect(throwawayHost({}, 999, same)).toEqual({ throwaway: false, refused: null })
    expect(throwawayHost({ ...scratch, WINVM_THROWAWAY: undefined }, 999, same)).toEqual({ throwaway: false, refused: null })
  })

  it('is refused on the owner\'s machine: his root, TPM folder or port, or any of them unset', () => {
    expect(throwawayHost({ WINVM_THROWAWAY: '1' }, 999, same).refused).toMatch(/not set: the machine would be the owner's/)
    expect(throwawayHost({ ...scratch, WINVM_DIR: '/srv/agents/win-vm' }, 999, same).refused).toMatch(/the owner's machines' folder/)
    expect(throwawayHost({ ...scratch, WINVM_TPM_DIR: '/tmp/win-vm-tpm-999-standing' }, 999, same).refused).toMatch(/the owner's TPM folder/)
    expect(throwawayHost({ ...scratch, WINVM_SSH_PORT: '22230' }, 999, same).refused).toMatch(/the owner's machine's/)
    expect(throwawayHost({ ...scratch, WINVM_SSH_PORT: undefined }, 999, same).throwaway).toBe(false)
  })

  it('is refused on a scratch root on the box\'s disk, by its real path', () => {
    expect(throwawayHost({ ...scratch, WINVM_DIR: '/tmp/vm-screen-mac/root' }, 999, same)).toEqual({ throwaway: false, refused: 'WINVM_DIR /tmp/vm-screen-mac/root is not under /dev/shm' })
    expect(throwawayHost(scratch, 999, (p) => p.replace('/dev/shm/', '/srv/agents/win-vm/')).refused).toMatch(/the owner's machines' folder/)
  })

  it('is granted on a scratch machine in memory, and makes a machine there', () => {
    expect(throwawayHost(scratch, 999, same)).toEqual({ throwaway: true, refused: null })
    expect(new StandingMachine('standing', scratch, null, () => {}, { throwaway: true }).c.dir).toBe('/dev/shm/vm-screen-mac/root/standing')
  })
})

describe("QMP's picture after live resize's start", () => {
  it("reads a PNG's size from its header, and nothing from what is not one", () => {
    const png = Buffer.alloc(33)
    png.write('\x89PNG\r\n\x1a\n', 0, 'latin1')
    png.writeUInt32BE(13, 8)
    png.write('IHDR', 12, 'latin1')
    png.writeUInt32BE(1280, 16)
    png.writeUInt32BE(800, 20)
    expect(pngSize(png)).toEqual({ width: 1280, height: 800 })
    png.writeUInt32BE(0, 16)
    expect(pngSize(png)).toBeNull()
    expect(pngSize(Buffer.from('not a picture'))).toBeNull()
  })
})
