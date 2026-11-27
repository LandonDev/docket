// What the bones walks share (scripts/journeys/bones-walk.ts, bones-walk-work.ts; docs/agents/loading-bones.md
// "Proving a conversion"): what the window shows of bones in a frame, the film of one wait, and its checks.
import { join } from 'node:path'
import type { Window } from './window'

/** What the window shows of bones right now: regions waiting and shown, bars drawn, bars in the sweep, panes and copies on
 *  their way out. Only what is drawn counts: a tab parked behind the one on screen may hold a skeleton of its own. */
export const BONES_NOW = `(() => {
  const seen = (selector) => [...document.querySelectorAll(selector)].filter((el) => el.checkVisibility());
  const bars = seen('[skullet-layer]').flatMap((layer) => [...(layer.shadowRoot?.children ?? [])]);
  return {
    held: seen('[data-region][data-bones="held"]').length,
    shown: seen('[data-region][data-bones="shown"]').length,
    leaving: seen('[data-bones="leaving"], [skullet-exiting], [data-bones="copy"]').length,
    bars: bars.length,
    sweeping: bars.filter((bar) => bar.getAnimations().some((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations === Infinity)).length,
    hidden: document.hidden,
  };
})()`
export type Bones = { held: number; shown: number; leaving: number; bars: number; sweeping: number; hidden: boolean }
export type Frame = { at: number; bones: Bones; landed: boolean }

/** Films `page` from now until `landed` has been true for `settle` ms, reading the bones beside each frame; the frames go to `out`. */
export async function film(page: Window, out: string, name: string, landed: () => Promise<boolean>, { settle = 900, most = 12_000 } = {}): Promise<Frame[]> {
  const start = Date.now()
  const frames: Frame[] = []
  let landedAt = 0
  while (Date.now() - start < most) {
    const at = Date.now() - start
    const [bones, done] = await Promise.all([page.eval<Bones>(BONES_NOW), landed().catch(() => false)])
    await page.shot(join(out, `${name}-${String(at).padStart(5, '0')}.png`))
    frames.push({ at, bones, landed: done })
    if (done && !landedAt) landedAt = Date.now()
    if (landedAt && Date.now() - landedAt > settle) break
  }
  return frames
}

/** The checks every filmed wait must pass. `mayBeQuick`: a page whose read may answer inside the hold, and then rightly
 *  shows no bones. `others`: the screen holds other regions with reads of their own, so bones may still stand once this one has landed. */
export function judge(check: (name: string, ok: boolean, detail?: string) => void, log: (line: string) => void, name: string, frames: Frame[], { mayBeQuick = false, others = false } = {}): void {
  // With other regions on the screen, bones are looked for in every frame: theirs stand after this one has landed.
  const waiting = others ? frames : frames.filter((frame) => !frame.landed)
  const most = waiting.reduce((best, frame) => (frame.bones.bars > best.bones.bars ? frame : best), waiting[0] ?? frames[0])
  const showed = waiting.some((frame) => frame.bones.shown > 0 && frame.bones.bars > 0)
  if (showed || !mayBeQuick) {
    check(`${name}: bones showed while the read was out`, showed, `${most?.bones.bars ?? 0} bars at ${most?.at ?? 0} ms`)
    check(`${name}: every bone was in the sweep`, waiting.some((frame) => frame.bones.bars > 0 && frame.bones.sweeping === frame.bones.bars), `${most?.bones.sweeping ?? 0} of ${most?.bones.bars ?? 0}`)
  } else log(`      ${name}: its read answered inside the hold, so no bones showed`)
  const last = frames.at(-1)!
  check(`${name}: the content landed`, last.landed, `after ${frames.find((frame) => frame.landed)?.at ?? -1} ms`)
  if (others) check(`${name}: no bones were left on their way out`, last.bones.leaving === 0, JSON.stringify(last.bones))
  else check(`${name}: no bone outlived it`, last.bones.shown === 0 && last.bones.leaving === 0 && last.bones.bars === 0, JSON.stringify(last.bones))
}
