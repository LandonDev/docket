import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO, Run, sleep, textOf } from './e2e-work-lib'

/**
 * Work search, live (docs/agents/work-search.md "Proofs"): one isolated windowed instance
 * of the built tree under xvfb, with two jobs, made-up Work threads and a LifeOS stand-in
 * of made-up rows (`TEMP_CODE_WORK_SEARCH_STANDIN`, search/standIn.ts). It never signs in
 * to LifeOS and reads no row of his. In the window: the rail's mark, the key, groups
 * filling, the arrows, Return on a mail in another job (the window moves there and the
 * Mail view opens), Recent, the key again to narrow, one kind alone, Escape. Then the
 * agents' tool, as a thread's bridge calls it, in one job and in a Work Chat.
 *
 * Run from the repo root after `electron-vite build`:
 *   env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-work-search.ts [--out <dir>]
 */
if (!process.argv.includes('--out')) process.argv.push('--out', join(REPO, '.temp-code/plans/landed/R3-search/live'))
const run = new Run('search')

const DAY = 86_400_000
const now = Date.now()
const rows = {
  'people:list': [
    { _id: 'p1', name: 'Bea Budgett', sectors: ['cosmic'], notes: 'Finance', identities: [{ kind: 'email', value: 'bea.budgett@example.org' }] },
    { _id: 'p2', name: 'Sam Ortiz', sectors: ['unify'], identities: [{ kind: 'email', value: 'sam@example.org' }] }
  ],
  'mail:search': [
    { _id: 'm1', sector: 'cosmic', subject: 'Budget for the spring launch', senders: ['Bea Budgett'], lastMessageAt: now - 2 * DAY },
    { _id: 'm2', sector: 'cosmic', subject: 'Re: budget sign-off', senders: ['Finance'], lastMessageAt: now - 5 * DAY },
    { _id: 'm3', sector: 'unify', subject: 'Q4 budget draft', senders: ['Sam Ortiz'], lastMessageAt: now - 21 * DAY },
    { _id: 'm4', sector: 'cosmic', subject: 'Server budget', senders: ['Ops'], lastMessageAt: now - 33 * DAY },
    { _id: 'm5', sector: 'unify', subject: 'Budget: travel for the offsite', senders: ['Sam Ortiz'], lastMessageAt: now - 40 * DAY },
    { _id: 'm6', sector: 'cosmic', subject: 'Jersey order', snippet: 'fits the budget if we order forty', senders: ['Vendor'], lastMessageAt: now - 60 * DAY },
    { _id: 'm7', sector: 'ref', subject: 'Budget for whistles', senders: ['League'], lastMessageAt: now - DAY }
  ],
  'tasks:search': [
    { _id: 't1', sector: 'cosmic', title: 'Send the budget to Bea', status: 'todo', key: 'COS-41', dueAt: now + 4 * DAY },
    { _id: 't2', sector: 'unify', title: 'Budget the offsite', status: 'done' }
  ],
  'events:range': [
    { _id: 'e1', sector: 'cosmic', title: 'Budget review', startsAt: now + 2 * DAY, location: 'Room 120' },
    { _id: 'e2', sector: 'ref', title: 'Budget meeting', startsAt: now + DAY }
  ],
  'projects:list': [{ _id: 'j1', sector: 'unify', name: 'Offsite', description: 'The budget and the venue' }],
  'docs:list': [{ _id: 'd1', sector: 'cosmic', title: 'Budget FY27', editedAt: now - 7 * DAY }],
  'catalog:search': [{ table: 'docs', id: 'd1', sector: 'cosmic', snippet: 'the budget for FY27' }],
  // Messages' own sources read these (messages/search.ts): made-up chat rows.
  'chats:search': [
    { chatId: 'c1', messageId: 'r1', chat: '#launch-crew', who: 'Bea Budgett', text: 'the budget for the booth is approved', at: now - 3 * 3_600_000, source: 'slack', sector: 'cosmic' },
    { chatId: 'c2', messageId: 'r2', chat: 'Sam Ortiz', who: 'Sam Ortiz', text: 'can we talk budget on Friday?', at: now - DAY, source: 'discord', sector: 'unify' }
  ],
  'chats:find': []
}

/** One key, as a keyboard sends it (Linux: Ctrl is the app's modifier). */
async function key(k: string, mods: { ctrl?: boolean; shift?: boolean } = {}): Promise<void> {
  const codes: Record<string, [string, number]> = { ArrowDown: ['ArrowDown', 40], ArrowUp: ['ArrowUp', 38], Enter: ['Enter', 13], Escape: ['Escape', 27], k: ['KeyK', 75] }
  const [code, vk] = codes[k]!
  const modifiers = (mods.ctrl ? 2 : 0) | (mods.shift ? 8 : 0)
  await run.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: mods.shift && k.length === 1 ? k.toUpperCase() : k, code, windowsVirtualKeyCode: vk, modifiers })
  await run.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
  await sleep(120)
}
const type = async (text: string): Promise<void> => {
  await run.send('Input.insertText', { text })
  await sleep(150)
}
const open = (): Promise<boolean> => run.page<boolean>(`!!document.querySelector('[data-work-search]')`)
const list = (): Promise<string[]> =>
  run.page<string[]>(`[...(document.querySelector('[data-work-search-list]')?.children ?? [])].map((el) => (el.getAttribute('role') === 'option' ? (el.getAttribute('aria-selected') === 'true' ? '> ' : '  ') + el.getAttribute('data-row') : '# ' + el.textContent))`)
const selected = (): Promise<string | null> => run.page<string | null>(`document.querySelector('[data-work-search-list] [aria-selected="true"]')?.getAttribute('data-row') ?? null`)
const scope = (): Promise<string> => run.page<string>(`document.querySelector('[data-work-search-scope]')?.textContent ?? ''`)
// Nothing asked is still out. (The spinner is no sign of it: it waits 150 ms before it shows.)
const settled = (): Promise<boolean> => run.page<boolean>(`!!document.querySelector('[data-work-search]') && !document.querySelector('[data-work-search] [data-out]')`)
/** The job the window is in, as its column says it. */
const windowJob = (): Promise<string> => run.page<string>(`[...document.querySelectorAll('h2')].map((h) => h.textContent.trim()).find((t) => ['Cosmic', 'Unify'].includes(t)) ?? ''`)
const moveTo = async (row: string): Promise<boolean> => {
  for (let i = 0; i < 40; i++) {
    if ((await selected()) === row) return true
    await key('ArrowDown')
  }
  return false
}
const openSearch = async (): Promise<void> => {
  await key('k', { ctrl: true, shift: true })
  await run.until('the picker opens', 10_000, open)
}

try {
  const standIn = join(run.root, 'lifeos-stand-in.json')
  writeFileSync(standIn, JSON.stringify(rows))
  await run.start({ env: { TEMP_CODE_WORK_SEARCH_STANDIN: standIn } })
  await sleep(3000)

  const cosmicAt = await run.call<{ id: string; path: string }>('workspace.create', { kind: 'work', sector: 'cosmic', name: 'Cosmic' })
  const cosmic = cosmicAt.id
  // Two made-up files in the job's own folder, listed once: Files answers names from what it has listed, never a walk.
  writeFileSync(join(cosmicAt.path, 'Budget lines.csv'), 'item,cost\nBooth,400\nShirts,250\n')
  writeFileSync(join(cosmicAt.path, 'Budget notes.md'), '# Budget notes\n\nMade up for the proof.\n')
  const listed = await run.call<{ entries: { name: string }[] }>('work.files.list', { workspaceId: cosmic, at: { at: 'place', id: 'folder' } })
  run.check('Files lists the two made-up files of the job', ['Budget lines.csv', 'Budget notes.md'].every((name) => listed.entries.some((e) => e.name === name)), listed.entries.map((e) => e.name).join(','))
  await sleep(500)
  const unify = (await run.call<{ id: string }>('workspace.create', { kind: 'work', sector: 'unify', name: 'Unify' })).id
  run.later('delete the Unify workspace', () => run.call('workspace.delete', { workspaceId: unify }))
  run.later('delete the Cosmic workspace', () => run.call('workspace.delete', { workspaceId: cosmic }))
  const inCosmic = await run.thread(cosmic, 'Budget review for the launch')
  const inUnify = await run.thread(unify, 'Budget for the offsite')
  const chat = await run.thread(null, 'Budget across jobs')
  const code = await run.call<{ id: string; scope?: string }>('session.create', { provider: 'claude', threadType: 'chat', title: 'Budget parser refactor', permission: 'auto' })
  run.later('delete the code thread', () => run.call('session.delete', { sessionId: code.id }))
  run.check('the code thread is no Work thread', code.scope !== 'work')

  // ── the wire, timed (counts and milliseconds only) ───────────────────
  type Answer = { groups: { source: string; kind: string; hits: { key: string; workspaceId: string | null }[]; more: boolean }[]; pending: { source: string }[]; quiet: { line: string }[] }
  const timed = async (params: Record<string, unknown>): Promise<{ ms: number; answer: Answer }> => {
    const runs: number[] = []
    let answer!: Answer
    for (let i = 0; i < 5; i++) {
      const t = performance.now()
      answer = await run.call<Answer>('work.search.query', params)
      runs.push(performance.now() - t)
    }
    return { ms: runs.sort((a, b) => a - b)[2]!, answer }
  }
  const first = await timed({ text: 'budget', tier: 'instant' })
  run.note(`work.search.query, instant tier: ${first.ms.toFixed(1)} ms median of 5; ${first.answer.groups.map((g) => `${g.source} ${g.hits.length}`).join(', ')}; pending ${first.answer.pending.map((p) => p.source).join(', ')}`)
  run.check('the instant tier answers people, open tasks, events, the files Files has listed and thread titles, with nothing left out of reach', first.answer.groups.map((g) => g.kind).join(',') === 'person,task,event,file,thread', first.answer.groups.map((g) => g.kind).join(','))
  run.check('no hit of a sector with no job on this host, and no code thread', !JSON.stringify(first.answer).includes('whistles') && !JSON.stringify(first.answer).includes('Budget meeting') && !JSON.stringify(first.answer).includes(code.id))
  for (const p of first.answer.pending) {
    const one = await timed({ text: 'budget', sources: [p.source] })
    run.note(`work.search.query, ${p.source}: ${one.ms.toFixed(1)} ms median of 5; ${one.answer.groups.map((g) => `${g.hits.length} rows${g.more ? ', more' : ''}`).join(', ') || 'no rows'}`)
  }
  const none = await run.call<Answer>('work.search.query', { text: 'budget', workspaceId: 'not-a-job' })
  run.check('a workspace that is no job of this host reads nothing', none.groups.length === 0)

  // ── the window ───────────────────────────────────────────────────────
  await run.show(inCosmic)
  run.check('the window is in Cosmic', (await windowJob()) === 'Cosmic', await windowJob())
  run.check("the rail's Work heading has the search mark", await run.page<boolean>(`!!document.querySelector('[aria-label="Search Work"]')`))
  await run.shot('01-rail-mark')

  await openSearch()
  run.check('⌘⇧K opens Work search', await open())
  run.check('with nothing typed and nothing opened before, it shows the field and nothing else', (await list()).length === 0, (await list()).join(' | '))
  await run.shot('02-open')

  await type('budget')
  await run.until('every source answered', 15_000, settled)
  const rowsNow = await list()
  const headings = rowsNow.filter((r) => r.startsWith('# ')).map((r) => r.slice(2))
  run.check('groups fill under their headings in the fixed order, Messages (its own pillar\'s source) among them', headings.join(',') === 'People,Mail,Messages,Tasks,Agenda,Files,Projects,Threads', headings.join(','))
  // Files lists LifeOS as a place of each job, so a document is a file there: it stands under Files, and Documents is gone.
  const fileTitles = await run.page<string[]>(`[...document.querySelectorAll('[data-work-search-list] [data-kind="file"]')].map((el) => el.textContent)`)
  run.check('the files of the job and the LifeOS document stand under Files, each once, and no Documents group', ['Budget lines.csv', 'Budget notes.md', 'Budget FY27'].every((name) => fileTitles.filter((t) => t.includes(name)).length === 1) && !headings.includes('Documents'), fileTitles.join(' | '))
  run.check('four mails and the row that opens all of them', rowsNow.filter((r) => r.includes('hit:lifeos:mailThreads')).length === 4 && rowsNow.some((r) => r.includes('all:mail')), rowsNow.join(' | '))
  run.check('the highlight is on the first row', rowsNow.find((r) => r.startsWith('> ')) === '> hit:lifeos:people:p1')
  run.check('each row names its job while jobs mix', (await run.page<number>(`document.querySelectorAll('[data-work-search-list] [data-job]').length`)) >= 8)
  run.check('the code thread with the same word is not listed', !(await run.has('Budget parser refactor')) || !(await run.page<boolean>(`document.querySelector('[data-work-search]').textContent.includes('Budget parser refactor')`)))
  // Measured in the app: a design page draws the frame outside the dialog, whose 22px line once made these 30.
  const heights = await run.page<number[]>(`[...document.querySelectorAll('[data-work-search-list] [role="option"]')].map((el) => el.getBoundingClientRect().height)`)
  run.check('every row is 28px tall in the dialog', heights.length > 0 && heights.every((h) => h === 28), [...new Set(heights)].join(','))
  await run.shot('03-results')

  await key('ArrowDown')
  await key('ArrowDown')
  run.check('the arrows move the highlight', (await selected()) === 'hit:lifeos:mailThreads:m2', String(await selected()))
  await run.shot('04-moved')

  // Far down a list that scrolls: the hold answers the scroller's own event and then rests; a box let go to be
  // measured would be pulled back by the browser, each time a new scroll event.
  for (let i = 0; i < 12; i++) await key('ArrowDown')
  await run.page(`(() => { const el = document.querySelector('[data-work-search-list]'); window.__ws = { n: 0, top: el.scrollTop }; el.addEventListener('scroll', () => window.__ws.n++); return true })()`)
  await sleep(600)
  const rest = await run.page<{ n: number; top: number; now: number }>(`({ ...window.__ws, now: document.querySelector('[data-work-search-list]').scrollTop })`)
  run.check('scrolled by the arrows, the list rests where it stands', rest.top > 0 && rest.n === 0 && rest.now === rest.top, JSON.stringify(rest))
  for (let i = 0; i < 12; i++) await key('ArrowUp')
  run.check('and the arrows bring the highlight back', (await selected()) === 'hit:lifeos:mailThreads:m2', String(await selected()))

  // Return on a mail in another job: the window moves there and Mail opens.
  run.check('the highlight reaches the mail in Unify', await moveTo('hit:lifeos:mailThreads:m3'))
  await key('Enter')
  await run.until('the picker closed', 5_000, async () => !(await open()))
  await run.until('the window moved', 10_000, async () => (await windowJob()) === 'Unify')
  run.check('Return closed the picker and moved the window to Unify', !(await open()) && (await windowJob()) === 'Unify', await windowJob())
  await sleep(1500)
  // The view's own header, right of the column: its name. (Its mail needs a LifeOS session the stand-in does not give the window.)
  run.check('the Mail view is open there', await run.page<boolean>(`[...document.querySelectorAll('span, h1, h2, h3, div')].some((e) => e.children.length === 0 && e.textContent.trim() === 'Mail' && e.getBoundingClientRect().left > 460 && e.getBoundingClientRect().top < 90)`))
  await run.shot('05-mail-in-other-job')

  // A chat message in the first job: Return opens Messages there, on its conversation.
  await openSearch()
  await type('booth')
  await run.until('every source answered', 15_000, settled)
  run.check('a chat message is found by its words', await moveTo('hit:lifeos:rawMessages:r1'), (await list()).join(' | '))
  await key('Enter')
  await run.until('the window moved', 10_000, async () => (await windowJob()) === 'Cosmic')
  await sleep(1500)
  run.check('Return on it opens the Messages view in its job', (await windowJob()) === 'Cosmic' && (await run.page<boolean>(`[...document.querySelectorAll('span, h1, h2, h3, div')].some((e) => e.children.length === 0 && e.textContent.trim() === 'Messages' && e.getBoundingClientRect().left > 460 && e.getBoundingClientRect().top < 90)`)))
  await run.shot('05b-message-in-its-job')
  // A file of that job: Return opens it in a Files tab, through Files' own door.
  await openSearch()
  await type('lines')
  await run.until('every source answered', 15_000, settled)
  const fileRow = await run.page<string | null>(`[...document.querySelectorAll('[data-work-search-list] [role="option"]')].find((el) => el.textContent.includes('Budget lines.csv'))?.getAttribute('data-row') ?? null`)
  run.check('a file is found by its name', !!fileRow && (await moveTo(fileRow)), (await list()).join(' | '))
  await key('Enter')
  await run.until('the picker closed', 5_000, async () => !(await open()))
  await run.until('the file has a tab', 10_000, async () => JSON.stringify(await run.call('work.files.tabs', { workspaceId: cosmic })).includes('Budget lines.csv'))
  await sleep(1500)
  run.check('Return on it opens the file in a Files tab of its job, the Files place shown', (await windowJob()) === 'Cosmic' && JSON.stringify(await run.call('work.files.tabs', { workspaceId: cosmic })).includes('Budget lines.csv') && (await run.page<boolean>(`!!document.querySelector('[data-files-seat], [data-files-row], [data-files-details]') || document.body.textContent.includes('Budget lines.csv')`)))
  await run.shot('05c-file-in-files')
  // Back to Unify by the mail again, so what follows stands where it did.
  await openSearch()
  await type('Q4')
  await run.until('every source answered', 15_000, settled)
  await moveTo('hit:lifeos:mailThreads:m3')
  await key('Enter')
  await run.until('the window moved', 10_000, async () => (await windowJob()) === 'Unify')
  await sleep(800)

  // Recent: what he just opened.
  await openSearch()
  await run.until('Recent', 8_000, async () => (await list()).some((r) => r.includes('hit:lifeos:mailThreads:m3')))
  run.check('nothing typed shows Recent: what he opened, the newest first', (await list()).join(' | ') === `# Recent | > hit:lifeos:mailThreads:m3 |   ${fileRow} |   hit:lifeos:rawMessages:r1`, (await list()).join(' | '))
  await run.shot('06-recent')

  // The key again narrows to the window's job, and again widens.
  await type('budget')
  await run.until('every source answered', 15_000, settled)
  run.check('it opens on all jobs', (await scope()) === 'All jobs', await scope())
  await key('k', { ctrl: true, shift: true })
  await run.until('narrowed', 8_000, async () => (await scope()) === 'Unify' && (await settled()))
  const narrowed = await list()
  run.check("⌘⇧K again narrows to the window's job", (await scope()) === 'Unify' && !narrowed.some((r) => r.includes('m1') || r.includes('p1')) && narrowed.some((r) => r.includes('m3')), `${await scope()}: ${narrowed.join(' | ')}`)
  run.check('in one job the job column is gone', (await run.page<number>(`document.querySelectorAll('[data-work-search-list] [data-job]').length`)) === 0)
  await run.shot('07-one-job')
  await key('k', { ctrl: true, shift: true })
  await run.until('widened', 8_000, async () => (await scope()) === 'All jobs' && (await settled()))
  run.check('and again widens', (await scope()) === 'All jobs')

  // One kind alone: Return on "All mail for …", Escape steps out, Escape closes.
  run.check('the highlight reaches All mail', await moveTo('all:mail'))
  await key('Enter')
  await run.until('one kind', 8_000, async () => (await run.page<string>(`document.querySelector('[data-picker-leading]')?.textContent ?? ''`)) === 'Mail' && (await settled()))
  const mails = await list()
  run.check('Return on it shows all the mail in reach and nothing else', mails.filter((r) => r.includes('hit:lifeos:mailThreads')).length === 6 && mails.filter((r) => r.startsWith('# ')).length === 0, mails.join(' | '))
  await run.shot('08-one-kind')
  await key('Escape')
  await sleep(400)
  run.check('Escape steps back out of the kind', (await open()) && !(await run.page<boolean>(`!!document.querySelector('[data-picker-leading]')`)))
  await run.until('every source answered', 15_000, settled)
  run.check('onto the row he came in by', (await selected()) === 'all:mail', String(await selected()))
  await key('Escape')
  await run.until('closed', 5_000, async () => !(await open()))
  run.check('a second Escape closes', !(await open()))

  // A thread in the other job: the window follows it there.
  await openSearch()
  await type('launch')
  await run.until('every source answered', 15_000, settled)
  run.check('the highlight reaches the thread in Cosmic', await moveTo(`hit:thread:${inCosmic}`))
  await key('Enter')
  await run.until('the window moved back', 10_000, async () => (await windowJob()) === 'Cosmic')
  run.check('Return on a thread in another job opens it there', (await windowJob()) === 'Cosmic' && !(await open()), await windowJob())
  await run.shot('09-thread-in-other-job')

  // The mark on the rail opens it too.
  await run.press('Search Work').catch(() => false)
  const pressed = await run.page<boolean>(`(() => { const b = document.querySelector('[aria-label="Search Work"]'); if (!b) return false; b.click(); return true })()`)
  await run.until('the picker opens from the mark', 8_000, open)
  run.check("a click on the rail's mark opens it", pressed && (await open()))
  await key('Escape')
  await run.until('closed', 5_000, async () => !(await open()))

  // A right-click on a row: the same two verbs, with their keys.
  await openSearch()
  await type('budget')
  await run.until('every source answered', 15_000, settled)
  const at = await run.page<{ x: number; y: number } | null>(`(() => { const r = document.querySelector('[data-row="hit:lifeos:mailThreads:m1"]')?.getBoundingClientRect(); return r ? { x: r.left + 120, y: r.top + r.height / 2 } : null })()`)
  if (at) {
    await run.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
    await run.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'right', clickCount: 1 })
    await run.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'right', clickCount: 1 })
  }
  const menu = (): Promise<string[]> => run.page<string[]>(`[...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent.trim())`)
  await run.until('the row menu', 8_000, async () => (await menu()).length > 0)
  const verbs = await menu()
  run.check("a right-click on a row offers Open and New thread about this, with their keys", verbs.length === 2 && verbs[0].startsWith('Open') && verbs[1].startsWith('New thread about this'), verbs.join(' | '))
  await run.shot('10-row-menu')
  await key('Escape')
  await sleep(400)
  if (await open()) await key('Escape')
  await run.until('closed', 5_000, async () => !(await open()))

  // ── the agents' tool ─────────────────────────────────────────────────
  const mine = textOf(await run.tool(inCosmic, 'work_search', { query: 'budget' }))
  run.check("a thread in Cosmic finds Cosmic's things", mine.includes('Budget for the spring launch') && mine.includes('Bea Budgett') && mine.includes('mailThreads:m1'))
  run.check("and nothing of Unify's, of a sector with no job, or of a code thread", !mine.includes('Q4 budget draft') && !mine.includes('offsite') && !mine.includes('whistles') && !mine.includes('parser'), mine.slice(0, 300))
  const wide = textOf(await run.tool(chat, 'work_search', { query: 'budget', kinds: ['mail', 'thread'], limit: 10 }))
  run.check('a Work Chat finds every job, and says which', wide.includes('Q4 budget draft') && wide.includes('(Sam Ortiz;') && /Unify/.test(wide) && /Cosmic/.test(wide) && wide.includes('Work Chats'))
  const listed = await run.call<{ tools: { name: string }[] }>('app.workTools', { sessionId: code.id, token: run.workToken(code.id), appToken: run.appToken(code.id) }).then((r) => r.tools.map((t) => t.name), () => [])
  run.check('a code thread is listed no work_search', !listed.includes('work_search'))
  void inUnify
  await run.finish()
} catch (err) {
  await run.finish(err)
}
