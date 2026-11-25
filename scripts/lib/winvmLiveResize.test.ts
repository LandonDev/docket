import { describe, expect, it } from 'vitest'
import { partOf, qemuDevice, report, saidInOrder, stepsSeen, UPGRADE_WORDS, valueOf } from './winvmLiveResize'

/** The live resize proof's pure parts (scripts/e2e-winvm-liveresize.ts): what it reads, and how it reports. */

describe('the live resize proof', () => {
  it("hears Turn on's six steps in order, a repeat and the settled pushes dropped", () => {
    const pushed = [null, ...UPGRADE_WORDS.flatMap((w) => [w, w]), null]
    const seen = stepsSeen(pushed)
    expect(seen).toEqual(UPGRADE_WORDS)
    expect(saidInOrder(seen, UPGRADE_WORDS)).toBe(true)
    // the keeper's own wake words between them do not break the order; a step missing or out of place does
    expect(saidInOrder(['Waking the Windows VM', ...seen], UPGRADE_WORDS)).toBe(true)
    expect(saidInOrder(seen.filter((s) => s !== 'Saving a restore point'), UPGRADE_WORDS)).toBe(false)
    expect(saidInOrder([seen[1]!, seen[0]!, ...seen.slice(2)], UPGRADE_WORDS)).toBe(false)
  })

  it("reads QEMU's display device from its command line", () => {
    expect(qemuDevice(['qemu-system-x86_64', '-vga', 'none', '-device', 'virtio-vga,edid=on,xres=1280,yres=800', '-display', 'gtk'].join('\0'))).toBe('virtio')
    expect(qemuDevice(['qemu-system-x86_64', '-vga', 'std', '-display', 'none'].join('\0'))).toBe('vga')
    expect(qemuDevice(['qemu-system-x86_64', '-vga', 'none'].join('\0'))).toBeNull()
  })

  it("reads a value the guest printed, its last line", () => {
    expect(valueOf('noise\r\nhwcursor=0\r\nhwcursor=1\r\n', 'hwcursor')).toBe('1')
    expect(valueOf('ibeam=C:\\ProgramData\\TempCode\\tc-ibeam.cur\r\n', 'ibeam')).toBe('C:\\ProgramData\\TempCode\\tc-ibeam.cur')
    expect(valueOf('nothing', 'hwcursor')).toBeNull()
  })

  it('runs one part at a time, named', () => {
    expect(partOf(['bun', 'x.ts', '--part', '2'])).toBe(2)
    expect(() => partOf(['bun', 'x.ts'])).toThrow('--part 1')
    expect(() => partOf(['bun', 'x.ts', '--part', '3'])).toThrow('--part 1')
  })

  it('reports every check, a failed one by name; a record with no check never fails it', () => {
    const rows = [
      { part: 1 as const, step: 'turn on: steps', ok: true, detail: '', at: 1 },
      { part: 1 as const, step: 'turn on: took', ok: null, detail: '95 s', at: 2 },
      { part: 1 as const, step: 'turn off: vga', ok: false, detail: 'virtio', at: 3 }
    ]
    expect(report(1, rows, null)).toMatchObject({ ok: false, failed: ['turn off: vga'] })
    expect(report(1, rows.slice(0, 2), null).ok).toBe(true)
    expect(report(1, rows.slice(0, 2), 'Windows did not come up').ok).toBe(false)
  })
})
