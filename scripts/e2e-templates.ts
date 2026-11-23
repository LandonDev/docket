import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { paragraphsOf, unescapeXml } from '../src/main/server/work/templates/ooxml'
import { partText, readZip } from '../src/main/server/work/templates/zip'
import { REPO, Run, sleep, textOf } from './e2e-work-lib'

/**
 * Templates per job, live (docs/agents/work-templates.md "Proofs"): the
 * pillar in the real host, on an isolated instance of the built app with a
 * dummy Work workspace. No LifeOS sign-in and no model turn: the shelf is
 * the host's own data.
 *
 *   electron-vite build, then:
 *   env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-templates.ts --out .temp-code/plans/landed/R3-templates/live
 *
 * The host's part: the wire (`work.templates.*`) through the router and the
 * fence, a starter made into the workspace's own folder with its fields
 * filled, Save as template, rename, move, hide and show, the confirm before
 * a delete, and `template_make` and `template_save` as a thread's bridge
 * calls them. The window's part runs when the Templates row is in the
 * column: a tile with fields is pressed, the fields are typed, and the file
 * is made; it is skipped, and said so, while the row waits for Files' new
 * view. Dummy names only.
 */
const run = new Run('templates')
const FIXTURES = join(REPO, 'src', 'main', 'server', 'work', 'templates', 'fixtures')

interface Template {
  id: string
  name: string
  kind: string
  where: string
  fields: string[]
  source: { at: string; path?: string }
}
interface Made {
  source: { at: string; host?: string; path?: string }
  kind: string
  title: string
  unfilled: string[]
}
const words = (path: string): string[] => {
  const xml = partText(readZip(new Uint8Array(readFileSync(path))).find((p) => p.name === 'word/document.xml')!)
  return paragraphsOf(xml, ['w:p'], 'w:t').map((runs) => runs.map((r) => unescapeXml(xml.slice(r.start, r.end))).join(''))
}
const refused = (p: Promise<unknown>): Promise<string> => p.then(() => '', (e: Error) => e.message)

try {
  await run.start()
  await sleep(3000)
  const ws = await run.call<{ id: string; path?: string }>('workspace.create', { kind: 'work', sector: 'ref', name: 'Dummy Officials' })
  run.later('delete the workspace', () => run.call('workspace.delete', { workspaceId: ws.id }))
  const list = async (): Promise<{ templates: Template[]; hidden: number }> => run.call('work.templates.list', { workspaceId: ws.id })

  // ── the shelf ─────────────────────────────────────────────────────
  const first = await list()
  const folder = ws.path ?? join(run.work, 'Dummy Officials')
  run.check('the workspace has a folder on this host', existsSync(folder), folder)
  run.note(`shelf: ${first.templates.map((t) => t.id).join(', ') || '(empty)'}`)
  const starters = first.templates.filter((t) => t.where === 'starter')
  run.check('the shelf answers over the wire, with our starters for the job and for every job', starters.some((t) => t.id.startsWith('starter:ref/')) && starters.some((t) => t.id.startsWith('starter:any/')), first.templates.map((t) => t.id).join(', '))
  run.check('a workspace that is none is refused in words', (await refused(run.call('work.templates.list', { workspaceId: 'nope' }))).includes('not a Work workspace'))

  // His own template for the job: a Word file whose field Word split over three runs, put in the job's Templates folder as he would.
  mkdirSync(join(folder, 'Templates'), { recursive: true })
  copyFileSync(join(FIXTURES, 'split.docx'), join(folder, 'Templates', 'Crew report.docx'))
  const own = (await list()).templates.find((t) => t.id === 'job:Crew report.docx')
  run.check('a file dropped in the Templates folder is on the shelf, first, with the fields it asks for', (await list()).templates[0]?.id === 'job:Crew report.docx' && JSON.stringify(own?.fields) === JSON.stringify(['Client', 'Site', 'Crew']), JSON.stringify(own))

  // ── a make, as his window sends it ────────────────────────────────
  const made = await run.call<Made>('work.templates.make', { workspaceId: ws.id, template: 'job:Crew report.docx', fields: { Client: 'Central at North', Crew: 'R, U1 & U2' }, today: '2026-11-23' })
  run.check('a make answers the file, its kind, its name and what is left to fill', made.kind === 'document' && made.title === 'Crew report - Central at North' && JSON.stringify(made.unfilled) === JSON.stringify(['Site']), JSON.stringify(made))
  const madePath = made.source.path ?? ''
  run.check("the file is in the workspace's own folder", madePath === join(folder, 'Crew report - Central at North.docx') && existsSync(madePath), madePath)
  const body = existsSync(madePath) ? words(madePath) : []
  run.check('the split field is filled, the day is the window\'s, and Site is left as written', body[0] === 'Game report for Central at North at {{Site}}.' && body[1]?.includes('on November 23, 2026.') === true, body.slice(0, 2).join(' | '))
  run.check('Job is the workspace\'s name', existsSync(madePath) && partText(readZip(new Uint8Array(readFileSync(madePath))).find((p) => p.name === 'word/header1.xml')!).includes('Dummy Officials'))
  const again = await run.call<Made>('work.templates.make', { workspaceId: ws.id, template: 'Crew report', fields: { Client: 'Central at North' }, today: '2026-11-23' })
  run.check('a second make of the same name never replaces the first', again.title === 'Crew report - Central at North 2' && readdirSync(folder).filter((n) => n.startsWith('Crew report - ')).length === 2, again.title)
  run.check('a make into a folder outside the workspace is refused in one sentence, and nothing is written there', (await refused(run.call('work.templates.make', { workspaceId: ws.id, template: 'Crew report', into: { at: 'file', host: run.host, path: run.root } }))).includes("made in this workspace's own folder") && !readdirSync(run.root).some((n) => n.endsWith('.docx')))
  run.check('no scratch folder is left', !existsSync(join(run.data, 'work-templates', 'scratch')) || readdirSync(join(run.data, 'work-templates', 'scratch')).length === 0)

  // A starter with fields, by name.
  const starter = starters.find((t) => t.id.startsWith('starter:ref/') && t.fields.length > 0)
  if (run.check('the job has a starter that asks for fields', !!starter)) {
    const fields = Object.fromEntries(starter!.fields.map((f, i) => [f, `Dummy ${i + 1}`]))
    const fromStarter = await run.call<Made>('work.templates.make', { workspaceId: ws.id, template: starter!.name, fields, today: '2026-11-23' })
    run.check(`the starter "${starter!.name}" makes a file with nothing left to fill`, fromStarter.unfilled.length === 0 && existsSync(fromStarter.source.path ?? ''), JSON.stringify(fromStarter))
  }

  // ── save, rename, move, remove ────────────────────────────────────
  const saved = await run.call<Template>('work.templates.save', { workspaceId: ws.id, source: made.source, name: 'Central report' })
  run.check('Save as template copies the made file onto the shelf and leaves it where it was', saved.id === 'job:Central report.docx' && JSON.stringify(saved.fields) === JSON.stringify(['Site']) && existsSync(madePath), JSON.stringify(saved))
  const renamed = await run.call<Template>('work.templates.rename', { workspaceId: ws.id, template: saved.id, name: 'North report' })
  run.check('rename gives it a new name', renamed.id === 'job:North report.docx')
  const moved = await run.call<Template>('work.templates.move', { workspaceId: ws.id, template: renamed.id, everywhere: true })
  run.check('"Use in all jobs" moves it to the host\'s own data', moved.id === 'all:North report.docx' && existsSync(join(run.data, 'work-templates', 'shared', 'North report.docx')) && !existsSync(join(folder, 'Templates', 'North report.docx')), moved.id)
  const ask = await run.call<{ confirm?: boolean }>('work.templates.remove', { workspaceId: ws.id, template: moved.id })
  run.check('remove of his own deletes nothing until the window says he agreed', ask.confirm === true && existsSync(join(run.data, 'work-templates', 'shared', 'North report.docx')), JSON.stringify(ask))
  await run.call('work.templates.remove', { workspaceId: ws.id, template: moved.id, confirmed: true })
  run.check('and deletes it once he did', !existsSync(join(run.data, 'work-templates', 'shared', 'North report.docx')))
  if (starter) {
    await run.call('work.templates.remove', { workspaceId: ws.id, template: starter.id })
    const hidden = await list()
    run.check('remove of a starter hides it in this workspace', hidden.hidden === 1 && !hidden.templates.some((t) => t.id === starter.id), `hidden ${hidden.hidden}`)
    await run.call('work.templates.unhide', { workspaceId: ws.id })
    run.check('Show hidden brings it back', (await list()).templates.some((t) => t.id === starter.id))
  }

  // ── a thread's tools ──────────────────────────────────────────────
  const thread = await run.thread(ws.id, 'E2E templates')
  const tools = await run.call<{ tools: { name: string }[] }>('app.workTools', { sessionId: thread, token: run.workToken(thread), appToken: run.appToken(thread) })
  run.check('a thread of the workspace is listed the three tools', ['template_list', 'template_make', 'template_save'].every((n) => tools.tools.some((t) => t.name === n)), tools.tools.filter((t) => t.name.startsWith('template')).map((t) => t.name).join(', '))
  const said = await run.tool(thread, 'template_make', { template: 'Crew report', fields: { Client: 'East at West', Site: 'Field 4', Crew: 'R, U1' }, title: 'East at West report' })
  run.note(`template_make: ${textOf(said)}`)
  const item = (said.structuredContent as { item?: string } | undefined)?.item
  run.check('template_make makes the file and opens it in the thread\'s canvas', !said.isError && !!item && existsSync(join(folder, 'East at West report.docx')), textOf(said))
  const items = await run.call<{ items?: { id: string; kind: string; title: string }[] } | { id: string; kind: string; title: string }[]>('work.canvas.list', { sessionId: thread })
  const open = Array.isArray(items) ? items : (items.items ?? [])
  run.check('the item is a document in that thread', open.some((i) => i.id === item && i.kind === 'document'), JSON.stringify(open).slice(0, 300))
  if (item) {
    const kept = await run.tool(thread, 'template_save', { item, name: 'East report' })
    run.check('template_save puts that item\'s file on the shelf', !kept.isError && (await list()).templates.some((t) => t.id === 'job:East report.docx'), textOf(kept))
  }
  const chat = await run.thread(null, 'E2E templates chat')
  const chatTools = await run.call<{ tools: { name: string }[] }>('app.workTools', { sessionId: chat, token: run.workToken(chat), appToken: run.appToken(chat) })
  run.check('a Work Chat, which has no workspace, is listed none of them', !chatTools.tools.some((t) => t.name.startsWith('template_')))

  // ── the window ────────────────────────────────────────────────────
  await run.page(`location.hash = ''`)
  await sleep(1500)
  await run.press('Dummy Officials', 'rail')
  await sleep(2000)
  if (await run.press('Templates')) {
    await run.until('the shelf paints', 20_000, () => run.has('All jobs'))
    await run.shot('01-shelf')
    const tile = starter?.name ?? 'Crew report'
    run.check(`the shelf shows "${tile}"`, await run.has(tile))
    if (await run.press(tile)) {
      await run.until('the fields', 10_000, () => run.has('Create'))
      await run.shot('02-fields')
      const typed = await run.page<number>(`(() => { const inputs = [...document.querySelectorAll('[role=dialog] input')]; inputs.forEach((el, i) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, 'Window ' + (i + 1)); el.dispatchEvent(new Event('input', { bubbles: true })) }); return inputs.length })()`)
      run.check('the dialog asks for each field', typed === (starter?.fields.length ?? 3), `${typed} inputs`)
      const before = readdirSync(folder).length
      await run.press('Create')
      const there = await run.until('the file is made', 20_000, () => readdirSync(folder).length > before)
      run.check('Create makes the file from the window', there, readdirSync(folder).join(', '))
      await sleep(2500)
      await run.shot('03-made')
    } else run.check('a tile can be pressed', false)
  } else run.note('the Templates row is not in the column (it waits for Files\' new view): the window\'s part was not run')
} catch (err) {
  await run.finish(err)
}
await run.finish()
