import type { BoxDisplay } from './display'
import { XClient } from './xclient'

/**
 * The display's size changed live, by RandR, as `xrandr --newmode`, `--addmode` and `--output --mode` would
 * (docs/agents/live-video.md "The display"): the Windows VM's display follows the guest's mode. The bundled dummy
 * driver takes any size to 5120×2880 this way; its `Virtual` does not cap it. The box's browser never resizes.
 */

/** RandR's requests, by their minor opcodes. */
const RR = { queryVersion: 0, setScreenSize: 7, getCrtcInfo: 20, setCrtcConfig: 21, createMode: 16, addOutputMode: 18, getScreenResourcesCurrent: 25 } as const
/** -hsync +vsync, as display.ts's modeline. */
const MODE_FLAGS = 0x2 | 0x4
const ROTATE_0 = 1

export interface Size {
  width: number
  height: number
}

/** A mode's name: one per size, so a size asked again takes the mode it made before. */
export const modeName = (s: Size): string => `tc${s.width}x${s.height}`

/** RandR's MODEINFO for a size at a rate, with display.ts's small blanking: 32 bytes. */
export function modeInfo(s: Size, hz: number, nameLength: number): Buffer {
  const hTotal = s.width + 48
  const vTotal = s.height + 10
  const b = Buffer.alloc(32)
  b.writeUInt16LE(s.width, 4)
  b.writeUInt16LE(s.height, 6)
  b.writeUInt32LE(hTotal * vTotal * hz, 8)
  b.writeUInt16LE(s.width + 8, 12)
  b.writeUInt16LE(s.width + 24, 14)
  b.writeUInt16LE(hTotal, 16)
  b.writeUInt16LE(s.height + 3, 20)
  b.writeUInt16LE(s.height + 9, 22)
  b.writeUInt16LE(vTotal, 24)
  b.writeUInt16LE(nameLength, 26)
  b.writeUInt32LE(MODE_FLAGS, 28)
  return b
}

/** The screen's resources as GetScreenResourcesCurrent answers them: no probe of the outputs. */
export function parseResources(r: Buffer): { configTime: number; crtcs: number[]; modes: Map<string, number> } {
  const crtcs = r.readUInt16LE(16)
  const outputs = r.readUInt16LE(18)
  const count = r.readUInt16LE(20)
  let at = 32
  const list: number[] = []
  for (let i = 0; i < crtcs; i++, at += 4) list.push(r.readUInt32LE(at))
  at += outputs * 4
  let name = at + count * 32
  const modes = new Map<string, number>()
  for (let i = 0; i < count; i++, at += 32) {
    const length = r.readUInt16LE(at + 26)
    modes.set(r.toString('latin1', name, name + length), r.readUInt32LE(at))
    name += length
  }
  return { configTime: r.readUInt32LE(12), crtcs: list, modes }
}

/** A CRTC as GetCrtcInfo answers it: its mode (0 when off), its size and its outputs. */
export function parseCrtc(r: Buffer): { mode: number; width: number; height: number; outputs: number[] } {
  const n = r.readUInt16LE(28)
  return { mode: r.readUInt32LE(20), width: r.readUInt16LE(16), height: r.readUInt16LE(18), outputs: Array.from({ length: n }, (_, i) => r.readUInt32LE(32 + i * 4)) }
}

const u32 = (...values: number[]): Buffer => {
  const b = Buffer.alloc(values.length * 4)
  values.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4))
  return b
}
const mm = (px: number): number => Math.round((px * 25.4) / 96)

/** The screen at `size`: grown first where it grows, then the lit CRTC's mode, then the screen to the size itself. */
export async function setScreenSize(x: XClient, size: Size, hz: number): Promise<void> {
  const major = await x.extension('RANDR')
  if (major === null) throw new Error('the display has no RandR')
  await x.ask(major, RR.queryVersion, u32(1, 5))
  const res = parseResources(await x.ask(major, RR.getScreenResourcesCurrent, u32(x.root)))
  let lit: { id: number; outputs: number[] } | null = null
  for (const id of res.crtcs) {
    const crtc = parseCrtc(await x.ask(major, RR.getCrtcInfo, u32(id, res.configTime)))
    if (crtc.mode && crtc.outputs.length) {
      lit = { id, outputs: crtc.outputs }
      break
    }
  }
  if (!lit) throw new Error('the display has no lit output')
  const name = modeName(size)
  let mode = res.modes.get(name)
  if (mode === undefined) {
    const text = Buffer.from(name, 'latin1')
    const body = Buffer.concat([u32(x.root), modeInfo(size, hz, text.length), text, Buffer.alloc((4 - (text.length % 4)) % 4)])
    mode = (await x.ask(major, RR.createMode, body)).readUInt32LE(8)
  }
  for (const output of lit.outputs) await x.order(major, RR.addOutputMode, u32(output, mode))
  const screen = await x.geometry(x.root)
  const screenTo = async (s: Size): Promise<void> => {
    const body = Buffer.alloc(16)
    body.writeUInt32LE(x.root, 0)
    body.writeUInt16LE(s.width, 4)
    body.writeUInt16LE(s.height, 6)
    body.writeUInt32LE(mm(s.width), 8)
    body.writeUInt32LE(mm(s.height), 12)
    await x.order(major, RR.setScreenSize, body)
  }
  // the screen holds the CRTC at every step: larger first, the CRTC, then exactly the size
  const room = { width: Math.max(screen.width, size.width), height: Math.max(screen.height, size.height) }
  if (room.width !== screen.width || room.height !== screen.height) await screenTo(room)
  const config = Buffer.alloc(24 + lit.outputs.length * 4)
  config.writeUInt32LE(lit.id, 0)
  config.writeUInt32LE(0, 4)
  config.writeUInt32LE(res.configTime, 8)
  config.writeUInt32LE(mode, 16)
  config.writeUInt16LE(ROTATE_0, 20)
  lit.outputs.forEach((o, i) => config.writeUInt32LE(o, 24 + i * 4))
  const status = (await x.ask(major, RR.setCrtcConfig, config))[1]
  if (status !== 0) throw new Error(`the display refused ${size.width}×${size.height} (RandR status ${status})`)
  if (room.width !== size.width || room.height !== size.height) await screenTo(size)
}

/** Opens the display, sets its size, and closes it again. */
export async function resizeDisplay(pair: BoxDisplay, size: Size, hz: number): Promise<void> {
  const x = await XClient.open(pair)
  try {
    await setScreenSize(x, size, hz)
  } finally {
    x.close()
  }
}
