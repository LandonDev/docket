import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FrameioEntry, FrameioStatus } from '@shared/contract-work-frameio'
import { VIEWER_DEFAULT_PLAYS, type MediaView } from '@shared/contract-work-media'
import type { OutboxItem } from '@shared/contract-work-outbox'
import type { CanvasItem, Trigger, TriggerSource } from '@shared/work'
import { setMediaRoots } from '../../media'
import { canvas } from '../canvas/index'
import { formats } from '../formats/index'
import { media } from '../media/index'
import { loadWorkModules } from '../modules'
import { outbox as outboxModule } from '../outbox/index'
import { cast, makeRig, until, type Rig } from '../outbox/rig'
import { challengeOf, configureFrameio, frameioConfig, memoryTokens } from './auth'
import { FakeFrameio } from './fakeFrameio'
import { hookPort, signedBy } from './hooks'
import { frameio } from './index'
import { annotationOf, FRAME_BASE, frameOfComment, shapesOf } from './map'

/**
 * The Frame.io pillar against a fake Frame.io that answers in V4's shapes
 * (fakeFrameio.ts), on a real database with the outbox, the canvas, the
 * jobs and the media pillar mounted beside it: the sign-in with PKCE, a
 * stack opened in the media canvas from Frame.io's rendition with its
 * comments on their frames, an agent's comment and new version held until
 * his press, and a reviewer's comment arriving by webhook to fire a
 * routine's trigger.
 */

let fake: FakeFrameio
let rig: Rig
let restore: () => void
const probed: string[] = []
let probeHeight = 1080

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })

beforeAll(async () => {
  await loadWorkModules()
  process.env.TEMP_CODE_FRAMEIO_HOOK_PORT = String(await freePort())
})
afterAll(() => {
  delete process.env.TEMP_CODE_FRAMEIO_HOOK_PORT
})
beforeEach(async () => {
  fake = await new FakeFrameio().start()
  probed.length = 0
  probeHeight = 1080
  restore = configureFrameio({
    api: fake.api,
    ims: fake.base,
    tokens: memoryTokens(),
    // ffprobe's answer for Frame.io's 24 fps H.264 rendition: 250 frames, 1080 high; it must read the copy the host downloaded.
    probe: async (path) => {
      probed.push(path)
      if (readFileSync(path).length !== 4096) throw new Error('not the rendition')
      return {
        probe: { kind: 'video', container: 'mov,mp4', size: 4096, mtimeMs: 1, width: (probeHeight * 16) / 9, height: probeHeight, rotation: 0, codec: 'h264', rate: { num: 24, den: 1 }, durationS: 250 / 24, frames: 250 },
        table: { kind: 'cfr', start: 0, rate: { num: 24, den: 1 }, count: 250 }
      }
    }
  })
  rig = await makeRig({ modules: [outboxModule, canvas, formats, media, frameio] })
  cast(rig)
  // The folders this host shows: the workspace, as the media host has them.
  mkdirSync(join(rig.dir, 'ws'), { recursive: true })
  setMediaRoots(() => [join(rig.dir, 'ws')])
})
afterEach(async () => {
  setMediaRoots(() => [])
  await rig.close()
  restore()
  await fake.stop()
})

const tool = (name: string, args: unknown) => rig.work.tools.call({ id: 't-work', scope: 'work' }, name, args, new AbortController().signal)
const text = (r: { content: unknown[] }): string => (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n')

async function signIn(): Promise<FrameioStatus> {
  const { url } = await rig.rpc<{ url: string }>('work.frameio.signIn', { clientId: 'adobe-native-client', redirectUri: 'https://tempcode.example.test/frameio/callback' })
  return rig.rpc<FrameioStatus>('work.frameio.finish', { url: fake.approve(url) })
}

async function openCut(): Promise<CanvasItem> {
  await signIn()
  return rig.rpc<CanvasItem>('work.frameio.open', { sessionId: 't-work', account: fake.account, fileId: 'file-v2' })
}

async function readyView(itemId: string): Promise<MediaView> {
  let view = await rig.rpc<MediaView>('work.media.view', { itemId, plays: [...VIEWER_DEFAULT_PLAYS] })
  for (let i = 0; i < 100 && !view.versions.every((v) => v.state === 'ready' || v.state === 'failed'); i++) {
    await new Promise((r) => setTimeout(r, 20))
    view = await rig.rpc<MediaView>('work.media.view', { itemId })
  }
  return rig.rpc<MediaView>('work.media.view', { itemId })
}

describe('the sign-in', () => {
  it('sends the person to Adobe with PKCE and keeps the tokens his code buys', async () => {
    const { url } = await rig.rpc<{ url: string }>('work.frameio.signIn', { clientId: 'adobe-native-client' })
    const q = new URL(url).searchParams
    expect(url.startsWith(`${fake.base}/ims/authorize/v2?`)).toBe(true)
    expect([q.get('response_type'), q.get('code_challenge_method'), q.get('scope')]).toEqual(['code', 'S256', 'openid,email,profile,offline_access,additional_info.roles'])
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:7697/frameio/callback')
    expect((await rig.rpc<FrameioStatus>('work.frameio.status')).pending).toBe(true)
    // An address from another sign-in is refused.
    const back = new URL(fake.approve(url))
    const forged = new URL(back)
    forged.searchParams.set('state', 'not-this-one')
    await expect(rig.rpc('work.frameio.finish', { url: forged.toString() })).rejects.toThrow('not from this sign-in')
    const status = await rig.rpc<FrameioStatus>('work.frameio.finish', { url: back.toString() })
    expect(status).toMatchObject({ signedIn: true, pending: false, clientId: 'adobe-native-client', user: { id: fake.me.id, name: 'Landon' } })
    expect(frameioConfig.tokens.read()?.refresh).toMatch(/^rt-/)
    expect(rig.pushes.some((p) => p.push === 'work.frameio')).toBe(true)
  })

  it('takes the answer on its own loopback redirect when the browser is on this machine', async () => {
    const port = await freePort()
    const { url } = await rig.rpc<{ url: string }>('work.frameio.signIn', { clientId: 'adobe-native-client', redirectUri: `http://127.0.0.1:${port}/frameio/callback` })
    const res = await fetch(fake.approve(url))
    expect(await res.text()).toBe('Signed in to Frame.io. You can close this tab.')
    expect((await rig.rpc<FrameioStatus>('work.frameio.status')).signedIn).toBe(true)
  })

  it('refreshes a token about to run out, and once on a 401', async () => {
    fake.expiresIn = 30
    await signIn()
    const first = frameioConfig.tokens.read()!.access
    await rig.rpc('work.frameio.browse', {})
    expect(frameioConfig.tokens.read()!.access).not.toBe(first)
    fake.expiresIn = 3600
    // Frame.io forgets the token: one refresh and the call goes through.
    fake.access.delete(frameioConfig.tokens.read()!.access)
    frameioConfig.tokens.write({ ...frameioConfig.tokens.read()!, expiresAt: Date.now() + 3_600_000 })
    expect((await rig.rpc<{ entries: FrameioEntry[] }>('work.frameio.browse', {})).entries).toHaveLength(1)
  })

  it('keeps the challenge to the S256 of the verifier', () => {
    expect(challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })
})

describe('browsing', () => {
  it('goes from accounts to workspaces to projects to a folder and a version stack, page by page', async () => {
    await signIn()
    const browse = async (p: object) => (await rig.rpc<{ entries: FrameioEntry[] }>('work.frameio.browse', p)).entries
    expect(await browse({})).toEqual([{ kind: 'account', id: 'acc-1', account: 'acc-1', name: 'Hypixel Studio' }])
    expect((await browse({ account: 'acc-1' })).map((e) => e.name)).toEqual(['Hypixel'])
    const [project] = await browse({ account: 'acc-1', kind: 'workspace', id: 'ws-hypixel' })
    expect(project).toMatchObject({ kind: 'project', name: 'Hypixel trailers', id: 'fld-root' })
    expect((await browse({ account: 'acc-1', kind: 'project', id: 'fld-root' })).map((e) => [e.kind, e.name])).toEqual([['folder', 'Cuts']])
    // Three rows over two pages of the fake's two.
    expect((await browse({ account: 'acc-1', kind: 'folder', id: 'fld-cuts' })).map((e) => [e.kind, e.name])).toEqual([
      ['stack', 'Cut 12'],
      ['file', 'thumbnail.png']
    ])
    expect((await browse({ account: 'acc-1', kind: 'stack', id: 'vs-cut12' })).map((e) => e.name)).toEqual(['cut12_v2.mov', 'cut12_v1.mov'])
    expect(text(await tool('frameio_browse', { account: 'acc-1', kind: 'stack', id: 'vs-cut12' }))).toContain('file “cut12_v2.mov” id file-v2')
  })

  it('says Frame.io is not signed in rather than calling it', async () => {
    const r = await tool('frameio_browse', {})
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('not signed in')
  })
})

describe('a file in the media canvas', () => {
  it("opens the stack oldest first from Frame.io's rendition, shared, with each comment on its frame", async () => {
    const item = await openCut()
    expect(item).toMatchObject({ kind: 'media', title: 'cut12_v2.mov', source: { at: 'frameio', account: 'acc-1', fileId: 'file-v1' } })
    const view = await readyView(item.id)
    expect(view.shared).toBe(true)
    expect(view.versions.map((v) => [v.n, v.name, v.state])).toEqual([
      [1, 'cut12_v1.mov', 'ready'],
      [2, 'cut12_v2.mov', 'ready']
    ])
    // The rendition, downloaded into Work's media root and served by the media host: no Frame.io address reaches the viewer.
    const play = view.versions[1].plays[0]
    expect(play).toMatchObject({ via: 'original', mime: 'video/mp4', table: { kind: 'cfr', count: 250 } })
    expect(play.via === 'original' && play.url.startsWith('tempcode-asset://')).toBe(true)
    expect(JSON.stringify(view)).not.toContain(fake.base)
    expect(probed.every((p) => p.startsWith(join(rig.dir, 'work-media', 'frameio-')))).toBe(true)
    const [v1, v2] = view.versions
    const byText = (t: string) => view.notes.find((n) => n.body === t)!
    // Frame.io's 25 is TempCode's frame 24: V4 counts from 1.
    expect(FRAME_BASE).toBe(1)
    expect(byText('The logo pops a frame early')).toMatchObject({
      state: 'kept',
      resolved: false,
      by: 'external:frameio:usr-dana',
      external: { service: 'frameio', author: 'Dana Lee' },
      anchor: { versionId: v2.id, frame: 24, durationFrames: 12, pin: { x: 0.5, y: 0.25 }, shapes: [{ tool: 'rect', color: '#F22237', x: 0.27, y: 0.12, w: 0.31, h: 0.53, width: 8 / 1080 }] }
    })
    expect(byText('Agreed, fixing')).toMatchObject({ by: 'owner', parentId: byText('The logo pops a frame early').id })
    expect(byText('Colour is good now')).toMatchObject({ by: 'owner', resolved: true, anchor: { frame: 240 } })
    expect(byText('Old cut note').anchor).toEqual({ versionId: v1.id, frame: 0 })
    // Opening it again makes no second item and no second copy of a comment.
    const again = await rig.rpc<CanvasItem>('work.frameio.open', { sessionId: 't-work', account: fake.account, fileId: 'file-v1' })
    expect(again.id).toBe(item.id)
    expect((await rig.rpc<MediaView>('work.media.view', { itemId: item.id })).notes).toHaveLength(4)
  })
})

describe('held posts', () => {
  it("holds an agent's comment at a frame, shows it waiting, and posts it at that frame once on his press", async () => {
    const item = await openCut()
    await readyView(item.id)
    const r = await tool('frameio_comment', { item: item.id, at: 48, until: 59, text: 'Hold the title a beat longer', region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } })
    expect(text(r)).toBe('Held: Comment on cut12_v2.mov at 0:02: “Hold the title a beat longer”. It waits in the Outbox for the person to post it; nothing went to Frame.io.')
    expect(fake.writes.filter((w) => w.path.endsWith('/comments'))).toEqual([])
    const waiting = (await rig.rpc<MediaView>('work.media.view', { itemId: item.id })).notes.find((n) => n.body === 'Hold the title a beat longer')!
    expect(waiting).toMatchObject({ state: 'suggested', anchor: { frame: 48, durationFrames: 12 } })
    const [held] = await rig.waiting()
    expect(held).toMatchObject({ kind: 'frameio.post', verb: 'Post', state: 'held', sessionId: 't-work' })

    expect(await rig.rpc<OutboxItem>('work.outbox.send', { ref: held!.ref })).toMatchObject({ state: 'sent' })
    const posted = fake.writes.filter((w) => w.method === 'POST' && w.path === '/v4/accounts/acc-1/files/file-v2/comments')
    expect(posted).toHaveLength(1)
    const data = (posted[0].body as { data: Record<string, unknown> }).data
    expect(data).toMatchObject({ text: 'Hold the title a beat longer', timestamp: 49, duration: 12 })
    expect(JSON.parse(String(data.annotation))).toEqual([{ tool: 'rect', color: '#F22237', size: 4, x: 0.1, y: 0.2, w: 0.3, h: 0.4 }])
    // The waiting note became Frame.io's comment, read back on the frame it was held at.
    const notes = (await rig.rpc<MediaView>('work.media.view', { itemId: item.id })).notes.filter((n) => n.body === 'Hold the title a beat longer')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ state: 'kept', by: 'owner', external: { service: 'frameio' }, anchor: { frame: 48, durationFrames: 12 } })
    // A second press posts nothing more.
    await rig.rpc('work.outbox.send', { ref: held!.ref })
    expect(fake.writes.filter((w) => w.path.endsWith('/comments'))).toHaveLength(1)
  })

  it('posts a waiting note the agent made with media_note, and a discarded post takes its note with it', async () => {
    const item = await openCut()
    await readyView(item.id)
    await tool('media_note', { item: item.id, at: 10, text: 'Audio dips here' })
    const note = (await rig.rpc<MediaView>('work.media.view', { itemId: item.id })).notes.find((n) => n.body === 'Audio dips here')!
    expect(note.state).toBe('suggested')
    expect(text(await tool('frameio_comment', { item: item.id, note: note.id }))).toContain('Held: Comment on cut12_v2.mov at 0:00')
    const [held] = await rig.waiting()
    await rig.rpc('work.outbox.discard', { ref: held!.ref })
    await until(() => true)
    await new Promise((r) => setTimeout(r, 50))
    expect((await rig.rpc<MediaView>('work.media.view', { itemId: item.id })).notes.some((n) => n.body === 'Audio dips here')).toBe(false)
    expect(fake.writes.filter((w) => w.path.endsWith('/comments'))).toEqual([])
  })

  it('holds a new version, then uploads it in parts and stacks it on top on his press', async () => {
    const item = await openCut()
    const file = join(rig.dir, 'ws', 'cut12_v3.mp4')
    writeFileSync(file, Buffer.alloc(5000, 7))
    // A link that points out of the shown folders is refused, whatever it is named.
    writeFileSync(join(rig.dir, 'secret.txt'), 'key')
    symlinkSync(join(rig.dir, 'secret.txt'), join(rig.dir, 'ws', 'cut_v4.mp4'))
    expect(text(await tool('frameio_add_version', { item: item.id, file: join(rig.dir, 'ws', 'cut_v4.mp4') }))).toContain('outside the folders this host shows')
    expect(text(await tool('frameio_add_version', { item: item.id, file }))).toBe(
      // Named by the file's name, never its local path.
      `Held: Add cut12_v3.mp4 as the next version of cut12_v2.mov in Frame.io. It waits in the Outbox for the person to post it; nothing went to Frame.io.`
    )
    // What goes is what was named when it was held: a rewrite after the hold does not reach Frame.io.
    writeFileSync(file, Buffer.alloc(5000, 9))
    expect(fake.writes).toEqual([])
    const [held] = await rig.waiting()
    expect(held).toMatchObject({ verb: 'Upload' })
    expect(await rig.rpc<OutboxItem>('work.outbox.send', { ref: held!.ref })).toMatchObject({ state: 'sent' })
    expect(fake.writes.map((w) => `${w.method} ${w.path.replace(/file-[0-9a-f]{8}/, 'file-new')}`)).toEqual([
      'POST /v4/accounts/acc-1/folders/fld-cuts/files/local_upload',
      'PATCH /v4/accounts/acc-1/files/file-new/move'
    ])
    const stack = fake.stacks.get('vs-cut12')!
    expect(stack.files).toHaveLength(3)
    expect(fake.files.get(stack.files[0])!.bytes.equals(Buffer.alloc(5000, 7))).toBe(true)
    const view = await rig.rpc<MediaView>('work.media.view', { itemId: item.id })
    expect(view.versions.map((v) => v.name)).toEqual(['cut12_v1.mov', 'cut12_v2.mov', 'cut12_v3.mp4'])
  })
})

describe('keeping notes in step', () => {
  it("moves a comment's note in place when it is read again at the picture's real height, keeping its id and the replies made here", async () => {
    probeHeight = 2160
    const item = await openCut()
    const first = (await rig.rpc<MediaView>('work.media.view', { itemId: item.id })).notes.find((n) => n.body === 'The logo pops a frame early')!
    expect(first.anchor.shapes![0].width).toBe(8 / 1080)
    const reply = await rig.rpc<{ id: string }>('work.media.note', { itemId: item.id, anchor: first.anchor, body: 'Our own reply', parentId: first.id })
    await readyView(item.id)
    expect(text(await tool('frameio_refresh', { item: item.id }))).toBe('Nothing new.')
    // A reviewer moves it in Frame.io: same note, new frame, the reply still there.
    const c = [...fake.comments.values()].find((x) => x.text === 'The logo pops a frame early')!
    c.timestamp = 31
    // The comment and Frame.io's reply on it, which sits on its anchor.
    expect(text(await tool('frameio_refresh', { item: item.id }))).toBe('2 note(s) changed.')
    const notes = (await rig.rpc<MediaView>('work.media.view', { itemId: item.id })).notes
    const moved = notes.find((n) => n.body === 'The logo pops a frame early')!
    expect([moved.id, moved.anchor.frame]).toEqual([first.id, 30])
    expect(notes.find((n) => n.id === reply.id)?.parentId).toBe(first.id)
  })
})

describe('webhooks as a trigger', () => {
  it('listens on 7696 unless told otherwise, the box service (with its own userData) included', () => {
    expect(hookPort({ TEMP_CODE_USER_DATA: '/srv/agents/temp-code-data' })).toBe(7696)
    expect(hookPort({ TEMP_CODE_FRAMEIO_HOOK_PORT: '0' })).toBe(0)
    expect(hookPort({ TEMP_CODE_FRAMEIO_HOOK_PORT: '7701' })).toBe(7701)
  })

  const fio = { at: 'frameio' as const, account: 'acc-1', fileId: 'file-v1' }
  const trigger: Extract<Trigger, { on: 'file' }> = { on: 'file', source: fio, by: 'someone-else' }
  const source = (): TriggerSource => frameio.triggers![0]

  it('waits, and says why, until the host has a public address', async () => {
    await signIn()
    expect(() => source().arm(trigger, () => {}, null)).toThrow('public address')
    await expect(rig.rpc('work.frameio.setPublicUrl', { url: 'http://box.example.test' })).rejects.toThrow('https')
    expect(source().words(trigger)).toBe('When someone else comments on it or adds a version in Frame.io')
    expect(() => source().arm({ ...trigger, source: { at: 'google', fileId: 'x' } } as never, () => {}, null)).toThrow('nothing watches files there yet')
  })

  it("fires on a reviewer's comment on any version of the stack, not on his own, and brings the comment into the open item", async () => {
    const item = await openCut()
    await rig.rpc('work.frameio.setPublicUrl', { url: 'https://box.example.test/' })
    fake.deliverTo = `http://127.0.0.1:${process.env.TEMP_CODE_FRAMEIO_HOOK_PORT}/frameio/hook`
    const fired: string[] = []
    const off = source().arm(trigger, (cause) => fired.push(cause), null)
    // A second routine in the same workspace, armed in the same tick, shares the one webhook.
    const offTwin = source().arm({ ...trigger, source: { ...fio, fileId: 'file-v2' } }, () => {}, null)
    await until(() => fake.hooks.size === 1)
    await new Promise((r) => setTimeout(r, 50))
    expect(fake.hooks.size).toBe(1)
    offTwin()
    const [hook] = fake.hooks.values()
    expect(hook).toMatchObject({ url: 'https://box.example.test/frameio/hook', workspace_id: 'ws-hypixel' })
    expect(hook.events).toEqual(expect.arrayContaining(['comment.created', 'file.versioned']))

    await fake.reviewerComments('file-v2', 'Can we try the blue logo?', 100)
    await until(() => fired.length === 1)
    expect(fired).toEqual(['Dana Lee commented in Frame.io: “Can we try the blue logo?”'])
    await until(() => rig.pushes.some((p) => p.push === 'work.media'))
    const view = await rig.rpc<MediaView>('work.media.view', { itemId: item.id })
    expect(view.notes.find((n) => n.body === 'Can we try the blue logo?')?.anchor.frame).toBe(99)

    // His own comment comes into the item but fires nothing.
    await fake.reviewerComments('file-v2', 'Noted', 5, fake.me)
    await new Promise((r) => setTimeout(r, 100))
    expect(fired).toHaveLength(1)
    // A delivery not signed with the webhook's secret is refused.
    await fake.deliver('comment.created', { id: [...fake.comments.keys()][0], type: 'comment' }, fake.reviewer, { badSecret: true })
    expect(fake.deliveries.at(-1)).toEqual({ status: 401, type: 'comment.created' })
    // A new version by someone else fires too.
    await fake.deliver('file.versioned', { id: 'file-v2', type: 'file' }, fake.reviewer)
    await until(() => fired.length === 2)
    expect(fired[1]).toBe('A new version was added in Frame.io')
    // A new public address: the old webhook goes, the armed routine makes one for the new address.
    await rig.rpc('work.frameio.setPublicUrl', { url: 'https://tunnel.example.test' })
    await until(() => [...fake.hooks.values()].some((h) => h.url === 'https://tunnel.example.test/frameio/hook'))
    expect(fake.hooks.size).toBe(1)
    await fake.reviewerComments('file-v1', 'Still heard', 3)
    await until(() => fired.length === 3)
    off()
    await fake.reviewerComments('file-v2', 'After the routine went', 7)
    await new Promise((r) => setTimeout(r, 100))
    expect(fired).toHaveLength(3)
  })

  it('follows a file that stood alone into the stack a reviewer makes, and adds the new version to the open item', async () => {
    await signIn()
    fake.files.set('file-solo', { ...fake.files.get('file-v1')!, id: 'file-solo', name: 'promo.mov', parent_id: 'fld-cuts' })
    const item = await rig.rpc<CanvasItem>('work.frameio.open', { sessionId: 't-work', account: fake.account, fileId: 'file-solo' })
    await rig.rpc('work.frameio.setPublicUrl', { url: 'https://box.example.test' })
    fake.deliverTo = `http://127.0.0.1:${process.env.TEMP_CODE_FRAMEIO_HOOK_PORT}/frameio/hook`
    const fired: string[] = []
    const off = source().arm({ ...trigger, source: { ...fio, fileId: 'file-solo' } }, (cause) => fired.push(cause), null)
    await until(() => fake.hooks.size === 1)
    // A comment on the lone file first: its group is read, and not kept.
    await fake.reviewerComments('file-solo', 'First pass', 2)
    await until(() => fired.length === 1)
    // Dana uploads promo_v2 and stacks it on the file.
    fake.files.set('file-solo2', { ...fake.files.get('file-v2')!, id: 'file-solo2', name: 'promo_v2.mov', parent_id: 'vs-promo' })
    fake.stacks.set('vs-promo', { id: 'vs-promo', name: 'promo', parent_id: 'fld-cuts', project_id: 'prj-1', files: ['file-solo2', 'file-solo'] })
    fake.files.get('file-solo')!.parent_id = 'vs-promo'
    await fake.deliver('file.versioned', { id: 'file-solo2', type: 'file' }, fake.reviewer)
    await until(() => fired.length === 2)
    await until(() => rig.pushes.some((p) => p.push === 'work.media' && (p as { view: MediaView }).view.versions.length === 2))
    expect((await rig.rpc<MediaView>('work.media.view', { itemId: item.id })).versions.map((v) => v.name)).toEqual(['promo.mov', 'promo_v2.mov'])
    await fake.reviewerComments('file-solo2', 'Better', 4)
    await until(() => fired.length === 3)
    off()
  })
})

describe('the mapping', () => {
  it('reads Frame.io frames from 1 and timecodes from 00:00:00:00', () => {
    expect(frameOfComment(1)).toBe(0)
    expect(frameOfComment(25)).toBe(24)
    expect(frameOfComment(null)).toBeUndefined()
    expect(frameOfComment('00:00:01:00', { num: 24, den: 1 })).toBe(24)
  })

  it('round-trips rects, lines and arrows; sends an oval as its box and a stroke as lines, and says so', () => {
    const shapes = [
      { tool: 'rect' as const, color: '#00FF00', width: 0.004, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      { tool: 'line' as const, color: '#FFFFFF', width: 0.004, x1: 0, y1: 0, x2: 1, y2: 1 },
      { tool: 'arrow' as const, color: '#FFFFFF', width: 0.004, x1: 0.2, y1: 0.2, x2: 0.5, y2: 0.6 }
    ]
    const { annotation, lossy } = annotationOf(shapes, 1000)
    expect(lossy).toEqual([])
    expect(shapesOf(annotation, 1000).shapes).toEqual(shapes)
    const more = annotationOf([{ tool: 'ellipse', color: '#FFFFFF', width: 0.004, cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.1 }, { tool: 'pen', color: '#FFFFFF', width: 0.004, points: [[0, 0], [0.1, 0.1], [0.2, 0]] }], 1000)
    expect(JSON.parse(more.annotation!).map((s: { tool: string }) => s.tool)).toEqual(['rect', 'line', 'line'])
    expect(more.lossy).toEqual(['an oval goes as its box', 'a drawn line goes as straight lines'])
    // An undocumented stroke with points reads as a pen; one with nothing to read is left out and counted.
    expect(shapesOf(JSON.stringify([{ tool: 'freehand', color: '#000000', size: 5, points: [{ x: 0.1, y: 0.2 }] }, { tool: 'text' }]), 1000)).toEqual({
      shapes: [{ tool: 'pen', color: '#000000', width: 0.005, points: [[0.1, 0.2]] }],
      skipped: 1
    })
  })

  it("checks a delivery's signature and its time", () => {
    const body = '{"type":"comment.created"}'
    const ts = '1763500000'
    const sig = `v0=${createHmac('sha256', 's3cret').update(`v0:${ts}:${body}`).digest('hex')}`
    expect(signedBy('s3cret', ts, body, sig, 1763500100)).toBe(true)
    expect(signedBy('s3cret', ts, body, sig, 1763500400)).toBe(false)
    expect(signedBy('other', ts, body, sig, 1763500100)).toBe(false)
    expect(signedBy('s3cret', ts, `${body} `, sig, 1763500100)).toBe(false)
  })
})
