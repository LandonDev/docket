import { filesPaneWorkspace } from '@shared/work'
import type { ActKindDef, WorkModule } from '../modules'
import { copiesLeft, copySaved, retryWaiting, settleCopies } from './copies'
import { adoptWordCopies, autosaveWords, wordFollowed, wordImportPlace, wordsLeft } from './word'
import { closeFilesState, filesHandle, filesState, itemsGone, removeWorkspace } from './handle'
import { onFileSaved } from './save'
import { registerFileMoved, registerImportPlace } from './hooks'
import { repointLinks } from './places/lifeos'
import { setThreadsMayWrite } from './policy'
import { clearPreviewScratch, PREVIEW_CONVERTERS, prunePreviews } from './preview'
import { fileMentions } from './mention'
import { ensureFilesTables } from './tables'
import { fileActKind, filesPreamble, filesTools } from './tools'
import { purgeOld, removeTrashOf, settleTrash } from './trash'
import { pruneOps, settleOps } from './write'

/**
 * The files pillar's server module (docs/agents/work-files.md): the Files place of a Work workspace. Its
 * tables come from `ensure`; its methods are `work.files.*` (src/shared/contract-work-files.ts, answered in
 * handle.ts). The three registries a kind's pillar fills for it (hooks.ts) are their own state: nothing here
 * clears them, so a registration made before or after this module starts is kept.
 */
export const files: WorkModule = {
  id: 'files',
  ensure: ensureFilesTables,
  handle: (req, ctx, by, signal) => filesHandle(req, ctx, by, signal),
  // A thread changes files only through these: at once in his own places, held as a `file.act` where others can open them.
  tools: () => filesTools,
  acts: [fileActKind as ActKindDef],
  preamble: filesPreamble,
  // `@` a file: names across the workspace's places, his recents first (mention.ts).
  mentions: fileMentions,
  // ffmpeg's preview jobs: a video's frame and a picture scaled (preview.ts), run only on the file's own host.
  convert: PREVIEW_CONVERTERS,
  // Never touches the registries of hooks.ts: what a kind's pillar registered before this ran is still there after.
  start(ctx) {
    // The tools and the hold exist: a thread's change now runs in his own places and is held in shared ones (policy.ts).
    setThreadsMayWrite(true)
    try {
      // A tab whose item is gone and an item whose tab is gone are dropped once, before any window asks.
      const mended = filesState(ctx).tabs.check()
      if (mended.tabs || mended.items) ctx.log(`files: dropped ${mended.tabs} tabs with no item and ${mended.items} items with no tab`)
    } catch (err) {
      ctx.log(`files: the tabs could not be checked: ${err instanceof Error ? err.message : String(err)}`)
    }
    // The journal: a change a dead process left running is marked failed, and rows past a week go, now and once a day.
    const tidy = (): void => {
      try {
        settleOps(ctx.db)
        pruneOps(ctx.db)
      } catch (err) {
        ctx.log(`files: the journal could not be tidied: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    tidy()
    // Trash: what a dead process left half done is finished or undone, then rows held 30 days go, now and once a day.
    const purge = (): Promise<void> =>
      purgeOld(ctx).then(
        (n) => void (n && ctx.log(`files: emptied ${n} rows held in Trash past 30 days`)),
        (err) => ctx.log(`files: Trash could not be emptied of old rows: ${err instanceof Error ? err.message : String(err)}`)
      )
    void settleTrash(ctx)
      .then((done) => {
        if (done.held + done.undone + done.restored + done.purged) ctx.log(`files: Trash settled ${JSON.stringify(done)}`)
      })
      .catch((err) => ctx.log(`files: Trash could not be settled: ${err instanceof Error ? err.message : String(err)}`))
      .then(purge)
    // Previews: a render a dead process left goes from scratch, and the disk cache is held to 30 days and 2 GB, now and once a day.
    const prune = (): Promise<void> =>
      prunePreviews(ctx.dataDir).then(
        (done) => void (done.removed && ctx.log(`files: pruned ${done.removed} kept previews`)),
        (err) => ctx.log(`files: the previews could not be pruned: ${err instanceof Error ? err.message : String(err)}`)
      )
    void clearPreviewScratch(ctx.dataDir).catch(() => {}).then(prune)
    const daily = setInterval(() => {
      pruneOps(ctx.db)
      void purge()
      void prune()
    }, 24 * 60 * 60 * 1000)
    daily.unref?.()
    // A file Files renamed or moved: the LifeOS project links that named it follow it, after the move has landed.
    const offMoved = registerFileMoved((from, to) => {
      setImmediate(() => {
        try {
          repointLinks(ctx, from, to).catch((err: unknown) => ctx.log(`files: a project link did not follow ${from.at === 'file' ? from.path : 'a file'}: ${err instanceof Error ? err.message : String(err)}`))
        } catch (err) {
          ctx.log(`files: a project link did not follow a file: ${err instanceof Error ? err.message : String(err)}`)
        }
      })
    })
    // A copy saves back (copies.ts): a save through the door of a copy's path sends it; one that waited for its computer
    // is sent once that computer answers, looked at every 30 s while any waits.
    try {
      settleCopies(ctx)
      // A Word file's document an older build left in a copy's folder is kept, never dropped with its tab (word.ts).
      const adopted = adoptWordCopies(ctx, (id) => filesState(ctx).tabs.list(id).tabs)
      if (adopted) ctx.log(`files: kept ${adopted} Word document(s) an older build left in a copy's folder`)
    } catch (err) {
      ctx.log(`files: the copies could not be settled: ${err instanceof Error ? err.message : String(err)}`)
    }
    const offSaved = onFileSaved((path) => copySaved(ctx, path))
    // A Word file of another computer becomes a document in the workspace's own folder, kept for its next open (word.ts).
    const offPlace = registerImportPlace((original, itemId) => wordImportPlace(ctx, original, itemId))
    const offFollowed = ctx.canvas.onReplaced((old, next) => wordFollowed(ctx, old, next))
    // A Word file he chose to save by itself is written once his document has been still for a pause (word.ts).
    const words = setInterval(() => void autosaveWords(ctx).catch((err) => ctx.log(`files: Word autosave failed: ${err instanceof Error ? err.message : String(err)}`)), 1000)
    words.unref?.()
    const waiting = setInterval(() => {
      try {
        retryWaiting(ctx)
      } catch (err) {
        ctx.log(`files: the copies that wait were not sent: ${err instanceof Error ? err.message : String(err)}`)
      }
    }, 30_000)
    waiting.unref?.()
    return () => {
      offMoved()
      offSaved()
      offPlace()
      offFollowed()
      clearInterval(daily)
      clearInterval(waiting)
      clearInterval(words)
      closeFilesState(ctx.db)
    }
  },
  // An item of a Files pane closed by another way than its tab (the pane's own Close): its tab goes too.
  itemsRemoved(items, ctx) {
    const mine = items.filter((item) => filesPaneWorkspace(item.sessionId) !== null)
    if (!mine.length) return
    itemsGone(ctx, mine.map((item) => item.id))
    // A copy's item went however it went: what waits in the copy is kept and sent, never dropped with it.
    copiesLeft(ctx, mine)
    // A Word file's document he never changed goes; one he changed is kept for the file's next open (word.ts).
    wordsLeft(ctx, mine)
  },
  workspaceRemoved(workspaceId, ctx) {
    removeWorkspace(ctx, workspaceId)
    removeTrashOf(ctx, workspaceId)
  }
}
