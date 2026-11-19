import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import type { OutboxItem } from '../src/shared/contract-work-outbox'
import { ownMailbox, PREFIX, PYTHON, Run, sleep, textOf } from './e2e-work-lib'

/**
 * Job 2 (milestone 49): a weekly report from a sheet to a held mail.
 *
 * A real .xlsx with the week's figures (written by openpyxl, as Excel files
 * come) sits in the workspace's folder. A Work thread opens it in its canvas,
 * reads the figures with `sheet_read`, suggests the week's total into the
 * sheet (an agent's own idea on his file waits as a suggestion), and drafts
 * the report to his own address with the figures it read. The draft waits in
 * the Outbox with exactly those figures; the owner accepts the suggestion and
 * discards the mail. Nothing is sent.
 */
const run = new Run('report')
const DAYS = [
  ['Monday', 12, 840],
  ['Tuesday', 9, 610],
  ['Wednesday', 14, 1020],
  ['Thursday', 11, 775],
  ['Friday', 7, 455]
] as const
const TOTAL = DAYS.reduce((n, d) => n + d[2], 0)
try {
  await run.start()
  await run.signIn('report')
  const box = await ownMailbox(run)
  const ws = await run.workspace(box.defaultSector, `${PREFIX} report`)
  const thread = await run.thread(ws, `${PREFIX} weekly report`, { firstMessage: 'Send me the weekly report from the sheet.' })

  // The week's sheet, as an Excel file.
  const file = join(run.work, `${PREFIX} week 47.xlsx`)
  execFileSync(
    PYTHON,
    [
      '-I',
      '-c',
      `import json, sys, openpyxl
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Week"
ws.append(["Day", "Sessions", "Revenue"])
for d in json.loads(sys.argv[2]): ws.append(d)
ws["A7"] = "Total"; ws["B7"] = "=SUM(B2:B6)"
wb.save(sys.argv[1])`,
      file,
      JSON.stringify(DAYS)
    ]
  )
  const item = await run.call<{ id: string }>('work.canvas.open', { sessionId: thread, kind: 'sheet', source: { at: 'file', host: run.host, path: file }, title: `${PREFIX} week 47` })
  run.check('the workbook opens as a sheet beside the thread', !!item.id)

  // The agent reads the figures.
  const read = await run.tool(thread, 'sheet_read', { item: item.id, range: 'Week!A1:C7' })
  const text = textOf(read)
  // What it read, row by row ("A2 \"Monday\"  |  B2 12  |  C2 840"): the report is made from this, not from the file the job wrote.
  const rows = [...text.matchAll(/^A(\d) "([A-Za-z]+)"\s+\|\s+B\1 (\d+)\s+\|\s+C\1 (\d+)$/gm)].map((m) => ({ day: m[2]!, sessions: Number(m[3]), revenue: Number(m[4]) }))
  run.check('sheet_read answers the week, row by row', !read.isError && rows.length === DAYS.length && rows.every((r, i) => r.day === DAYS[i]![0] && r.revenue === DAYS[i]![2]), text.slice(0, 300))
  const total = rows.reduce((n, r) => n + r.revenue, 0)

  // Its own idea on his file: the revenue total. He set the sheet to suggest, so it waits.
  await run.call('work.sheets.mode', { itemId: item.id, mode: 'suggests' })
  const sugg = await run.tool(thread, 'sheet_write', { item: item.id, cells: [{ at: 'Week!C7', f: 'SUM(C2:C6)' }], because: 'own', reason: 'The week has no revenue total.' })
  run.check("the agent's own cell waits as a suggestion", !sugg.isError && /suggest/i.test(textOf(sugg)), textOf(sugg).slice(0, 200))
  const waiting = await run.call<{ suggestions: unknown[] }>('work.sheets.open', { itemId: item.id })
  run.check('the sheet holds exactly that one suggestion', waiting.suggestions.length === 1, String(waiting.suggestions.length))

  // The report, drafted to himself with what it read.
  const body = [`Week 47: ${total} in revenue over ${rows.length} days.`, ...rows.map((r) => `${r.day}: ${r.sessions} sessions, ${r.revenue}`), 'A test from TempCode\'s end-to-end proof. Please ignore it.'].join('\n')
  const d = await run.addon(thread, 'draft_mail', { account_id: box._id, to: [{ address: box.address }], subject: `${PREFIX} weekly report, week 47`, body, reason: 'E2E-49 report proof: discarded at the end' })
  run.check('the thread drafted the report', !d.isError, textOf(d).slice(0, 200))
  const draftId = (JSON.parse(textOf(d)) as { id: string }).id
  run.later('discard the draft', () => run.mutation('compose:discard', { id: draftId }).catch(() => null))
  run.check("the figures it read add up to the week's", total === TOTAL, `${total} vs ${TOTAL}`)
  let held: OutboxItem | undefined
  run.check('the report waits in the Outbox', await run.until('held', 60_000, async () => !!(held = (await run.call<{ items: OutboxItem[] }>('work.outbox.list', {})).items.find((i) => (i.ref as { id?: string }).id === draftId))))
  const full = await run.call<OutboxItem>('work.outbox.get', { ref: held!.ref })
  const going = JSON.stringify(full.payload)
  run.check('what would go is the report with the figures it read', going.includes(`${TOTAL} in revenue`) && rows.every((r) => going.includes(`${r.day}: ${r.sessions} sessions, ${r.revenue}`)), going.slice(0, 300))

  // The window: the thread with its sheet, then the Outbox's view of the report.
  await run.show(thread)
  run.check('the grid draws the sheet', await run.until('grid', 60_000, () => run.page<boolean>(`!!document.querySelector('[data-sheet-item] canvas')`)))
  await sleep(3000)
  await run.shot('01-sheet-beside-thread', { clipLeft: 460 })

  // His part: he takes the total, and leaves the mail unsent.
  const review = await run.call<{ suggestions: unknown[] }>('work.sheets.review', { itemId: item.id, which: 'all', verdict: 'accept' })
  run.check('Accept all takes the suggestion', review.suggestions.length === 0, String(review.suggestions.length))
  // The file on disk, as Excel would open it.
  const onDisk = async () =>
    execFileSync(PYTHON, ['-I', '-c', 'import sys, openpyxl\nprint(openpyxl.load_workbook(sys.argv[1])["Week"]["C7"].value)', file], { encoding: 'utf8' }).trim()
  const saved = await run.until('saved', 30_000, async () => (await onDisk()) === '=SUM(C2:C6)')
  run.check('the accepted total is saved in the .xlsx on disk', saved, await onDisk())
  await run.page(`(() => { const el = [...document.querySelectorAll('button, a, [role=button]')].find((e) => /^Outbox\\d*$/.test(e.textContent.trim())); el?.click() })()`)
  await run.until('row', 20_000, () => run.has(`${PREFIX} weekly report`))
  await sleep(1200)
  await run.shot('02-report-held')
  const gone = await run.call<OutboxItem>('work.outbox.discard', { ref: held!.ref })
  run.check('he discards it; nothing was sent', gone.state === 'discarded' && gone.decidedBy === 'owner', gone.state)
} catch (err) {
  await run.finish(err)
}
await run.finish()
