import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import type { OutboxItem } from '../src/shared/contract-work-outbox'
import { ownMailbox, PREFIX, Run, sleep, textOf, TOOLS } from './e2e-work-lib'

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
    join(TOOLS, 'docling-venv/3.12.16/bin/python3'),
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
  run.check('sheet_read answers the week', !read.isError && DAYS.every((d) => text.includes(String(d[2]))), text.slice(0, 300))
  const revenue = DAYS.map((d) => d[2]).filter((v) => text.includes(String(v)))
  const total = revenue.reduce((n, v) => n + v, 0)

  // Its own idea on his file: the revenue total. He set the sheet to suggest, so it waits.
  await run.call('work.sheets.mode', { itemId: item.id, mode: 'suggests' })
  const sugg = await run.tool(thread, 'sheet_write', { item: item.id, cells: [{ at: 'Week!C7', f: 'SUM(C2:C6)' }], because: 'own', reason: 'The week has no revenue total.' })
  run.check("the agent's own cell waits as a suggestion", !sugg.isError && /suggest/i.test(textOf(sugg)), textOf(sugg).slice(0, 200))

  // The report, drafted to himself with what it read.
  const body = [`Week 47: ${TOTAL} in revenue over ${DAYS.length} days.`, ...DAYS.map(([d, s, r]) => `${d}: ${s} sessions, ${r}`), 'A test from TempCode\'s end-to-end proof. Please ignore it.'].join('\n')
  const d = await run.addon(thread, 'draft_mail', { account_id: box._id, to: [{ address: box.address }], subject: `${PREFIX} weekly report, week 47`, body, reason: 'E2E-49 report proof: discarded at the end' })
  run.check('the thread drafted the report', !d.isError, textOf(d).slice(0, 200))
  const draftId = (JSON.parse(textOf(d)) as { id: string }).id
  run.later('discard the draft', () => run.mutation('compose:discard', { id: draftId }).catch(() => null))
  run.check('the figures it read add up to the sheet\'s', total === TOTAL, `${total} vs ${TOTAL}`)
  let held: OutboxItem | undefined
  run.check('the report waits in the Outbox', await run.until('held', 60_000, async () => !!(held = (await run.call<{ items: OutboxItem[] }>('work.outbox.list', {})).items.find((i) => (i.ref as { id?: string }).id === draftId))))
  const full = await run.call<OutboxItem>('work.outbox.get', { ref: held!.ref })
  run.check('what would go is the report with the figures', JSON.stringify(full.payload).includes(`${TOTAL} in revenue`), JSON.stringify(full.payload).slice(0, 300))

  // The window: the thread with its sheet, then the Outbox's view of the report.
  await run.show(thread)
  run.check('the grid draws the sheet', await run.until('grid', 60_000, () => run.page<boolean>(`!!document.querySelector('[data-sheet-item] canvas')`)))
  await sleep(3000)
  await run.shot('01-sheet-beside-thread', { clipLeft: 460 })

  // His part: he takes the total, and leaves the mail unsent.
  const review = await run.call<{ suggestions?: { id: string }[]; changeSets?: { id: string }[] }>('work.sheets.review', { itemId: item.id, which: 'all', verdict: 'accept' }).catch((e: Error) => ({ error: e.message }))
  run.note(`review: ${JSON.stringify(review).slice(0, 200)}`)
  const after = textOf(await run.tool(thread, 'sheet_read', { item: item.id, range: 'Week!C7' }))
  run.check('the accepted total is in the file', after.includes(String(TOTAL)) || after.includes('SUM(C2:C6)'), after.slice(0, 200))
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
