import { describe, expect, it } from 'vitest'
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
