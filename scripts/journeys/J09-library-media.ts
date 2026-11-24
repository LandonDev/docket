import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeTab, openRow } from './lib/files'
import { fixtureTool } from './lib/fixtures'
import { fileAt, showPlace } from './lib/place'
import { journey, step } from './lib/record'
import { words } from './lib/shape'

const PICTURE = 'Practice picture.png'
const VIDEO = 'Practice clip.mp4'
const SOUND = 'Practice sound.wav'
const NOTE = 'Check this frame'
const NOTE_ROW = '[data-media-notes] [data-note]'

export default journey({
  id: 'J09',
  title: 'Open a picture, a recording and a video and keep a note on a frame',
  tier: 1,
  shapes: ['A', 'B1'],
  steps: [
    step('Open the picture and read its natural size', async (context) => {
      const { page, repo } = context.pair
      copyFileSync(join(repo, 'src/main/server/work/money/fixtures/gear.png'), fileAt(context, PICTURE))
      fixtureTool(context.folder, 'ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=24', '-t', '4', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', fileAt(context, VIDEO)])
      fixtureTool(context.folder, 'ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', fileAt(context, SOUND)])
      await showPlace(context)
      await openRow(page, PICTURE)
      await page.until('the picture drawn at a natural size', 35_000, () => page.eval(`[...document.querySelectorAll('[data-media-body] img')].some((img) => img.naturalWidth > 0 && img.naturalHeight > 0)`))
      await closeTab(page, PICTURE)
      await page.until('the picture tab to close', 10_000, () => page.tabClosed(PICTURE))
    }),
    step('Open the video, go to a frame and leave a comment', async ({ pair, folder }) => {
      const { page } = pair
      await openRow(page, VIDEO)
      await page.until('a loaded video with a duration', 55_000, () => page.eval(`[...document.querySelectorAll('video')].some((v) => v.readyState >= 2 && Number.isFinite(v.duration) && v.duration > 0)`))
      await page.clickOn('[role="slider"][aria-label="Frame"]')
      await page.key('ArrowRight')
      const shownFrame = () => page.eval<number>(`Number(document.querySelector('[role="slider"][aria-label="Frame"]')?.getAttribute('aria-valuenow'))`)
      await page.until('the scrubbed frame to draw', 12_000, async () => await shownFrame() > 0)
      const frame = await shownFrame()
      await page.press('button', 'Comment at this frame')
      await page.clickOn('textarea', 'Comment')
      await page.typeKeys(NOTE)
      await page.key('Enter')
      await page.until('the comment row', 12_000, () => page.eval(`[...document.querySelectorAll('${NOTE_ROW}')].some((row) => row.textContent.includes(${JSON.stringify(NOTE)}))`))
      const { Database } = await import('bun:sqlite')
      const db = new Database(join(pair.box.data, 'temp-code.db'), { readonly: true })
      try {
        const row = db.query<{ anchor: string }, [string]>('SELECT anchor FROM work_media_notes WHERE body = ?').get(NOTE)
        writeFileSync(join(folder, 'video-note.json'), JSON.stringify({ frame, stored: row && JSON.parse(row.anchor) }, null, 2))
        if (!row || JSON.parse(row.anchor).frame !== frame) throw new Error('Box did not store the comment at the frame shown')
      } finally {
        db.close()
      }
      await closeTab(page, VIDEO)
      await page.until('the video tab to close', 10_000, () => page.tabClosed(VIDEO))
    }),
    step('Open the sound and check its player is ready', async (context) => {
      const { pair, folder } = context
      const { page } = pair
      await page.eval(`(() => {
        const Audio = window.__journeyOriginalAudio = window.Audio;
        window.__journeyAudio = [];
        window.Audio = new Proxy(Audio, { construct(target, args) {
          const sound = Reflect.construct(target, args);
          window.__journeyAudio.push(sound);
          return sound;
        }});
      })()`)
      try {
        await page.watchToasts()
        page.appOpen.watch(fileAt(context, SOUND))
        await openRow(page, SOUND)
        await page.until('the sound player’s Play control', 25_000, async () => {
          const answer = page.appOpen.answer
          if (answer) throw new Error(answer.error ?? (answer.opened ? 'The library opens the sound in a system app, with no player in Files' : 'The system did not open the sound'))
          return page.centre('[data-meeting-player] button', 'Play')
        })
        await page.clickOn('[data-meeting-player] button', 'Play')
        const sound = () => page.eval<{ ready: number; duration: number } | null>(`(() => {
          const a = [...document.querySelectorAll('audio'), ...window.__journeyAudio].find((a) => a.readyState >= 2 && Number.isFinite(a.duration) && a.duration > 0);
          return a ? { ready: a.readyState, duration: a.duration } : null;
        })()`)
        await page.until('the sound player ready with its duration', 65_000, sound)
        writeFileSync(join(folder, 'sound.json'), JSON.stringify(await sound()))
      } catch (error) {
        await page.shot(join(folder, 'sound.png'))
        writeFileSync(join(folder, 'sound-error.json'), JSON.stringify({
          error: words(error), toasts: await page.toasts(), saveLine: await page.saveLine(), hostErrors: pair.hostErrors
        }))
      } finally {
        await page.eval('window.Audio = window.__journeyOriginalAudio; delete window.__journeyOriginalAudio; delete window.__journeyAudio')
      }
      if (!await page.tabClosed(SOUND)) {
        await closeTab(page, SOUND)
        await page.until('the sound tab to close', 10_000, () => page.tabClosed(SOUND))
      }
    }),
    step('end: the video still shows the timed comment after reopening and the sound played', async ({ pair, folder }) => {
      const { page } = pair
      await openRow(page, VIDEO)
      await page.until('the reopened video and timed comment', 30_000, () => page.eval(`[...document.querySelectorAll('${NOTE_ROW}')].some((row) => row.textContent.includes(${JSON.stringify(NOTE)}) && row.querySelector('time')?.textContent)`))
      const failure = join(folder, 'sound-error.json')
      if (existsSync(failure)) throw new Error(JSON.parse(readFileSync(failure, 'utf8')).error)
    })
  ]
})
