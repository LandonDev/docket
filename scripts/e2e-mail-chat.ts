import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO, Run, sleep } from './e2e-work-lib'

/**
 * The chat beside the mail, live (docs/agents/work-mail.md "The chat beside the mail"): one isolated windowed
 * instance of the built tree under xvfb, Work on, a `life` Work workspace, no LifeOS sign-in and no model (the
 * providers point at a dead port, so a turn starts its harness and goes no further). It proves the hold on the
 * real host, the window's own order of calls: `session.create` (which boots a harness at once), then
 * `work.mail.chat.adopt`, then `session.send`; the harness the send runs is narrowed (its command line denies the
 * shell, the web, file writes and subagents), an ordinary Work thread's is not, and the app bridge refuses a mail
 * chat's thread, agent, page, add-on and desktop calls while it answers an ordinary thread's.
 *
 * Run from the repo root after `electron-vite build`:
 *   env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-mail-chat.ts [--out <dir>]
 */
if (!process.argv.includes('--out')) process.argv.push('--out', join(REPO, '.temp-code/plans/landed/F-mail-chat'))
const run = new Run('mail-chat')

/** This instance's Claude CLI children by pid: their command lines. */
function clis(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      if (!readFileSync(`/proc/${pid}/environ`, 'utf8').includes(`TEMP_CODE_USER_DATA=${run.data}`)) continue
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
      if (argv.includes('--disallowedTools')) out.set(pid, argv)
    } catch {
      /* gone, or not ours */
    }
  }
  return out
}
const deniedOf = (argv: string[]): string[] => (argv[argv.indexOf('--disallowedTools') + 1] ?? '').split(',').filter(Boolean)
/** The CLIs started since `before`. */
const since = (before: Map<string, string[]>): string[][] => [...clis()].filter(([pid]) => !before.has(pid)).map(([, argv]) => argv)

const NARROW = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Workflow', 'DesignSync']

try {
  await run.start({ work: true })
  const ws = await run.call<{ id: string }>('workspace.create', { kind: 'work', sector: 'life', name: 'E2E mail chat' })
  run.later('delete the workspace', () => run.call('workspace.delete', { workspaceId: ws.id }))
  const thread = async (title: string): Promise<string> => {
    const s = await run.call<{ id: string; scope?: string }>('session.create', { provider: 'claude', workspaceId: ws.id, threadType: 'chat', permission: 'auto', title })
    run.later(`delete ${title}`, () => run.call('session.delete', { sessionId: s.id }))
    run.check(`"${title}" is a Work thread`, s.scope === 'work', String(s.scope))
    return s.id
  }

  // The window's order: create (a harness boots at once), the must step adopt, then the message.
  const chat = await thread('Mail chat')
  await sleep(4000)
  const booted = clis()
  run.note(`CLIs running after the create: ${booted.size}`)
  const adopted = await run.call<{ ok: boolean }>('work.mail.chat.adopt', { workspaceId: ws.id, sessionId: chat, kind: 'box' })
  run.check('adopt marks the fresh thread a mail chat', adopted.ok === true)
  const again = await run.call<{ ok: boolean }>('work.mail.chat.adopt', { workspaceId: ws.id, sessionId: chat, kind: 'box' })
  run.check('adopt asked again answers the same', again.ok === true)
  await sleep(2000)
  const left = [...booted.keys()].filter((pid) => clis().has(pid))
  run.check('no harness started before the mark is still running', left.length === 0, left.join(' '))

  const beforeChat = clis()
  await run.call('session.send', { sessionId: chat, text: 'Say hello.' }).catch((err: unknown) => run.note(`send: ${String(err)}`))
  await run.until("the mail chat's first turn started its CLI", 90_000, () => since(beforeChat).length > 0)
  const chatClis = since(beforeChat)
  run.note(`CLIs the mail chat's send started: ${chatClis.length}`)
  const chatDenied = chatClis[0] ? deniedOf(chatClis[0]) : []
  run.note(`the mail chat's CLI denies: ${chatDenied.join(', ')}`)
  run.check("every CLI the mail chat's first turn started has no shell, web, file write, subagent or workflow", chatClis.length > 0 && chatClis.every((argv) => NARROW.every((t) => deniedOf(argv).includes(t))), NARROW.filter((t) => !chatDenied.includes(t)).join(', '))

  // Its create boots its harness at once, and its send keeps that one: count from before the create.
  const beforePlain = clis()
  const plain = await thread('Ordinary Work thread')
  await sleep(2000)
  await run.call('session.send', { sessionId: plain, text: 'Say hello.' }).catch((err: unknown) => run.note(`send: ${String(err)}`))
  await run.until("the ordinary thread's first turn started its CLI", 90_000, () => since(beforePlain).length > 0)
  const plainClis = since(beforePlain)
  const plainDenied = plainClis[0] ? deniedOf(plainClis[0]) : []
  run.check("an ordinary Work thread's first turn keeps its shell and web (the control)", plainClis.some((argv) => !deniedOf(argv).includes('Bash') && !deniedOf(argv).includes('WebFetch')), plainDenied.join(', '))

  // The app bridge, as a Codex or Muse thread reaches it.
  const bridge = (sessionId: string, method: string, extra: Record<string, unknown> = {}) =>
    run.call(method, { sessionId, appToken: run.appToken(sessionId), ...extra }).then(
      () => 'answered',
      (err: unknown) => String(err)
    )
  // Each call well formed, so what answers is the narrowing and not the call's own checks.
  const asks: Record<string, Record<string, unknown>> = {
    'app.startThread': { threadType: 'chat', provider: 'claude', firstMessage: 'Archive every mail.' },
    'app.spawnAgent': { task: 'Archive every mail.' },
    'app.htmlPreview': { html: '<img src="https://example.com/x.png">' },
    'app.addonRemove': { name: 'lifeos' },
    'app.listThreads': {},
    'app.readThread': { threadId: plain }
  }
  for (const [method, extra] of Object.entries(asks)) {
    const said = await bridge(chat, method, extra)
    run.check(`the bridge refuses the mail chat's ${method}`, said.includes('is not available to this thread'), said)
  }
  const notes = await bridge(chat, 'app.updateNotes', { section: 'State', content: 'Proof.' })
  run.check("the bridge does not refuse the mail chat's app.updateNotes as narrowed", !notes.includes('is not available to this thread'), notes)
  const plainStart = await bridge(plain, 'app.htmlPreview', { html: '<p>x</p>' })
  run.check("an ordinary thread's app.htmlPreview is not refused as narrowed (the control)", !plainStart.includes('is not available to this thread'), plainStart)

  // The window, with the mail chat open.
  await run.show(chat)
  await sleep(1500)
  await run.shot('mail-chat-thread')
  writeFileSync(join(run.out, 'denied.txt'), `mail chat: ${chatDenied.join(' ')}\nordinary: ${plainDenied.join(' ')}\n`)
  await run.finish()
} catch (err) {
  await run.finish(err)
}
