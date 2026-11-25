// The iPhone Duo proof's checks (scripts/lib/duo_pose_check.py, duo_fold_check.py and
// duo_work_fold_check.py, run by scripts/ios-sim-proof.sh) on hand-made reports:
// the shapes the app writes, at the numbers the simulator gave on 2026-11-05.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const lib = resolve(__dirname, 'lib')
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'duo-checks-'))
  dirs.push(dir)
  return dir
}

/** The first 24 bytes of a PNG: the check reads the IHDR's width and height alone. */
const png = (w: number, h: number): Buffer => {
  const b = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}

type Notes = Record<string, string>
const report = (notes: Notes, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  window: { w: 951, h: 669 },
  hSize: 'regular',
  vSize: 'regular',
  classified: 'unfolded',
  hinge: { state: 'fullyOpen', angle: 180 },
  // The tab rail is the window's right inset: the shell holds 951 less 84.
  safeArea: { top: 0, left: 0, bottom: 34, right: 84 },
  route: { tab: 'home', depth: 2, thread: 'ios-impl', segment: 'board' },
  notes,
  ...extra
})
const poseRecord = (extra: Record<string, unknown>): Record<string, unknown> => ({
  regularWidth: true,
  compactHeight: false,
  segmentBarShown: false,
  dockWidth: 0,
  barInset: 0,
  pagerContainer: extra.width,
  ...extra
})

function poseCheck(
  r: Record<string, unknown>,
  record: Record<string, unknown> | null,
  env: { SHOT_KIND?: string; SHOT_SIDEBAR?: string; SHOT_DRAFT?: string } = {},
  pose = 'unfolded'
): { status: number | null; out: string } {
  const dir = scratch()
  const [w, h] = pose === 'unfolded-portrait' || pose === 'tabletop' ? [669, 951] : [951, 669]
  writeFileSync(join(dir, 'shot.png'), png(w * 3, h * 3))
  writeFileSync(join(dir, 'report.json'), JSON.stringify(r))
  if (record) writeFileSync(join(dir, 'pose.json'), JSON.stringify(record))
  const run = spawnSync('python3', [join(lib, 'duo_pose_check.py'), join(dir, 'shot.png'), join(dir, 'report.json'), pose, 'label', join(dir, 'pose.json')], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8'
  })
  return { status: run.status, out: run.stdout + run.stderr }
}

// Unfolded beside the 320 pt sidebar: the 547 pt column, a board thread on the pager.
const besideSidebar: Notes = {
  sidebar: 'visible',
  'sidebar.width': '320',
  'split.width': '867',
  'body.frame': '320,0,547,669',
  'composer.frame': '336,560,515,46',
  measure: '515',
  columns: 'pager',
  'slot.frame': 'none',
  'dock.backing': 'clear',
  'dock.frame': '320,554,547,58',
  'dock.fade.frame': '320,554,547,58',
  'dock.bar.frame': '0,554,867,58',
  draftChars: '0'
}
// The sidebar hidden: 867 pt, two panes; the board fits 400 pt, a hairline, the chat 466.7.
const twoPane: Notes = {
  ...besideSidebar,
  sidebar: 'hidden',
  'body.frame': '0,0,867,669',
  'composer.frame': '416,560,435,46',
  measure: '435',
  columns: '400,0,466'
}

describe('duo_pose_check.py', () => {
  it('holds tabletop to 669 × 951, regular both ways, classified tabletop (hinge partly open)', () => {
    const tabletop = { window: { w: 669, h: 951 }, classified: 'tabletop', hinge: { state: 'partiallyOpen', angle: 128 }, safeArea: { top: 82, left: 0, bottom: 34, right: 0 }, route: { tab: 'work', depth: 1 } }
    const ok = poseCheck(report({}, tabletop), null, {}, 'tabletop')
    expect(ok.out).toContain('tabletop/label 669×951 regular×regular png 2007×2853 classified tabletop hinge partiallyOpen ok')
    expect(ok.status).toBe(0)
    // The same window read as unfolded-portrait (an app that does not know the pose) is a mismatch.
    const portrait = poseCheck(report({}, { ...tabletop, classified: 'unfolded-portrait' }), null, {}, 'tabletop')
    expect(portrait.status).toBe(1)
    expect(portrait.out).toContain('POSE MISMATCH')
  })

  it('passes a board thread on the pager beside the sidebar iOS holds at 320', () => {
    const run = poseCheck(report(besideSidebar), poseRecord({ mode: 'pager', width: 547 }), { SHOT_KIND: 'implementation', SHOT_SIDEBAR: 'shown' })
    expect(run.out).toContain('rule: implementation pager column 547 sidebar visible 320/867')
    expect(run.status).toBe(0)
  })

  it('refuses a sidebar wider than 320, or a column that is not what the sidebar leaves', () => {
    const wide = poseCheck(report({ ...besideSidebar, 'sidebar.width': '340' }), poseRecord({ mode: 'pager', width: 527 }), { SHOT_KIND: 'implementation' })
    expect(wide.status).toBe(1)
    expect(wide.out).toContain('sidebar 340 wide')
    const short = poseCheck(report(besideSidebar), poseRecord({ mode: 'pager', width: 530 }), { SHOT_KIND: 'implementation' })
    expect(short.status).toBe(1)
    expect(short.out).toContain('does not end at the 867 held')
  })

  it('refuses a sidebar in another state than the shot asked for', () => {
    const run = poseCheck(report(besideSidebar), poseRecord({ mode: 'pager', width: 547 }), { SHOT_KIND: 'implementation', SHOT_SIDEBAR: 'hidden' })
    expect(run.status).toBe(1)
    expect(run.out).toContain("asked 'hidden'")
  })

  it('passes two panes with the sidebar hidden, the composer on the chat column', () => {
    const run = poseCheck(
      report(twoPane),
      poseRecord({ mode: 'twoPane', width: 867, columns: { hero: 400, gap: 0.3, chat: 466.7 } }),
      { SHOT_KIND: 'implementation', SHOT_SIDEBAR: 'hidden' }
    )
    expect(run.out).toContain('ok')
    expect(run.status).toBe(0)
  })

  it('refuses the pager where ThreadPose gives two panes, and a hero under 320', () => {
    const pager = poseCheck(report({ ...twoPane, 'composer.frame': '16,560,835,46', measure: '835' }), poseRecord({ mode: 'pager', width: 867 }), { SHOT_KIND: 'implementation' })
    expect(pager.status).toBe(1)
    expect(pager.out).toContain('ThreadPose says twoPane')
    const narrow = poseCheck(report(twoPane), poseRecord({ mode: 'twoPane', width: 867, columns: { hero: 300, gap: 0.3, chat: 566.7 } }), { SHOT_KIND: 'implementation' })
    expect(narrow.status).toBe(1)
    expect(narrow.out).toContain('hero 300')
  })

  it("holds a non-board hero to the desktop's split: half, the chat keeping 360", () => {
    const run = poseCheck(
      report({ ...twoPane, 'composer.frame': '449,560,401,46', measure: '401' }),
      poseRecord({ mode: 'twoPane', width: 867, columns: { hero: 400, gap: 0.3, chat: 466.7 } }),
      { SHOT_KIND: 'planning' }
    )
    expect(run.status).toBe(1)
    expect(run.out).toContain('the split gives 433')
  })

  it('reads a lone chat at 768, centred, the composer on its edges', () => {
    const notes = { ...twoPane, columns: 'single', measure: '768', 'composer.frame': '49,560,768,46' }
    const ok = poseCheck(report(notes, { route: { tab: 'home', depth: 2, thread: 'ios-chat', segment: 'chat' } }), poseRecord({ mode: 'single', width: 867 }), { SHOT_KIND: 'chat' })
    expect(ok.out).toContain('chat single column 867')
    expect(ok.status).toBe(0)
    const off = poseCheck(report({ ...notes, 'composer.frame': '20,560,768,46' }), poseRecord({ mode: 'single', width: 867 }), { SHOT_KIND: 'chat' })
    expect(off.status).toBe(1)
    expect(off.out).toContain('composer starts at 20')
  })

  it('puts the panes on the fold half open', () => {
    const run = poseCheck(
      report({ ...twoPane, 'composer.frame': '492,560,359,46', measure: '359' }, { hinge: { state: 'partiallyOpen', angle: 130 }, classified: 'half-open' }),
      poseRecord({ mode: 'twoPane', width: 867, columns: { hero: 391, gap: 85, chat: 391 }, division: { x: 391, y: 0, width: 85, height: 669 } }),
      { SHOT_KIND: 'implementation' },
      'half-open'
    )
    expect(run.out).toContain('ok')
    expect(run.status).toBe(0)
  })

  it('starts the column past the fold half open, where the sidebar fills the first panel', () => {
    const halfOpen = { hinge: { state: 'partiallyOpen', angle: 128 }, classified: 'half-open' }
    const notes = { ...besideSidebar, 'sidebar.width': '456', 'body.frame': '496,154,371,433', 'composer.frame': '512,507,339,74', measure: '339' }
    const ok = poseCheck(report(notes, halfOpen), poseRecord({ mode: 'pager', width: 371.3 }), { SHOT_KIND: 'implementation', SHOT_SIDEBAR: 'shown' }, 'half-open')
    expect(ok.out).toContain('sidebar visible 456')
    expect(ok.status).toBe(0)
    const far = poseCheck(report({ ...notes, 'body.frame': '520,154,347,433', 'composer.frame': '536,507,315,74', measure: '315' }, halfOpen), poseRecord({ mode: 'pager', width: 347 }), { SHOT_KIND: 'implementation' }, 'half-open')
    expect(far.status).toBe(1)
    expect(far.out).toContain('the column starts at 520, the sidebar ends at 456')
  })

  it('holds the band behind the dock to the dock, and the dock to its parts', () => {
    const record = poseRecord({ mode: 'twoPane', width: 867, columns: { hero: 400, gap: 0.3, chat: 466.7 } })
    const env = { SHOT_KIND: 'implementation', SHOT_SIDEBAR: 'hidden' }
    expect(poseCheck(report(twoPane), record, env).status).toBe(0)
    // A dock taller than the composer and its padding: the bar offered it the column.
    const tall = poseCheck(report({ ...twoPane, 'dock.frame': '400,160,467,452', 'dock.fade.frame': '400,160,467,452' }), record, env)
    expect(tall.status).toBe(1)
    expect(tall.out).toContain('dock 452 pt tall, its parts 58')
    const band = poseCheck(report({ ...twoPane, 'dock.fade.frame': '400,160,467,452' }), record, env)
    expect(band.out).toContain('band 452 pt tall, dock 58')
    const bar = poseCheck(report({ ...twoPane, 'dock.bar.frame': '0,300,867,312' }), record, env)
    expect(bar.out).toContain('bar 312 pt tall')
    const missing = poseCheck(report({ ...twoPane, 'dock.frame': '' }), record, env)
    expect(missing.out).toContain('no dock.frame')
  })

  it('holds the draft to what was typed, and a thread shot to its pose record', () => {
    const draft = poseCheck(report(besideSidebar), poseRecord({ mode: 'pager', width: 547 }), { SHOT_KIND: 'implementation', SHOT_DRAFT: '61' })
    expect(draft.status).toBe(1)
    expect(draft.out).toContain('draft 0 chars, typed 61')
    const missing = poseCheck(report(besideSidebar), null)
    expect(missing.status).toBe(1)
    expect(missing.out).toContain('no pose-<sessionId>.json')
  })
})

describe('duo_fold_check.py', () => {
  type Stop = { pose: 'unfolded' | 'folded'; t: number; atBottom: number; sidebar: string }
  const stops: Stop[] = [
    { pose: 'unfolded', t: 10_000, atBottom: 1, sidebar: 'hidden' },
    { pose: 'folded', t: 20_000, atBottom: 1, sidebar: 'stack' },
    { pose: 'unfolded', t: 30_000, atBottom: 1, sidebar: 'hidden' },
    { pose: 'folded', t: 40_000, atBottom: 1, sidebar: 'stack' }
  ]
  const events = [
    { t: 100, key: 'hSize', from: null, to: 'regular' },
    { t: 15_000, key: 'hSize', from: 'regular', to: 'compact' },
    { t: 15_000, key: 'window', from: '951x669', to: '466x678' },
    { t: 15_010, key: 'sidebar', from: 'hidden', to: 'stack' },
    { t: 25_000, key: 'hSize', from: 'compact', to: 'regular' },
    { t: 25_000, key: 'window', from: '466x678', to: '951x669' },
    { t: 25_010, key: 'sidebar', from: 'stack', to: 'hidden' },
    { t: 35_000, key: 'hSize', from: 'regular', to: 'compact' },
    { t: 35_000, key: 'window', from: '951x669', to: '466x678' },
    { t: 35_010, key: 'sidebar', from: 'hidden', to: 'stack' }
  ]
  // A turn streams through the cycle: the slot's timer over the composer on a solid band, 118 pt.
  const streamingDock: Notes = {
    'dock.backing': 'solid',
    'slot.frame': '368,475,483,28',
    'composer.frame': '368,507,483,74',
    'dock.frame': '352,469,515,118',
    'dock.fade.frame': '352,469,515,118'
  }
  function foldCheck(
    run: 'bottom' | 'scrolled-up',
    change: { samples?: string; draft?: string[]; violations?: unknown[]; tops?: number[]; atBottom?: number[]; events?: unknown[]; dock?: Array<Notes | undefined> } = {}
  ): { status: number | null; out: string } {
    const dir = scratch()
    mkdirSync(join(dir, 'unfolded'))
    mkdirSync(join(dir, 'folded'))
    mkdirSync(join(dir, `cycle-${run}`))
    stops.forEach((stop, i) => {
      const name = `cycle-${run}-${i + 1}-${stop.pose}`
      const atBottom = change.atBottom?.[i] ?? (run === 'bottom' ? 1 : 0)
      writeFileSync(join(dir, stop.pose, `${name}.json`), JSON.stringify({ t: stop.t, route: { tab: 'home', depth: 2, thread: 'ios-impl', segment: 'chat' }, transcriptAtBottom: atBottom, notes: { draftChars: change.draft?.[i] ?? '61', sidebar: stop.sidebar, ...(change.dock?.[i] ?? streamingDock) } }))
      const top = change.tops?.[i] ?? (run === 'bottom' ? -1 : 412)
      writeFileSync(join(dir, stop.pose, `${name}.transcript.json`), JSON.stringify({ atBottom, topRow: top, reflowAnchor: i === 0 ? 0 : run === 'bottom' ? 1 : 2 }))
    })
    writeFileSync(join(dir, `cycle-${run}`, 'events.json'), JSON.stringify(change.events ?? events))
    writeFileSync(join(dir, `cycle-${run}`, 'samples.txt'), change.samples ?? ' 61\n120 61\n240 61\n240 61\n900 61\n')
    writeFileSync(join(dir, `cycle-${run}`, 'row-inits.json'), JSON.stringify({ rows: { a: { inits: 1, appears: 1, disappears: 0 } }, violations: change.violations ?? [] }))
    const out = spawnSync('python3', [join(lib, 'duo_fold_check.py'), dir, run, '61'], { encoding: 'utf8' })
    return { status: out.status, out: out.stdout + out.stderr }
  }

  it('passes a run that kept the route, the draft, the reveal and the reader', () => {
    expect(foldCheck('bottom').status).toBe(0)
    expect(foldCheck('scrolled-up').status).toBe(0)
  })

  it('fails when the event log no longer reaches the first stop', () => {
    const run = foldCheck('bottom', { events: events.slice(1) })
    expect(run.status).toBe(1)
    expect(run.out).toContain('after the first stop at 10000 ms')
  })

  it('fails when the reveal goes back (a row made again starts from nothing)', () => {
    const run = foldCheck('bottom', { samples: '120 61\n480 61\n12 61\n500 61\n' })
    expect(run.status).toBe(1)
    expect(run.out).toContain('revealedUnits went back 1 times')
  })

  it('fails when the draft changes, a row inits twice, or the reader loses their row', () => {
    expect(foldCheck('bottom', { draft: ['61', '61', '0', '61'] }).out).toContain("draft ['61', '61', '0', '61']")
    const twice = foldCheck('bottom', { violations: [{ key: 'item:41', t: 21_000, inits: 2 }] })
    expect(twice.status).toBe(1)
    expect(twice.out).toContain('item:41×2')
    const lost = foldCheck('scrolled-up', { tops: [412, 412, 380, 412] })
    expect(lost.status).toBe(1)
    expect(lost.out).toContain('C: top row 380')
    const dropped = foldCheck('bottom', { atBottom: [1, 1, 0, 1] })
    expect(dropped.status).toBe(1)
    expect(dropped.out).toContain('C: off the bottom')
  })

  it('holds the dock band at every stop: its parts\' height on a solid backing', () => {
    const third = (dock: Notes): Array<Notes | undefined> => [undefined, undefined, { ...streamingDock, ...dock }, undefined]
    expect(foldCheck('bottom').status).toBe(0)
    // The unfold of 2026-11-06: the slot took the column the bar offered.
    const grown = foldCheck('bottom', { dock: third({ 'slot.frame': '368,166,483,337', 'dock.frame': '352,160,515,427', 'dock.fade.frame': '352,160,515,427' }) })
    expect(grown.status).toBe(1)
    expect(grown.out).toContain('stop 3 (unfolded): slot 337 pt tall')
    const faded = foldCheck('bottom', { dock: third({ 'dock.backing': 'fade' }) })
    expect(faded.status).toBe(1)
    expect(faded.out).toContain('stop 3 (unfolded): dock.backing fade, want solid')
  })
})

describe('duo_fold_sampler.py', () => {
  it('keeps every event the app rotated out of its 500, and samples the reveal and the draft', async () => {
    const docs = scratch()
    const out = scratch()
    const at = (t: number, key: string) => ({ t, key, from: null, to: String(t) })
    writeFileSync(join(docs, 'layout-events.json'), JSON.stringify([at(1, 'hSize'), at(2, 'write')]))
    writeFileSync(join(docs, 'layout-report.json'), JSON.stringify({ notes: { revealedUnits: '40', draftChars: '61' } }))
    const sampler = spawn('python3', [join(lib, 'duo_fold_sampler.py'), docs, out])
    await new Promise((ok) => setTimeout(ok, 600))
    // The app's log moved on: the first event fell out of its window.
    writeFileSync(join(docs, 'layout-events.json'), JSON.stringify([at(2, 'write'), at(3, 'window')]))
    await new Promise((ok) => setTimeout(ok, 600))
    const done = new Promise((ok) => sampler.on('exit', ok))
    sampler.kill('SIGTERM')
    await done
    const events = JSON.parse(readFileSync(join(out, 'events.json'), 'utf8')) as Array<{ t: number }>
    expect(events.map((e) => e.t)).toEqual([1, 2, 3])
    expect(readFileSync(join(out, 'samples.txt'), 'utf8').split('\n')[0]).toBe('40 61')
  })
})

describe('duo_work_fold_check.py', () => {
  type Stop = { pose: 'folded' | 'unfolded'; t: number }
  const stops: Stop[] = [
    { pose: 'folded', t: 10_000 },
    { pose: 'unfolded', t: 20_000 },
    { pose: 'folded', t: 30_000 }
  ]
  const route = 'place(TempCodeClient.WorkPlace.outbox, job: nil) > outboxItem(environmentId: "env", ref: "host:fold-12")'
  // An ordinary route (the Outbox beside its item): the sidebar shown when open, the stack when folded.
  const calm: Notes = {
    'work.route': route,
    'work.picked': 'env:host:fold-12',
    'work.top': 'env:host:fold-08',
    'sidebar.chosen': 'shown',
    'web.instance': '7f3a',
    'web.loads': '1'
  }
  const sidebars = ['stack', 'visible', 'stack']
  const events = [
    { t: 100, key: 'work.route', from: null, to: route },
    { t: 15_000, key: 'sidebar', from: 'stack', to: 'visible' },
    { t: 25_000, key: 'sidebar', from: 'visible', to: 'stack' }
  ]
  function workFold(
    change: { notes?: Array<Notes | undefined>; sidebars?: string[]; events?: unknown[]; violations?: unknown[]; classified?: string } = {},
    kind: 'ordinary' | 'wide' = 'ordinary',
    override?: 'shown' | 'hidden',
    extra: string[] = []
  ): { status: number | null; out: string } {
    const dir = scratch()
    mkdirSync(join(dir, 'unfolded'))
    mkdirSync(join(dir, 'folded'))
    mkdirSync(join(dir, 'wfold-outbox'))
    const side = change.sidebars ?? sidebars
    stops.forEach((stop, i) => {
      const classified = stop.pose === 'unfolded' ? (change.classified ?? 'unfolded') : 'folded'
      const notes = { ...calm, sidebar: side[i], ...(change.notes?.[i] ?? {}) }
      writeFileSync(join(dir, stop.pose, `wfold-outbox-${i + 1}-${stop.pose}.json`), JSON.stringify({ t: stop.t, classified, notes }))
    })
    writeFileSync(join(dir, 'wfold-outbox', 'events.json'), JSON.stringify(change.events ?? events))
    writeFileSync(join(dir, 'wfold-outbox', 'row-inits.json'), JSON.stringify({ rows: { 'work:env:host:fold-08': { inits: 1, appears: 1, disappears: 0 } }, violations: change.violations ?? [] }))
    const run = spawnSync('python3', [join(lib, 'duo_work_fold_check.py'), dir, 'outbox', kind, ...(override ? [override] : []), ...extra], { encoding: 'utf8' })
    return { status: run.status, out: run.stdout + run.stderr }
  }
  const second = (notes: Notes): Array<Notes | undefined> => [undefined, notes, undefined]
  const fails = (run: { status: number | null; out: string }, line: string): void => {
    expect(run.status).toBe(1)
    expect(run.out).toContain(`WORK FOLD FAIL (outbox) ${line}`)
    expect(run.out.match(/WORK FOLD FAIL/g)).toHaveLength(1)
  }

  it('passes a run that kept the route, the pick, the top row and the page, the sidebar as allowed', () => {
    const run = workFold()
    expect(run.status).toBe(0)
    expect(run.out).toContain('work fold outbox PASS')
  })

  it('fails when the route, the pick, the top row, the draft or the sheet changes', () => {
    fails(workFold({ notes: second({ 'work.route': 'list > none' }) }), 'route changed')
    fails(workFold({ notes: second({ 'work.picked': 'env:host:fold-01' }) }), "picked row changed: ['env:host:fold-12', 'env:host:fold-01', 'env:host:fold-12']")
    fails(workFold({ notes: second({ 'work.top': 'env:host:fold-01' }) }), 'top row changed')
    fails(workFold({ notes: [{ draftChars: '40' }, { draftChars: '0' }, { draftChars: '40' }] }), "draft changed: ['40', '0', '40']")
    fails(workFold({ notes: [{ 'work.sheet': 'form' }, { 'work.sheet': 'none' }, { 'work.sheet': 'form' }] }), "sheet changed: ['form', 'none', 'form']")
  })

  it('holds the chips in a Work thread box, and a typed run must have a draft and a chip', () => {
    fails(workFold({ notes: [{ 'work.chips': '1' }, { 'work.chips': '0' }, { 'work.chips': '1' }] }), "chips changed: ['1', '0', '1']")
    const typed: Array<Notes | undefined> = [0, 1, 2].map(() => ({ draftChars: '44', 'work.chips': '1' }))
    expect(workFold({ notes: typed }, 'ordinary', undefined, ['typed']).status).toBe(0)
    const noDraft: Array<Notes | undefined> = [0, 1, 2].map(() => ({ 'work.chips': '1' }))
    fails(workFold({ notes: noDraft }, 'ordinary', undefined, ['typed']), 'no typed draft at the first stop')
    const noChip: Array<Notes | undefined> = [0, 1, 2].map(() => ({ draftChars: '44', 'work.chips': '0' }))
    fails(workFold({ notes: noChip }, 'ordinary', undefined, ['typed']), 'no chip in the box at the first stop (work.chips 0)')
  })

  it('fails when an open sheet went away between stops, even if it came back', () => {
    const up: Array<Notes | undefined> = [{ 'work.sheet': 'form' }, { 'work.sheet': 'form' }, { 'work.sheet': 'form' }]
    expect(workFold({ notes: up }).status).toBe(0)
    const flicker = [...events, { t: 15_000, key: 'work.sheet', from: 'form', to: 'none' }, { t: 15_200, key: 'work.sheet', from: 'none', to: 'form' }]
    fails(workFold({ notes: up, events: flicker }), 'sheet form went away at 15000 ms')
  })

  it('fails when a fold writes his chosen sidebar', () => {
    fails(workFold({ events: [...events, { t: 15_010, key: 'sidebar.chosen', from: 'shown', to: 'hidden' }] }), 'a fold wrote the chosen sidebar')
  })

  it('holds the sidebar to the states the route and the pose allow', () => {
    // Ordinary: hidden where he chose shown is wrong.
    fails(workFold({ sidebars: ['stack', 'hidden', 'stack'] }), 'stop 2 (unfolded): sidebar hidden, want visible (ordinary route)')
    // The tall poses tile as the wide ones do (iw13: iOS 27.1 lays the split side by side there): beside, never over.
    expect(workFold({ sidebars: ['stack', 'visible', 'stack'], classified: 'unfolded-portrait' }).status).toBe(0)
    expect(workFold({ sidebars: ['stack', 'visible', 'stack'], classified: 'tabletop' }).status).toBe(0)
    expect(workFold({ sidebars: ['stack', 'overlay', 'stack'], classified: 'tabletop' }).status).toBe(1)
    expect(workFold({ sidebars: ['stack', 'hidden', 'stack'], notes: [{ 'sidebar.chosen': 'hidden' }, { 'sidebar.chosen': 'hidden' }, { 'sidebar.chosen': 'hidden' }] }).status).toBe(0)
    // Folded is always the stack.
    fails(workFold({ sidebars: ['visible', 'visible', 'stack'] }), 'stop 1 (folded): sidebar visible, want stack')
    // Wide: hidden whatever he chose, unless his own press on that route brought it back.
    expect(workFold({ sidebars: ['stack', 'hidden', 'stack'] }, 'wide').status).toBe(0)
    fails(workFold({}, 'wide'), 'stop 2 (unfolded): sidebar visible, want hidden (wide route)')
    expect(workFold({}, 'wide', 'shown').status).toBe(0)
  })

  it('fails when a row on screen made its state twice', () => {
    fails(workFold({ violations: [{ key: 'work:env:host:fold-09', t: 21_000, inits: 2 }] }), '1 rows on screen made their state again: work:env:host:fold-09×2')
  })

  it('fails when the hosted page is a new object or loads again', () => {
    fails(workFold({ notes: second({ 'web.instance': '9c01' }) }), "web view instance changed: ['7f3a', '9c01', '7f3a']")
    fails(workFold({ notes: [undefined, undefined, { 'web.loads': '2' }] }), "the hosted page loaded again: ['1', '1', '2']")
  })

  it('fails when the event log no longer reaches the first stop', () => {
    fails(workFold({ events: events.slice(1) }), 'the event log starts at 15000 ms, after the first stop at 10000 ms')
  })
})
