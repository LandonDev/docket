import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ImportAnswer } from '../src/shared/contract-work-formats'
import { PREFIX, PYTHON, REPO, Run, sleep, textOf } from './e2e-work-lib'

/**
 * Job 3 (milestone 49): a document from a .docx, through the agent's
 * suggestions, a guest's edit and an export.
 *
 * A Word file with a heading, paragraphs, a table and an outside reviewer's
 * comment (written by python-docx) is imported into a Work Chat's canvas; the
 * import says it holds others' words. The owner sets the document to suggest;
 * the agent's rewrite waits as a branch; the owner takes one change and then
 * the rest. The document goes out as .docx (read back by python-docx: the
 * accepted words, the table and the reviewer's comment), .odt and .md, and as
 * a PDF through Electron's print window (read back by pdfium).
 *
 * The guest's edit: guest links share LifeOS documents only, and a LifeOS
 * document needs the box's own Work service (the installed app on a Work
 * build). So this job's guest leg runs milestone 31's live proof: the real
 * Work service, the built hosted page in headless Chromium, a guest typing
 * into the owner's document and the owner's words reaching the guest (with a
 * fake LifeOS behind the service).
 */
const run = new Run('document')
const PY = PYTHON
const TITLE = `${PREFIX} supplier agreement`
try {
  await run.start()
  const thread = await run.thread(null, TITLE, { firstMessage: 'Tidy the supplier agreement.' })

  // The Word file, as a supplier would send it.
  const docx = join(run.root, `${TITLE}.docx`)
  execFileSync(PY, [
    '-I',
    '-c',
    `import sys, docx
d = docx.Document()
d.add_heading("Supplier agreement", 1)
p = d.add_paragraph("The supplier delivers within thirty days of each order.")
d.add_paragraph("Payment is due on receipt of the invoice.")
t = d.add_table(rows=3, cols=2)
for r, (a, b) in enumerate([("Item", "Price"), ("Chairs", "40"), ("Tables", "120")]):
    t.cell(r, 0).text = a; t.cell(r, 1).text = b
d.add_comment(p.runs, text="Can we make this fourteen days?", author="Dana Lee", initials="DL")
d.save(sys.argv[1])`,
    docx
  ])
  const imported = await run.call<ImportAnswer>('work.formats.import', { sessionId: thread, from: { at: 'bytes', name: `${TITLE}.docx`, data: readFileSync(docx).toString('base64') } }, 300_000)
  run.check('the .docx imports into the thread\'s canvas', !!imported.itemId && imported.source.at === 'file', JSON.stringify({ source: imported.source, warnings: imported.warnings }))
  run.check("the import says it holds someone else's words", imported.outsiders === true)
  const item = imported.itemId!
  const source = imported.source
  const read = async () => textOf(await run.tool(thread, 'doc_read', { item })).split('\n\n---\n')[0]!.replace(/^Others share this document\.\n\n/, '')
  const first = await read()
  run.check('the agent reads the heading, the words and the table', ['Supplier agreement', 'thirty days', 'Chairs', '120'].every((w) => first.includes(w)), first.slice(0, 300))
  const whole = textOf(await run.tool(thread, 'doc_read', { item }))
  run.check("the reviewer's comment came with it", whole.includes('fourteen days'), whole.slice(-300))

  // He sets it to suggest; the agent's rewrite waits as a branch.
  await run.call('work.docs.mode', { source, mode: 'suggests' })
  const rewrite = first.replace('within thirty days', 'within fourteen days').replace('on receipt of the invoice', 'within fifteen days of the invoice')
  const sugg = await run.tool(thread, 'doc_write', { item, because: 'own', markdown: rewrite })
  run.check("the agent's rewrite waits as suggestions", textOf(sugg).startsWith('Suggested'), textOf(sugg))
  run.check('the text is unchanged while they wait', (await read()).includes('thirty days'))
  await run.show(thread)
  run.check('the canvas draws the document with its suggestions', await run.until('tints', 45_000, () => run.page<boolean>(`!!document.querySelector('.bn-editor .te-ins') && document.querySelector('.bn-editor').textContent.includes('Supplier agreement')`)))
  await sleep(1500)
  await run.shot('01-suggestions', { clipLeft: 460 })
  const { branches } = await run.call<{ branches: { id: string }[] }>('work.history.branches', { source })
  run.check('one branch holds the agent\'s changes', branches.length === 1, JSON.stringify(branches).slice(0, 200))
  await run.call('work.history.decide', { source, branchId: branches[0]!.id, which: 'all', accept: true })
  run.check('Accept all takes them into the text', await run.until('taken', 20_000, async () => (await read()).includes('fourteen days of each order') || (await read()).includes('within fourteen days')))
  await sleep(1500)
  await run.shot('02-accepted', { clipLeft: 460 })

  // Export.
  mkdirSync(join(run.out, 'exports'), { recursive: true })
  for (const format of ['docx', 'odt', 'md'] as const) {
    const out = await run.call<{ name: string; data: string; warnings: string[] }>('work.formats.export', { source, format }, 300_000)
    writeFileSync(join(run.out, 'exports', out.name), Buffer.from(out.data, 'base64'))
    run.check(`it exports as .${format}`, out.data.length > 100, `${out.name}${out.warnings.length ? `; ${out.warnings.join('; ')}` : ''}`)
  }
  const back = execFileSync(PY, [
    '-I',
    '-c',
    `import sys, docx
d = docx.Document(sys.argv[1])
print("PARAS", " | ".join(p.text for p in d.paragraphs))
print("CELLS", " | ".join(c.text for t in d.tables for row in t.rows for c in row.cells))
print("COMMENTS", len(list(d.comments)), " | ".join(c.text for c in d.comments))`,
    join(run.out, 'exports', `${TITLE}.docx`)
  ]).toString()
  const paras = /^PARAS (.*)$/m.exec(back)?.[1] ?? ''
  run.check(
    "Word's own reader finds the accepted words, the table and the reviewer's comment in the .docx",
    paras.includes('within fourteen days of each order') && paras.includes('within fifteen days of the invoice') && !paras.includes('thirty days') && /^CELLS .*Tables/m.test(back) && /^COMMENTS 1 .*fourteen days\?/m.test(back),
    back.slice(0, 400)
  )
  const md = (await read()).replace(/\n/g, '<br>')
  const pdf = await run.call<{ name: string; data: string }>('work.formats.print', { name: TITLE, html: `<!doctype html><html><head><meta charset="utf-8"><title>${TITLE}</title></head><body><main>${md}</main></body></html>`, paper: 'Letter' }, 180_000)
  const pdfPath = join(run.out, 'exports', `${TITLE}.pdf`)
  writeFileSync(pdfPath, Buffer.from(pdf.data, 'base64'))
  const words = execFileSync(PY, ['-I', '-c', 'import sys, pypdfium2 as p\nd = p.PdfDocument(sys.argv[1])\nprint(len(d), d[0].get_textpage().get_text_range())', pdfPath]).toString()
  run.check("Electron's print window makes the PDF", readFileSync(pdfPath).subarray(0, 5).toString() === '%PDF-' && words.includes('fourteen days'), words.slice(0, 200))

  // The guest's edit: milestone 31's live proof, against this tree's built hosted page. E2E_GUEST=0 leaves it out
  // (a host with no headless Chromium for the proof, such as a Mac child's clone).
  if (process.env.E2E_GUEST === '0') {
    run.note('the guest leg is left out (E2E_GUEST=0)')
    await run.finish()
  }
  const guestShots = join(run.out, 'guest')
  mkdirSync(guestShots, { recursive: true })
  const guest = spawnSync('bunx', ['vitest', 'run', 'src/main/server/work/guests/live.proof.test.ts'], {
    cwd: REPO,
    env: { ...process.env, NODE_ENV: 'test', M31_PROOF: '1', M31_HOSTED: join(REPO, 'out/hosted'), M31_SHOTS: guestShots },
    encoding: 'utf8',
    timeout: 600_000
  })
  const tally = /Tests\s+(.*)/.exec(guest.stdout)?.[1] ?? guest.stdout.slice(-300)
  run.check("a guest edits the owner's document from the hosted page (M31's live proof)", guest.status === 0 && !/failed/.test(tally), tally)
} catch (err) {
  await run.finish(err)
}
await run.finish()
