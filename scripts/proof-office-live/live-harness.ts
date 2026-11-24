/**
 * The live proof's page (bundled for the browser with the REAL layer.ts): two tab bodies, a dialog at z-index 90 and a
 * menu at z-index 95, as Files has them. Main drives it through `window.__h`.
 */
import { LiveLayer, type LiveRect, type LiveStage } from '../../src/renderer/src/work/office/live/layer'

const layer = new LiveLayer()
const KEY = 'dummy'
const $ = (id: string): HTMLElement => document.getElementById(id)!
const rectOf = (el: HTMLElement): LiveRect => {
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}
const stages: LiveStage[] = []
layer.subscribe(KEY, () => {
  const s = layer.state(KEY)
  if (stages[stages.length - 1] !== s.stage) stages.push(s.stage)
})

const h = {
  stages,
  state: () => layer.state(KEY),
  /** The dummy's tab on screen: its guest over the first body. */
  show(url: string): void {
    $('body1').hidden = false
    $('body2').hidden = true
    layer.show(KEY, url, rectOf($('body1')), false, $('body1'))
  },
  /** The other tab on screen: the guest hidden, kept loaded. */
  other(): void {
    layer.hide(KEY)
    $('body1').hidden = true
    $('body2').hidden = false
  },
  focus: () => layer.focus(KEY),
  guest(): { id: number | null; visibility: string; rect: LiveRect } | null {
    const el = document.querySelector<HTMLElement & { getWebContentsId(): number }>(`webview[data-office-live="${KEY}"]`)
    if (!el) return null
    let id: number | null = null
    try {
      id = el.getWebContentsId()
    } catch {
      id = null
    }
    return { id, visibility: el.style.visibility, rect: rectOf(el) }
  },
  /** What is drawn at the guest's centre with the dialog, then the menu, over it. */
  over(): Record<string, string> {
    const g = rectOf($('body1'))
    const cx = g.x + g.width / 2
    const cy = g.y + g.height / 2
    const at = (): string => {
      const el = document.elementFromPoint(cx, cy) as HTMLElement | null
      return el ? el.id || el.tagName.toLowerCase() : 'none'
    }
    const out: Record<string, string> = { bare: at() }
    $('dialog').hidden = false
    out.dialog = at()
    $('dialog').hidden = true
    $('menu').hidden = false
    out.menu = at()
    $('menu').hidden = true
    return out
  },
  typed: () => layer.typed(KEY),
  async leave(): Promise<{ answer: boolean; asked: boolean; left: boolean }> {
    let asked = false
    const answer = await layer.leave(KEY, async () => {
      asked = true
      return true
    })
    return { answer, asked, left: !document.querySelector('webview') }
  }
}
;(window as unknown as { __h: typeof h }).__h = h
