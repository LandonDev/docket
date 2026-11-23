import type { SlideBuilds, SlideTransition, StepHides } from '@shared/contract-work-slides'

/**
 * A slide's timing tree to the show's steps (docs/agents/work-slides.md "Builds"). Pure: the deck tool hands the
 * slide's `p:timing` over as a plain tree (`timing_of` in deckScript.ts) and this reads it only where it is sure:
 * the main sequence of presses whose effects are entrances and exits of whole shapes or of a shape's paragraphs,
 * with-previous and after-previous folded into their press. Anything else (a trigger, an emphasis or a motion path
 * that changes where things end, a part of a shape it does not know, a nesting it does not know) makes the slide one
 * step, shown whole. PowerPoint's own play and pause on a press of a video is left to the show's transport.
 */

/** One element of `p:timing`: its local name, attributes, children and text. */
export interface TimingNode {
  t: string
  a?: Record<string, string>
  c?: TimingNode[]
  x?: string
  /** the tree was cut short: past the deck tool's cap */
  over?: true
}

/** What the reader needs of a slide's shapes: ids, the outer group each is in, and how many paragraphs a text shape has. */
export interface BuildShape {
  id: number
  kind?: string
  group?: number
  text?: string
}

const kids = (n: TimingNode | undefined, t?: string): TimingNode[] => (n?.c ?? []).filter((c) => t === undefined || c.t === t)
const child = (n: TimingNode | undefined, t: string): TimingNode | undefined => kids(n, t)[0]
function* all(n: TimingNode): Generator<TimingNode> {
  yield n
  for (const c of n.c ?? []) yield* all(c)
}
/** Every effect under a node: a time node that names its preset class. */
const effectsIn = (n: TimingNode): TimingNode[] => [...all(n)].filter((e) => e.t === 'cTn' && e.a?.presetClass)

/** Entrances and exits shown as authored, near enough: Appear, and Fade (the show's own 240 ms fade). */
const PLAIN = new Set(['1', '10'])

class Unsure extends Error {}

/** When a time node starts: on a press, by itself (a delay), or something else the reader does not know. */
function startOf(ctn: TimingNode): 'press' | 'auto' {
  const conds = kids(child(ctn, 'stCondLst'), 'cond')
  if (conds.length !== 1 || conds[0].a?.evt || kids(conds[0]).length) throw new Unsure('a start the reader does not know')
  const delay = conds[0].a?.delay ?? '0'
  if (delay === 'indefinite') return 'press'
  if (/^\d+$/.test(delay)) return 'auto'
  throw new Unsure('a start the reader does not know')
}

/** The one element an effect works on: a whole shape, or a run of its paragraphs. */
type Target = { shape: number; paras?: [number, number] }

function targetOf(effect: TimingNode): Target {
  const tgts = [...all(effect)].filter((n) => n.t === 'tgtEl')
  let got: Target | null = null
  for (const tgt of tgts) {
    const sp = kids(tgt)
    if (sp.length !== 1 || sp[0].t !== 'spTgt') throw new Unsure('an effect on something other than a shape')
    const shape = Number(sp[0].a?.spid)
    if (!Number.isInteger(shape)) throw new Unsure('an effect on a shape with no id')
    const inner = kids(sp[0])
    let paras: [number, number] | undefined
    if (inner.length) {
      const rg = inner.length === 1 && inner[0].t === 'txEl' ? kids(inner[0]) : []
      if (rg.length !== 1 || rg[0].t !== 'pRg') throw new Unsure('an effect on a part of a shape the reader does not know')
      const [st, end] = [Number(rg[0].a?.st), Number(rg[0].a?.end)]
      if (!Number.isInteger(st) || !Number.isInteger(end) || st < 0 || end < st) throw new Unsure('a paragraph range the reader does not know')
      paras = [st, end]
    }
    const t: Target = paras ? { shape, paras } : { shape }
    if (got && (got.shape !== t.shape || got.paras?.[0] !== t.paras?.[0] || got.paras?.[1] !== t.paras?.[1])) throw new Unsure('one effect on two things')
    got = t
  }
  if (!got) throw new Unsure('an effect on nothing')
  return got
}

/** An effect that leaves things as they were when it ends: it plays and goes back (auto-reverse) or is not held. */
const goesBack = (effect: TimingNode): boolean => {
  const timed = [...all(effect)].filter((n) => n.t === 'cTn' && n !== effect)
  return effect.a?.autoRev === '1' || effect.a?.fill === 'remove' || (timed.length > 0 && timed.every((n) => n.a?.autoRev === '1' || n.a?.autoRev === 'true'))
}

type Act = { show: boolean; target: Target } | null

/** One effect: what it does to what is seen, or null for one the show leaves out; `changed` counts it when the show does not play it as authored. */
function actOf(effect: TimingNode, count: { changed: number }): Act {
  const kind = effect.a?.presetClass
  if (kind === 'entr' || kind === 'exit') {
    if (effect.a?.autoRev === '1' || effect.a?.fill === 'remove' || effect.a?.repeatCount) throw new Unsure('an entrance or exit that undoes itself')
    if (!PLAIN.has(effect.a?.presetID ?? '')) count.changed++
    return { show: kind === 'entr', target: targetOf(effect) }
  }
  if (kind === 'emph' || kind === 'path') {
    if (!goesBack(effect)) throw new Unsure(kind === 'emph' ? 'an emphasis that changes where things end' : 'a motion path')
    count.changed++
    return null
  }
  if (kind === 'mediacall') {
    count.changed++
    return null
  }
  throw new Unsure('an effect the reader does not know')
}

const keyOf = (shape: number, para?: number): string => (para === undefined ? `s:${shape}` : `p:${shape}:${para}`)

/** The builds of a slide from its timing tree; null when it has none worth a step (no timing, or nothing but media nodes). */
export function buildsOf(timing: TimingNode | undefined, shapes: readonly BuildShape[]): SlideBuilds | null {
  if (!timing) return null
  const count = { changed: 0 }
  try {
    return read(timing, shapes, count)
  } catch (err) {
    if (!(err instanceof Unsure)) throw err
    // Every effect the file holds is played otherwise here: the slide is shown as its picture, in one press.
    const effects = timing.over ? 1 : effectsIn(timing).filter((e) => !isMediaToggle(e, shapes)).length
    return { steps: [{ shapes: [], paras: [] }], changed: Math.max(1, effects), whole: err.message }
  }
}

/** PowerPoint's own play and pause on a press of a video or sound: the show's transport does that. */
function isMediaToggle(effect: TimingNode, shapes: readonly BuildShape[]): boolean {
  if (effect.a?.presetClass !== 'mediacall') return false
  try {
    const t = targetOf(effect)
    return !t.paras && shapes.some((s) => s.id === t.shape && s.kind === 'media')
  } catch {
    return false
  }
}

function read(timing: TimingNode, shapes: readonly BuildShape[], count: { changed: number }): SlideBuilds | null {
  if (timing.over) throw new Unsure('a timing too long to read')
  const root = child(child(child(timing, 'tnLst'), 'par'), 'cTn')
  if (!root || root.a?.nodeType !== 'tmRoot') throw new Unsure('a timing the reader does not know')
  let main: TimingNode | undefined
  // Whether the timing is no more than a `builds` edit writes (`SlideBuilds.order`): each press brings in one whole
  // shape by Appear, nothing starts by itself, and there is no media node or trigger beside the main sequence.
  let plain = true
  const order: number[] = []
  for (const part of kids(child(root, 'childTnLst'))) {
    plain &&= part.t === 'seq'
    // a video's or a sound's own node: how loud, whether it loops; the show's transport plays it
    if (part.t === 'video' || part.t === 'audio') continue
    const ctn = child(part, 'cTn')
    if (part.t === 'seq' && ctn?.a?.nodeType === 'mainSeq' && !main) main = ctn
    else if (part.t === 'seq' && ctn?.a?.nodeType === 'interactiveSeq' && effectsIn(ctn).every((e) => isMediaToggle(e, shapes))) plain = false
    else throw new Unsure(part.t === 'seq' && ctn?.a?.nodeType === 'interactiveSeq' ? 'a trigger' : 'a timing the reader does not know')
  }

  const ids = new Set(shapes.map((s) => s.id))
  const groups = new Set(shapes.flatMap((s) => (s.group !== undefined ? [s.group] : [])))
  const paraCount = new Map(shapes.map((s) => [s.id, s.kind === 'text' || s.text ? (s.text ?? '').split('\n').length : 0]))
  // Each press: what it shows and takes away, in order. The first is the slide as it comes (what starts by itself).
  const presses: Array<Array<{ show: boolean; keys: string[] }>> = [[]]
  for (const press of kids(child(main, 'childTnLst'))) {
    const ctn = child(press, 'cTn')
    if (press.t !== 'par' || !ctn) throw new Unsure('a nesting the reader does not know')
    // A group that starts by itself plays at the end of the press before it (or as the slide comes): one press.
    if (startOf(ctn) === 'press') presses.push([])
    else plain = false
    const acts = presses[presses.length - 1]
    const times = kids(child(ctn, 'childTnLst'))
    const fxs = kids(child(child(times[0], 'cTn'), 'childTnLst'))
    plain &&= times.length === 1 && fxs.length === 1
    for (const time of times) {
      const tctn = child(time, 'cTn')
      if (time.t !== 'par' || !tctn || tctn.a?.presetClass) throw new Unsure('a nesting the reader does not know')
      startOf(tctn)
      for (const fx of kids(child(tctn, 'childTnLst'))) {
        const e = child(fx, 'cTn')
        if (fx.t !== 'par' || !e?.a?.presetClass) throw new Unsure('a nesting the reader does not know')
        startOf(e)
        const act = actOf(e, count)
        if (!act) {
          plain = false
          continue
        }
        const { shape, paras } = act.target
        if (!paras && !ids.has(shape) && !groups.has(shape)) throw new Unsure('an effect on a shape the reader does not know')
        if (paras) {
          const n = paraCount.get(shape) ?? 0
          if (!n || paras[1] >= n) throw new Unsure('an effect on a paragraph the reader does not know')
        }
        if (plain && !paras && act.show && e.a?.presetID === '1' && ids.has(shape) && shapes.find((s) => s.id === shape)?.group === undefined) order.push(shape)
        else plain = false
        const keys = paras ? Array.from({ length: paras[1] - paras[0] + 1 }, (_, i) => keyOf(shape, paras[0] + i)) : [keyOf(shape)]
        acts.push({ show: act.show, keys })
      }
    }
  }
  // What an effect works on starts hidden when its first effect brings it in, and seen when its first takes it away.
  const seen = new Map<string, boolean>()
  for (const acts of presses) for (const { show, keys } of acts) for (const k of keys) if (!seen.has(k)) seen.set(k, !show)
  if (seen.size === 0 && count.changed === 0) return null
  const steps: StepHides[] = []
  for (const acts of presses) {
    for (const { show, keys } of acts) for (const k of keys) seen.set(k, show)
    steps.push(hidesOf(seen))
  }
  return { steps, changed: count.changed, ...(plain && order.length === presses.length - 1 && new Set(order).size === order.length ? { order } : {}) }
}

/** What is unseen, as shapes and runs of paragraphs; a paragraph of a shape that is itself unseen is not named again. */
function hidesOf(seen: ReadonlyMap<string, boolean>): StepHides {
  const shapes = [...seen].flatMap(([k, on]) => (!on && k.startsWith('s:') ? [Number(k.slice(2))] : [])).sort((a, b) => a - b)
  const gone = new Set(shapes)
  const byShape = new Map<number, number[]>()
  for (const [k, on] of seen) {
    if (on || !k.startsWith('p:')) continue
    const [, s, p] = k.split(':').map(Number)
    if (!gone.has(s)) byShape.set(s, [...(byShape.get(s) ?? []), p])
  }
  const paras: StepHides['paras'] = []
  for (const [shape, list] of [...byShape].sort((a, b) => a[0] - b[0])) {
    const sorted = [...new Set(list)].sort((a, b) => a - b)
    for (const p of sorted) {
      const last = paras[paras.length - 1]
      if (last && last.shape === shape && last.to === p - 1) last.to = p
      else paras.push({ shape, from: p, to: p })
    }
  }
  return { shapes, paras }
}

/** The transitions the show plays as the file has them; any other is a cut, and counted as changed. */
export const PLAYED_TRANSITIONS = new Set(['fade', 'push', 'cut', 'none'])
export const transitionChanged = (t: SlideTransition | undefined): number => (t && !PLAYED_TRANSITIONS.has(t.kind) ? 1 : 0)

/** Whether nothing is unseen at a step: its picture is the slide's own. */
export const nothingHidden = (h: StepHides): boolean => h.shapes.length === 0 && h.paras.length === 0

/** Reads every slide's builds into the outline (`SlideInfo.builds`), once; a slide with none keeps none. */
export function withBuilds<T extends { slides: Array<{ timing?: TimingNode; shapes: BuildShape[]; builds?: SlideBuilds }> }>(info: T): T {
  for (const s of info.slides) {
    if (s.builds || !s.timing) continue
    const b = buildsOf(s.timing, s.shapes)
    if (b) s.builds = b
  }
  return info
}
