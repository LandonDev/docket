import { execFileSync } from 'node:child_process'
import { connect } from 'node:net'
import { join } from 'node:path'
import { PREFIX, Run, sleep } from './e2e-work-lib'

/**
 * Job 6 (milestone 49): master with Work off is the app before Work.
 *
 * One isolated instance that has never had Work on is looked at: what the
 * rail and Settings offer, whether the Work service listens, what a Work
 * method answers, what Work tools a code thread is given, and the database's
 * tables. Then Work is turned on and used (a Work workspace, a Work Chat, an
 * Outbox row), and turned off again; everything is looked at again and must
 * match the never-on look, the database having only gained Work's own
 * tables and rows. The start paths and spawn options of code threads with
 * Work unset, off and on are held equal by the kept tests
 * (work/claude-driver.test.ts, work/switchOff.test.ts).
 */
const run = new Run('switchoff')
const listening = (port: number): Promise<boolean> =>
  new Promise((ok) => {
    const s = connect(port, '127.0.0.1')
    s.once('connect', () => (s.destroy(), ok(true)))
    s.once('error', () => ok(false))
  })
interface Look {
  rail: string[]
  settings: string[]
  service: boolean
  outbox: string
  codeTools: string
  tables: string[]
}
async function look(label: string, code: string): Promise<Look> {
  await run.page(`location.hash = ''`)
  await sleep(1500)
  const rail = await run.page<string[]>(`[...document.querySelectorAll('aside button, aside a, nav button, nav a, aside h2, aside [role=heading]')].filter((e) => e.getBoundingClientRect().left < 200 && e.offsetParent).map((e) => e.textContent.trim().replace(/\\d+$/, '')).filter(Boolean)`)
  await run.press('Settings', 'rail')
  await sleep(2000)
  // Settings puts its own list of pages where the rail was.
  await run.until('settings', 10_000, () => run.has('Appearance'))
  const settings = await run.page<string[]>(`[...document.querySelectorAll('button, a, [role=tab]')].filter((e) => e.getBoundingClientRect().left < 200 && e.offsetParent).map((e) => e.textContent.trim()).filter(Boolean)`)
  await run.shot(`${label}-settings`)
  await run.press('Back', 'rail')
  await sleep(1200)
  const outbox = await run.call('work.outbox.list', {}).then(() => 'answered', (e: Error) => e.message)
  const codeTools = await run.call<{ tools?: unknown[] }>('app.workTools', { sessionId: code, token: run.workToken(code), appToken: run.appToken(code) }).then((r) => JSON.stringify(r?.tools ?? r), (e: Error) => `refused: ${e.message}`)
  const tables = execFileSync('sqlite3', [join(run.data, 'temp-code.db'), `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`], { encoding: 'utf8' }).trim().split('\n')
  return { rail, settings, service: await listening(run.workPort), outbox, codeTools, tables }
}

try {
  await run.start({ work: false })
  await sleep(4000)
  const code = await run.call<{ id: string; scope?: string }>('session.create', { provider: 'claude', threadType: 'chat', title: `${PREFIX} code chat`, permission: 'auto' })
  run.check('a code thread is no Work thread', code.scope !== 'work')
  const before = await look('01-never-on', code.id)
  await run.shot('01-never-on')
  run.check('never on: the rail has no Work rows', !before.rail.some((t) => /^(Outbox|Work Chats|Work)$/.test(t)), before.rail.join(' | '))
  run.check('never on: no Work service listens', !before.service)
  run.check('never on: a Work method says Work is off', /off/i.test(before.outbox), before.outbox)
  run.check('never on: Settings has its pages, Work among them as the one switch', before.settings.includes('Appearance') && before.settings.includes('Work'), before.settings.join(' | '))

  // On, used, off.
  await run.call('work.set', { enabled: true })
  run.check('on: the Work service listens', await run.until('service', 30_000, () => listening(run.workPort)))
  const ws = await run.call<{ id: string }>('workspace.create', { kind: 'work', sector: 'life', name: `${PREFIX} switch` })
  const chat = await run.call<{ id: string; scope?: string }>('session.create', { scope: 'work', workspaceId: null, threadType: 'chat', provider: 'claude', title: `${PREFIX} work chat`, permission: 'auto' })
  run.check('on: a Work workspace and a Work Chat are made', !!ws.id && chat.scope === 'work')
  await sleep(2000)
  const on = await run.page<string[]>(`[...document.querySelectorAll('aside button, aside a, nav button, nav a')].filter((e) => e.getBoundingClientRect().left < 200 && e.offsetParent).map((e) => e.textContent.trim().replace(/\\d+$/, ''))`)
  run.check('on: the rail shows the Outbox and Work Chats', on.includes('Outbox') && on.includes('Work Chats'), on.join(' | '))
  await run.shot('02-on')
  await run.call('work.set', { enabled: false })
  await sleep(3000)

  const after = await look('03-off-again', code.id)
  await run.shot('03-off-again')
  run.check('off again: the rail is as it was before Work was ever on', JSON.stringify(after.rail) === JSON.stringify(before.rail), `${before.rail.join(' | ')}\n→ ${after.rail.join(' | ')}`)
  run.check('off again: Settings lists the same pages', JSON.stringify(after.settings) === JSON.stringify(before.settings), `${before.settings.join(' | ')} → ${after.settings.join(' | ')}`)
  run.check('off again: the Work service has stopped', !after.service)
  run.check('off again: a Work method says Work is off', after.outbox === before.outbox, after.outbox)
  run.check("off again: a code thread's Work tools are what they were", after.codeTools === before.codeTools, `${before.codeTools} → ${after.codeTools}`)
  const added = after.tables.filter((t) => !before.tables.includes(t))
  run.check('the database only gained tables, all of them Work\'s', before.tables.every((t) => after.tables.includes(t)) && added.every((t) => t.startsWith('work_')), added.join(', ') || 'none')
  const kept = await run.call<{ id: string; kind?: string }[]>('workspace.list').then((l) => l.find((w) => w.id === ws.id))
  run.check('the Work workspace is kept for when Work is on again', kept?.kind === 'work')
  await run.call('workspace.delete', { workspaceId: ws.id }).catch((e: Error) => run.note(`workspace.delete while off: ${e.message.slice(0, 160)}`))
  await run.call('session.delete', { sessionId: chat.id }).catch(() => null)
  await run.call('session.delete', { sessionId: code.id }).catch(() => null)
} catch (err) {
  await run.finish(err)
}
await run.finish()
