import { describe, expect, it, vi } from 'vitest'
import type { CanvasSource } from '@shared/work'
import { FenceError } from '../../remote/fence'
import type { Caller } from '../modules'
import type { OfficeCarrier } from './carrier'
import { TC_OFFICE_CS } from './com/source'
import { canPresent, PRESENT_PROVEN, PRESENT_WORDS, presentDeck, type PresentDeps } from './present'
import type { RenderPlace } from './render'

/**
 * "In PowerPoint" (docs/agents/work-office.md "Presenting in PowerPoint"): a deck opened in PowerPoint on the
 * computer its file is on, and PowerPoint's own slideshow run; offered only where PowerPoint is there and the place
 * is proven, and only on his press.
 */

const ctx = { host: 'env_mac', reaches: (by: Caller, path: string) => by.kind !== 'remote' || path.startsWith('/Users/owner/Work/') }
const OWNER: Caller = { kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }
const PHONE: Caller = { kind: 'remote', caps: ['read', 'operate'] }
const THREAD: Caller = { kind: 'model', caps: [], sessionId: 's1' }
const FILE: CanvasSource = { at: 'file', host: 'env_mac', path: '/Users/owner/Work/Talk.pptx' }
const WEB: CanvasSource = { at: 'microsoft', host: 'env_mac', app: 'powerpoint', name: 'Talk.pptx', ref: { kind: 'url', url: 'https://contoso.sharepoint.com/Talk.pptx' } }

function powerpoint(installed = true) {
  const presented: unknown[] = []
  const carrier = {
    kind: 'fake',
    apps: async () => [{ app: 'powerpoint', installed, running: false, allowed: 'unknown' }],
    present: async (ref: unknown) => void presented.push(ref)
  } as unknown as OfficeCarrier
  return { carrier, presented }
}

const deps = (carrier: OfficeCarrier | null, place: RenderPlace | null = 'mac', proven: RenderPlace[] = ['mac', 'windows', 'vm'], over: Partial<PresentDeps> = {}): PresentDeps => ({
  place: () => place,
  carrier: () => carrier,
  proven: new Set(proven),
  ...over
})

describe('presenting in PowerPoint', () => {
  it('is offered on his Mac alone, the one place whose live proof passed', async () => {
    expect([...PRESENT_PROVEN]).toEqual(['mac'])
    const { carrier, presented } = powerpoint()
    expect(await canPresent(ctx, OWNER, FILE, { place: () => 'mac', carrier: () => carrier })).toBe(true)
    for (const place of ['windows', 'vm'] as const) {
      expect(await canPresent(ctx, OWNER, FILE, { place: () => place, carrier: () => carrier, vmOffice: () => true })).toBe(false)
      await expect(presentDeck(ctx, OWNER, FILE, { place: () => place, carrier: () => carrier, vmOffice: () => true })).rejects.toThrow(PRESENT_WORDS.none)
    }
    expect(presented).toEqual([])
  })

  it('opens a plain deck file and runs its slideshow where PowerPoint is, and is absent where it is not', async () => {
    const { carrier, presented } = powerpoint()
    expect(await canPresent(ctx, OWNER, FILE, deps(carrier))).toBe(true)
    await presentDeck(ctx, OWNER, FILE, deps(carrier))
    expect(presented).toEqual([{ kind: 'path', path: '/Users/owner/Work/Talk.pptx' }])
    expect(await canPresent(ctx, OWNER, FILE, deps(powerpoint(false).carrier))).toBe(false)
    expect(await canPresent(ctx, OWNER, FILE, deps(null))).toBe(false)
    // A place not proven offers nothing, whatever is installed there.
    expect(await canPresent(ctx, OWNER, FILE, deps(carrier, 'windows', ['mac']))).toBe(false)
  })

  it('presents a deck that lives in PowerPoint on the web by its address', async () => {
    const { carrier, presented } = powerpoint()
    await presentDeck(ctx, OWNER, WEB, deps(carrier))
    expect(presented).toEqual([{ kind: 'url', url: 'https://contoso.sharepoint.com/Talk.pptx' }])
  })

  it('refuses a thread: a thread never presents', async () => {
    const { carrier, presented } = powerpoint()
    await expect(presentDeck(ctx, THREAD, FILE, deps(carrier))).rejects.toThrow('A thread never presents.')
    expect(await canPresent(ctx, THREAD, FILE, deps(carrier))).toBe(false)
    expect(presented).toEqual([])
  })

  it('refuses what is not a deck, a deck on another host, and a file the caller could not name', async () => {
    const { carrier } = powerpoint()
    await expect(presentDeck(ctx, OWNER, { at: 'file', host: 'env_mac', path: '/Users/owner/Work/Notes.docx' }, deps(carrier))).rejects.toThrow(PRESENT_WORDS.notDeck)
    await expect(presentDeck(ctx, OWNER, { ...WEB, app: 'word' } as CanvasSource, deps(carrier))).rejects.toThrow(PRESENT_WORDS.notDeck)
    await expect(presentDeck(ctx, OWNER, { ...FILE, host: 'env_box' } as CanvasSource, deps(carrier))).rejects.toThrow(PRESENT_WORDS.elsewhere)
    await expect(presentDeck(ctx, PHONE, { at: 'file', host: 'env_mac', path: '/Users/owner/Private/Talk.pptx' }, deps(carrier))).rejects.toBeInstanceOf(FenceError)
    expect(await canPresent(ctx, PHONE, { at: 'file', host: 'env_mac', path: '/Users/owner/Private/Talk.pptx' }, deps(carrier))).toBe(false)
    // His phone may present a deck it could name.
    expect(await canPresent(ctx, PHONE, FILE, deps(carrier))).toBe(true)
  })

  it('wakes the Windows VM for his press on a deck in its OneDrive, and offers nothing where it has no Office', async () => {
    const { carrier, presented } = powerpoint()
    const wake = vi.fn(async () => undefined)
    const vmFile: CanvasSource = { at: 'microsoft', host: 'env_mac', app: 'powerpoint', name: 'Talk.pptx', ref: { kind: 'path', path: 'C:\\Users\\tcuser\\OneDrive\\Talk.pptx' } }
    const box = { ...ctx, reaches: () => true }
    expect(await canPresent(box, OWNER, vmFile, deps(carrier, 'vm', ['vm'], { vmOffice: () => false, wake }))).toBe(false)
    expect(await canPresent(box, OWNER, vmFile, deps(carrier, 'vm', ['vm'], { vmOffice: () => true, wake }))).toBe(true)
    expect(wake).not.toHaveBeenCalled()
    await presentDeck(box, OWNER, vmFile, deps(carrier, 'vm', ['vm'], { vmOffice: () => true, wake }))
    expect(wake).toHaveBeenCalledOnce()
    expect(presented).toEqual([{ kind: 'path', path: 'C:\\Users\\tcuser\\OneDrive\\Talk.pptx' }])
  })

  it('answers through the office module: check opens nothing, and a thread is refused', async () => {
    const { office } = await import('.')
    const req = (params: unknown) => ({ id: '1', method: 'work.office.present', params }) as never
    const mod = { host: 'env_box', reaches: () => true, db: {} } as never
    await expect(office.handle!(req({ source: { ...FILE, host: 'env_box' }, check: true }), mod, OWNER)).resolves.toEqual({ handled: true, result: { can: false } })
    await expect(office.handle!(req({ source: { ...FILE, host: 'env_box' } }), mod, THREAD)).rejects.toThrow('A thread never presents.')
  })
})

describe('the helper’s present region (TcOffice.cs, built only in Windows)', () => {
  it('presents the deck his PowerPoint has open, else opens his file in a window, and runs every slide from the first', () => {
    expect(TC_OFFICE_CS).toContain('#region Present (SLD9: a deck\'s own slideshow in PowerPoint)')
    expect(TC_OFFICE_CS).toContain('if (Present.Has(verb)) return present.Run(verb, a);')
    // Open(FileName, ReadOnly false, Untitled false, WithWindow true): his own file, not a copy
    expect(TC_OFFICE_CS).toContain('"Open", key, msoFalse, msoFalse, msoTrue)')
    expect(TC_OFFICE_CS).toContain('com.Set(settings, "RangeType", ppShowAll);')
    expect(TC_OFFICE_CS).toContain('com.Set(settings, "StartingSlide", 1);')
    expect(TC_OFFICE_CS).toContain('com.Call(settings, "Run")')
    // the settings' writes mark the deck changed; a deck he had saved is marked saved again before the show
    const run = TC_OFFICE_CS.slice(TC_OFFICE_CS.indexOf('public class Present'))
    expect(run).toContain('var saved = Convert.ToInt32(com.Get(deck, "Saved")) == msoTrue;')
    expect(run.indexOf('if (saved) com.Set(deck, "Saved", msoTrue);')).toBeGreaterThan(run.indexOf('com.Set(settings, "EndingSlide", count);'))
    expect(run.indexOf('if (saved) com.Set(deck, "Saved", msoTrue);')).toBeLessThan(run.indexOf('com.Call(settings, "Run")'))
    // a SlideShowWindow has no HWND by IDispatch: the show's window is found by PowerPoint's process and its class
    expect(run).not.toContain('"HWND"')
    expect(run).toContain('com.Window("POWERPNT", "screenClass", name)')
    // a background process gets the foreground only joined to the input of the window in front
    expect(TC_OFFICE_CS).toContain('var joined = front != 0 && front != me && AttachThreadInput(me, front, true);')
    expect(TC_OFFICE_CS).toContain('{ "present.run", "powerpoint" }')
  })
})
