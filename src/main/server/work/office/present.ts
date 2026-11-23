import type { CanvasSource } from '@shared/work'
import { FenceError } from '../../remote/fence'
import type { Caller, WorkCtx } from '../modules'
import type { OfficeCarrier } from './carrier'
import type { RenderPlace } from './render'

/**
 * Presenting in PowerPoint (docs/agents/work-office.md "Presenting in PowerPoint"): on his press, a deck opens in
 * desktop PowerPoint on the computer its file is on, and PowerPoint's own slideshow runs from the first slide. The
 * Present menu's "In PowerPoint" row asks first whether it can (`check`), and is absent where it cannot.
 *
 * Where: his Mac (by osascript), a Windows PC of his, or the box's Windows VM for a file in its OneDrive (by
 * tc-office.exe). A place offers it only once its own live proof passed there (`PRESENT_PROVEN`), as a render pair
 * does (render.ts `RENDER_PROVEN`). A thread never presents.
 */

/**
 * The places that offer it: a place joins once its own live proof passed and the show would run where he is. Run
 * live in the box's VM and on his Mac on 2026-11-23 (docs/agents/work-office.md "Not proven" says where each
 * stands and what one more run must show); neither is offered yet. Turning a place on is this one line.
 */
export const PRESENT_PROVEN: ReadonlySet<RenderPlace> = new Set<RenderPlace>([])

export const PRESENT_WORDS = {
  thread: 'A thread never presents.',
  elsewhere: 'That deck presents on the computer it is on.',
  notDeck: 'Only a deck presents in PowerPoint.',
  none: 'PowerPoint is not in reach on the computer this deck is on.'
} as const

export interface PresentDeps {
  /** which carrier would present a file at `path` (null: a web address) here; null where none could */
  place(path: string | null): RenderPlace | null
  carrier(place: RenderPlace): OfficeCarrier | null
  /** the VM: whether Office is there (as last read), and waking it for his press */
  vmOffice?(): boolean
  wake?(): Promise<void>
  proven?: ReadonlySet<RenderPlace>
}

type Ref = { kind: 'path'; path: string } | { kind: 'url'; url: string }
const DECK = /\.(pptx|pptm|ppt|ppsx|pps|potx|odp)$/i

/** The deck's file as a carrier names it; refused in words for anything else, or a file the caller could not name. */
function refOf(ctx: Pick<WorkCtx, 'host' | 'reaches'>, by: Caller, source: CanvasSource): Ref {
  if (by.kind === 'model') throw new Error(PRESENT_WORDS.thread)
  if (source.at === 'microsoft') {
    if (source.app !== 'powerpoint') throw new Error(PRESENT_WORDS.notDeck)
    if (source.host !== ctx.host) throw new Error(PRESENT_WORDS.elsewhere)
    if (source.ref.kind === 'path' && !ctx.reaches(by, source.ref.path)) throw new FenceError('work.office.present')
    return source.ref
  }
  if (source.at !== 'file' || !DECK.test(source.path)) throw new Error(PRESENT_WORDS.notDeck)
  if (source.host !== ctx.host) throw new Error(PRESENT_WORDS.elsewhere)
  if (!ctx.reaches(by, source.path)) throw new FenceError('work.office.present')
  return { kind: 'path', path: source.path }
}

/** The carrier that would present this deck here, or null where none can now. Never wakes anything, never starts an app. */
async function carrierFor(ref: Ref, deps: PresentDeps): Promise<{ place: RenderPlace; carrier: OfficeCarrier } | null> {
  const place = deps.place(ref.kind === 'path' ? ref.path : null)
  if (!place || !(deps.proven ?? PRESENT_PROVEN).has(place)) return null
  const carrier = deps.carrier(place)
  if (!carrier?.present) return null
  if (place === 'vm') return deps.vmOffice?.() ? { place, carrier } : null
  const apps = await carrier.apps().catch(() => [])
  return apps.some((a) => a.app === 'powerpoint' && a.installed) ? { place, carrier } : null
}

/** Whether "In PowerPoint" may be offered for this deck to this caller. */
export async function canPresent(ctx: Pick<WorkCtx, 'host' | 'reaches'>, by: Caller, source: CanvasSource, deps: PresentDeps): Promise<boolean> {
  let ref: Ref
  try {
    ref = refOf(ctx, by, source)
  } catch {
    return false
  }
  return (await carrierFor(ref, deps)) !== null
}

/** His press: the deck in PowerPoint and its own slideshow running, on the computer the file is on. */
export async function presentDeck(ctx: Pick<WorkCtx, 'host' | 'reaches'>, by: Caller, source: CanvasSource, deps: PresentDeps): Promise<void> {
  const ref = refOf(ctx, by, source)
  const found = await carrierFor(ref, deps)
  if (!found) throw new Error(PRESENT_WORDS.none)
  // His press may wake the VM; nothing else does.
  if (found.place === 'vm') await deps.wake?.()
  await found.carrier.present!(ref)
}
