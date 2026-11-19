/**
 * Milestone 46's work set (scripts/ios-sim-proof.sh `work`): a host with
 * Work on, two Work workspaces with a thread each, an add-on whose
 * `send_mail` the owner holds (the fake MCP server, which only records it),
 * and held acts written into the hold as `ctx.held.create` writes them: a
 * mail, a post, and a send that failed. Everything but the held rows goes
 * over the admin key's own socket, as a phone or desktop would ask.
 * `verifyWork` reads back what the phone's presses did.
 */
import { resolve } from 'node:path'

type Answer = { ok: boolean; result?: unknown; error?: string }
export type WorkSeedReady = { baseUrl: string; controlUrl: string; adminKey: string }

async function socket(ready: WorkSeedReady): Promise<{ call: <T>(method: string, params?: unknown) => Promise<T>; close: () => void }> {
  const res = await fetch(`${ready.baseUrl}/api/ticket`, { method: 'POST', headers: { Authorization: `Bearer ${ready.adminKey}` } })
  const { ticket } = (await res.json()) as { ticket: string }
  const ws = new WebSocket(`${ready.baseUrl.replace(/^http/, 'ws')}/ws?ticket=${ticket}`)
  const waiting = new Map<string, (a: Answer) => void>()
  let hello: (() => void) | null = null
  const helloSeen = new Promise<void>((r) => (hello = r))
  ws.addEventListener('message', (ev) => {
    const frame = JSON.parse(String(ev.data)) as { id?: string; push?: string; ok?: boolean; result?: unknown; error?: string }
    if (frame.push === 'hello') hello?.()
    if (frame.id && waiting.has(frame.id)) {
      waiting.get(frame.id)!({ ok: !!frame.ok, result: frame.result, error: frame.error })
      waiting.delete(frame.id)
    }
  })
  await new Promise<void>((ok, bad) => {
    ws.addEventListener('open', () => ok())
    ws.addEventListener('error', () => bad(new Error('work seed: the admin socket failed')))
  })
  await helloSeen
  let next = 1
  const call = <T>(method: string, params: unknown = {}): Promise<T> =>
    new Promise((ok, bad) => {
      const id = `w${next++}`
      const timer = setTimeout(() => bad(new Error(`timeout: ${method}`)), 60_000)
      waiting.set(id, (a) => {
        clearTimeout(timer)
        if (a.ok) ok(a.result as T)
        else bad(new Error(`${method}: ${a.error}`))
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  return { call, close: () => ws.close() }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const WORK_MAIL_ID = 'm46-mail'
export const WORK_MAIL_SUBJECT = 'Ballroom for April 10'
/** What the work set's edit writes over the subject, read back by `verifyWork`. */
export const WORK_MAIL_EDITED = 'Ballroom for Saturday, April 10'

/** The Work thread the transcript and Results shots open (TC_TEST_THREAD). */
export const WORK_THREAD_TITLE = 'Venue for the spring LAN'

export async function seedWork(ready: WorkSeedReady, repo: string): Promise<{ purdue: string; unify: string; addonId: string }> {
  const s = await socket(ready)
  try {
    await s.call('work.set', { enabled: true })
    const purdue = await s.call<{ id: string }>('workspace.create', { kind: 'work', name: 'Purdue Esports', sector: 'purdue' })
    const unify = await s.call<{ id: string }>('workspace.create', { kind: 'work', name: 'Unify', sector: 'unify' })
    const t1 = await s.call<{ id: string }>('session.create', { scope: 'work', workspaceId: purdue.id, threadType: 'chat', provider: 'claude', model: 'claude-opus-5-5', title: 'Venue for the spring LAN' })
    const t2 = await s.call<{ id: string }>('session.create', { scope: 'work', workspaceId: unify.id, threadType: 'chat', provider: 'claude', model: 'claude-opus-5-5', title: 'Overdue invoices' })
    const fake = resolve(repo, 'scripts/lib/fakeMcpServer.ts')
    const { addon } = await s.call<{ addon: { id: string } }>('addons.set', {
      addon: { name: 'purdue-mail', workspaceId: purdue.id, description: 'Purdue mail', spec: { transport: 'stdio', command: process.execPath, args: [fake, '--stdio', '--mail'], env: [], auth: 'none' } }
    })
    for (let i = 0; i < 120; i++) {
      const listed = await s.call<{ tools: unknown[] }>('addons.tools', { id: addon.id }).catch((err: unknown) => { if (i % 20 === 19) console.error(`work seed: ${String(err)}`); return { tools: [] } })
      if (listed.tools.length > 0) break
      await sleep(500)
    }
    await s.call('work.outbox.setRules', { addonId: addon.id, rules: { send_mail: 'held', echo: 'held' } })
    // House rules (milestone 39): two rules, the second turned off.
    await s.call('work.rules.add', { workspaceId: purdue.id, text: 'Sign every mail “Landon”, never “Landon Johnson”.' })
    const off = await s.call<{ id: string }>('work.rules.add', { workspaceId: purdue.id, text: 'Put the date first in a subject line.' })
    await s.call('work.rules.edit', { id: off.id, on: false })
    const now = Date.now()
    const rows = [
      {
        id: WORK_MAIL_ID,
        workspaceId: purdue.id,
        sessionId: t1.id,
        sector: 'purdue',
        kind: 'addon.call',
        summary: 'Send to events booking',
        verb: 'Send',
        createdAt: now - 20 * 60_000,
        payload: {
          addonId: addon.id,
          addon: 'Purdue mail',
          tool: 'send_mail',
          words: 'Send mail',
          arguments: {
            to: 'events@purdue.edu',
            subject: WORK_MAIL_SUBJECT,
            text: 'Hello,\n\nI’d like to hold the ballroom on Saturday, April 10 from 9:00 AM to 6:00 PM for a student esports LAN of about 120 people. Could you confirm it is free and send the booking form?\n\nThanks,\nLandon'
          }
        }
      },
      {
        id: 'm46-post',
        workspaceId: purdue.id,
        sessionId: t1.id,
        sector: 'purdue',
        kind: 'addon.call',
        summary: 'Post in Esports staff',
        verb: 'Post',
        createdAt: now - 40 * 60_000,
        payload: { addonId: addon.id, addon: 'Purdue mail', tool: 'echo', words: 'Echo', arguments: { text: 'Spring LAN is set for April 10.' } }
      },
      {
        id: 'm46-failed',
        workspaceId: unify.id,
        sessionId: t2.id,
        sector: 'unify',
        kind: 'addon.call',
        summary: 'Send to Rivera Dental',
        verb: 'Send',
        state: 'failed',
        error: 'The add-on is no longer on this host.',
        createdAt: now - 60 * 60_000,
        payload: { addonId: 'billing-gone', addon: 'Billing desk', tool: 'send_mail', words: 'Send mail', arguments: { to: 'office@riveradental.com', subject: 'Invoice 1042 is 14 days past due', text: 'A reminder that invoice 1042 for $1,850.00 was due on November 4.' } }
      }
    ]
    // The post's held call in the thread's transcript, and two Results the thread wrote (one with a way back).
    const transcript = [{ sessionId: t1.id, heldId: 'm46-post', tool: 'mcp__app__purdue-mail__echo' }]
    const results = [
      { id: 'm46-r1', sessionId: t1.id, workspaceId: purdue.id, kind: 'cells', summary: 'Added Dietary needs', account: 'Spring LAN registration', undo: { pillar: 'forms', verb: 'remove_field', args: { id: 'f1' } } },
      { id: 'm46-r2', sessionId: t1.id, workspaceId: purdue.id, kind: 'doc', summary: 'Changed the date to April 10', account: 'LAN poster' }
    ]
    const written = await fetch(`${ready.controlUrl}/work-held`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rows, transcript, results }) })
    if (!written.ok) throw new Error(`work seed: /work-held answered ${written.status}: ${await written.text()}`)
    return { purdue: purdue.id, unify: unify.id, addonId: addon.id }
  } finally {
    s.close()
  }
}

/** What the host holds after the phone's presses: the mail sent as edited, and what still waits. */
export async function verifyWork(ready: WorkSeedReady): Promise<string[]> {
  const s = await socket(ready)
  try {
    const lines: string[] = []
    const mail = await s.call<{ state: string; payload: { arguments?: { subject?: string } }; decidedBy: string | null; result: { summary: string } | null }>('work.outbox.get', { ref: { at: 'host', id: WORK_MAIL_ID } })
    const subject = mail.payload.arguments?.subject
    lines.push(`${mail.state === 'sent' ? 'PASS' : 'FAIL'} the held mail was sent from the phone (state ${mail.state}, decided by ${mail.decidedBy ?? 'nobody'}${mail.result ? `, "${mail.result.summary}"` : ''})`)
    lines.push(`${subject === WORK_MAIL_EDITED ? 'PASS' : 'FAIL'} what went is the phone's edit (subject "${subject}")`)
    const post = await s.call<{ state: string; grantId: string | null }>('work.outbox.get', { ref: { at: 'host', id: 'm46-post' } })
    const grants = await s.call<{ grants: { label: string }[] }>('work.outbox.grants', {})
    lines.push(`${grants.grants.length > 0 ? 'PASS' : 'FAIL'} a grant was made from the post's Send menu (${grants.grants.map((g) => `"${g.label}"`).join(', ') || 'none'})`)
    lines.push(`${post.state === 'sent' ? 'PASS' : 'FAIL'} the post went after its grant (state ${post.state})`)
    const waiting = await s.call<{ waiting: number }>('work.outbox.list', {})
    lines.push(`INFO ${waiting.waiting} still wait`)
    // A stretch since the seed (decided.since stamped when Away went on) tells a cycle from a press that never landed.
    const away = await s.call<{ state: { enabled: boolean; at: number }; decided: { since: number } }>('away.get', {})
    const cycled = !away.state.enabled && away.decided.since > 0 && away.state.at > away.decided.since
    lines.push(`${cycled ? 'PASS' : 'FAIL'} Away went on and off from the phone (${away.state.enabled ? 'still on' : away.decided.since > 0 ? 'off' : 'never on'})`)
    return lines
  } finally {
    s.close()
  }
}

/** Milestone 47's Work thread: every canvas kind the phone draws, open in one thread (TC_TEST_SEGMENT=item). */
export const ITEMS_THREAD_TITLE = 'Spring LAN check-in'
/** The comment the work set posts at a frame of the video, read back by `verifyWorkItems`. */
export const MEDIA_COMMENT = 'Logo flickers here'

/** A small PDF of `pages` pages, each with a heading and a line, written by hand (no PDF library here). */
function pdfOf(pages: string[][]): Buffer {
  const objects: string[] = []
  const add = (body: string): number => objects.push(body)
  const catalog = add('')
  const tree = add('')
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const kids: number[] = []
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`)
  for (const lines of pages) {
    const text = lines.map((l, i) => `BT /F1 ${i === 0 ? 28 : 14} Tf 72 ${720 - i * 40} Td (${esc(l)}) Tj ET`).join('\n')
    const content = add(`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`)
    kids.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`))
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`
  objects[tree - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out)
}

/**
 * Opens one item of every kind in a new Purdue Work thread through `work.canvas.open`, as the desktop's
 * canvas does, writes the rows a model tool would make behind a form and a dashboard, and holds a browser
 * submit for the thread. Each kind the test server cannot serve is a line saying so, with its error.
 */
export async function seedWorkItems(ready: WorkSeedReady & { environmentId: string }, purdue: string): Promise<{ sessionId: string; lines: string[] }> {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const host = ready.environmentId
  const s = await socket(ready)
  const lines: string[] = []
  try {
    // The files go in the workspace's own folder: a key names paths only inside the app-managed roots.
    const workspaces = await s.call<{ id: string; path: string }[]>('workspace.list', {})
    const dir = `${workspaces.find((w) => w.id === purdue)!.path}/Spring LAN`
    mkdirSync(dir, { recursive: true })
    const thread = await s.call<{ id: string }>('session.create', { scope: 'work', workspaceId: purdue, threadType: 'chat', provider: 'claude', model: 'claude-opus-5-5', title: ITEMS_THREAD_TITLE })
    const sessionId = thread.id
    const open = async (kind: string, title: string, source: unknown): Promise<string | null> => {
      try {
        const item = await s.call<{ id: string }>('work.canvas.open', { sessionId, kind, title, source })
        return item.id
      } catch (err) {
        lines.push(`NOT RUN ${kind} "${title}": ${String(err)}`)
        return null
      }
    }
    const probe = async (kind: string, method: string, params: unknown): Promise<void> => {
      try {
        await s.call(method, params)
        lines.push(`OK ${kind}: ${method} answered`)
      } catch (err) {
        lines.push(`FAIL ${kind}: ${method}: ${String(err)}`)
      }
    }

    // A media item is ready once the host has cut what the phone plays: the proxy's last segment, or the tiles.
    type Play = { via: string; ended?: boolean }
    const ready_ = async (kind: string, itemId: string, done: (plays: Play[]) => boolean): Promise<void> => {
      const t0 = Date.now()
      let last = ''
      while (Date.now() - t0 < 180_000) {
        try {
          const view = await s.call<{ versions: { state: string; error?: string | null; plays: Play[] }[] }>('work.media.view', { itemId, plays: ['hls', 'tiles'] })
          const v = view.versions.at(-1)
          last = v ? `${v.state}${v.error ? `: ${v.error}` : ''}` : 'no version'
          if (v?.state === 'failed') break
          if (v && done(v.plays)) {
            lines.push(`OK ${kind}: prepared for the phone in ${Math.round((Date.now() - t0) / 1000)} s`)
            return
          }
        } catch (err) {
          last = String(err)
        }
        await sleep(2000)
      }
      lines.push(`FAIL ${kind}: not prepared for the phone (${last})`)
    }
    const pdfPath = `${dir}/Spring LAN floor plan.pdf`
    writeFileSync(pdfPath, pdfOf([
      ['Spring LAN floor plan', 'Arena A: 120 seats in six rows.'],
      ['Power', 'Two 30 A runs on the east wall.'],
      ['Network', 'One switch per row, uplink at the stage.'],
      ['Check-in', 'Badges at the south doors from 8:30 AM.']
    ]))
    const pdf = await open('pdf', 'Spring LAN floor plan', { at: 'file', host, path: pdfPath })
    if (pdf) await probe('pdf', 'work.pdf.open', { itemId: pdf })

    const ffmpeg = (args: string[]) => spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8' })
    // The media pillar runs the host's installed conversion tools: this machine's ffmpeg stands in for them.
    const ffmpegDir = spawnSync('sh', ['-c', 'dirname "$(command -v ffmpeg)"'], { encoding: 'utf8' }).stdout.trim()
    if (ffmpegDir && ffmpegDir !== '.') {
      const tools = await fetch(`${ready.controlUrl}/work-held`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rows: [], tools: { ffmpeg: ffmpegDir } }) })
      if (!tools.ok) lines.push(`FAIL /work-held tools: ${tools.status}`)
    }
    const mp4 = `${dir}/LAN promo.mp4`
    // The phone plays what the host cuts as HLS, which it does only past ten minutes (media/plan.ts HLS_OVER_S),
    // and a picture as tiles only past 40 megapixels (TILES_OVER_MP): a shorter clip or a smaller picture never
    // plays on the phone. So eleven minutes, small and quick to cut, and an 8000 by 5200 picture.
    const made = ffmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=660:size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=660', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4])
    if (made.status !== 0) lines.push(`NOT RUN media video: ffmpeg failed: ${made.stderr}`)
    else {
      const video = await open('media', 'LAN promo', { at: 'file', host, path: mp4 })
      if (video) await ready_('media video', video, (p) => p.some((x) => x.via === 'hls' && x.ended === true))
    }
    const png = `${dir}/Arena seating.png`
    const shot = ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=8000x5200', '-frames:v', '1', png])
    if (shot.status !== 0) lines.push(`NOT RUN media picture: ffmpeg failed: ${shot.stderr}`)
    else {
      const picture = await open('media', 'Arena seating', { at: 'file', host, path: png })
      if (picture) await ready_('media picture', picture, (p) => p.some((x) => x.via === 'tiles'))
    }

    const browser = await open('browser', 'Arena booking', { at: 'browser', host, sessionId })
    if (browser) await probe('browser', 'work.browser.state', { sessionId })

    const vtt = `${dir}/LAN staff sync.vtt`
    writeFileSync(vtt, [
      'WEBVTT', '',
      '00:00:01.000 --> 00:00:06.000', '<v Karen Mills>We have the arena from 9 to 6 on the tenth.</v>', '',
      '00:00:06.500 --> 00:00:12.000', '<v Landon Hale>Good. Check-in opens at 8:30, badges at the south doors.</v>', '',
      '00:00:12.500 --> 00:00:18.000', '<v Tom Reyes>I will bring two more switches for the back rows.</v>', '',
      '00:00:18.500 --> 00:00:24.000', '<v Karen Mills>Then we are set. I will send the booking form today.</v>', ''
    ].join('\n'))
    const meeting = await open('meeting', 'LAN staff sync', { at: 'file', host, path: vtt })
    if (meeting) await probe('meeting', 'work.meetings.start', { itemId: meeting })

    const form = await open('form', 'Spring LAN sign-up', { at: 'thread' })
    const dash = await open('dashboard', 'Spring LAN numbers', { at: 'thread' })
    const formBody = {
      title: 'Spring LAN sign-up',
      description: 'Saturday, April 10 in the CoRec arena.',
      questions: [
        { id: 'q1', label: 'Your name', type: 'short', required: true },
        { id: 'q2', label: 'Game', type: 'choice', required: true, options: ['Valorant', 'Rocket League', 'Overwatch 2'] },
        { id: 'q3', label: 'Dietary needs', type: 'long', required: false }
      ]
    }
    const by = { kind: 'agent', host, sessionId }
    const blocks = [
      { id: 'b1', kind: 'heading', text: 'Sign-ups' },
      {
        id: 'b2', kind: 'figures', figures: [
          { id: 'f1', label: 'Players', sub: 'of 120 seats', format: 'number', from: { service: 'Sign-up sheet', counts: 'Rows with a name' }, value: '96' },
          { id: 'f2', label: 'Budget left', format: 'money', from: { service: 'Budget sheet', counts: 'Budget less spent' }, value: '$214' }
        ]
      },
      { id: 'b3', kind: 'text', text: 'Valorant fills first; Rocket League has room.' },
      { id: 'b4', kind: 'chart', title: 'Sign-ups by week', format: 'number', from: { sheet: { at: 'file', host, path: `${dir}/signups.tcsheet` }, sheetTitle: 'Sign-ups', range: 'B2:B5', counts: 'New names each week', labels: 'A2:A5' }, bars: [{ label: 'W1', value: 18 }, { label: 'W2', value: 31 }, { label: 'W3', value: 22 }, { label: 'W4', value: 25 }] },
      { id: 'b5', kind: 'table', title: 'By game', from: { sheet: { at: 'file', host, path: `${dir}/signups.tcsheet` }, sheetTitle: 'Sign-ups', range: 'D1:E4', counts: 'Players per game' }, head: ['Game', 'Players'], rows: [['Valorant', '40'], ['Rocket League', '24'], ['Overwatch 2', '32']], numeric: [false, true], proposed: { by, reason: 'Shows where the seats went', at: Date.now() } }
    ]
    const res = await fetch(`${ready.controlUrl}/work-held`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rows: [{
          id: 'm47-browser-submit', workspaceId: purdue, sessionId, sector: 'purdue', kind: 'computer.act', verb: 'Submit',
          summary: 'Submit the arena booking form', createdAt: Date.now() - 2 * 60_000,
          payload: { app: { name: 'Chromium', bundleId: 'org.chromium.Chromium' }, action: 'left_click', element: 'button "Submit booking"', url: 'https://recwell.purdue.edu/book' }
        }],
        forms: form ? [{ itemId: form, sessionId, body: { ...formBody, questions: [] } }] : [],
        dashboards: dash ? [{ itemId: dash, sessionId, title: 'Spring LAN numbers', blocks }] : []
      })
    })
    if (!res.ok) lines.push(`FAIL /work-held for the M47 rows: ${res.status} ${await res.text()}`)
    if (form) {
      // His save, through the canvas's own method: the questions go in over the empty row form_create left.
      await probe('form', 'work.forms.save', { itemId: form, rev: 0, body: formBody })
      await probe('form', 'work.forms.responses', { itemId: form })
    }
    if (dash) await probe('dashboard', 'work.dashboards.open', { itemId: dash })

    // History keeps versions of a document: a .tcdoc on this host.
    const tcdoc = `${dir}/LAN poster.tcdoc`
    try {
      // work-kit has no exports map; the server reaches it through its path alias, this script by file.
      const kit = resolve(import.meta.dir, '../../node_modules/work-kit/src/formats')
      const { readMarkdown } = (await import(`${kit}/markdown/index.ts`)) as { readMarkdown: (text: string) => unknown }
      const { writeImportedTcdoc } = (await import(`${kit}/tcdoc/index.ts`)) as { writeImportedTcdoc: (path: string, imported: unknown) => Promise<unknown> }
      await writeImportedTcdoc(tcdoc, readMarkdown('# Spring LAN\n\nSaturday, April 10, 9:00 AM to 6:00 PM in the CoRec arena.\n\nBring your own headset.'))
    } catch (err) {
      lines.push(`INFO history: could not write a .tcdoc (${String(err)}); opening the path anyway`)
    }
    const history = await open('history', 'LAN poster history', { at: 'file', host, path: tcdoc })
    if (history) await probe('history', 'work.history.versions', { source: { at: 'file', host, path: tcdoc } })

    // Slides need a deck rendered to PDF; this Mac has no LibreOffice (soffice).
    const soffice = spawnSync('sh', ['-c', 'command -v soffice || ls /Applications/LibreOffice.app/Contents/MacOS/soffice'], { encoding: 'utf8' })
    if (soffice.status !== 0) lines.push('NOT RUN slides: no soffice on this Mac, so no deck can be rendered')
    return { sessionId, lines }
  } finally {
    s.close()
  }
}

/** What the work set's item presses left on the host: the video's comment at its frame. */
export async function verifyWorkItems(ready: WorkSeedReady, sessionId: string): Promise<string[]> {
  const s = await socket(ready)
  try {
    const lines: string[] = []
    const { items } = await s.call<{ items: { id: string; kind: string; title: string }[] }>('work.canvas.list', { sessionId })
    lines.push(`INFO ${items.length} items open in "${ITEMS_THREAD_TITLE}": ${items.map((i) => `${i.kind} "${i.title}"`).join(', ')}`)
    const video = items.find((i) => i.kind === 'media' && i.title === 'LAN promo')
    if (video) {
      const view = await s.call<{ notes?: { kind: string; body: string; anchor: { versionId: string; frame?: number } }[] }>('work.media.view', { itemId: video.id, plays: ['hls', 'tiles'] })
      const note = (view.notes ?? []).find((n) => n.kind === 'comment' && n.body === MEDIA_COMMENT)
      lines.push(`${note ? 'PASS' : 'FAIL'} the video's comment from the phone is on the host${note ? ` at anchor.frame ${note.anchor.frame} of version ${note.anchor.versionId}` : ''}`)
    }
    return lines
  } finally {
    s.close()
  }
}
