import type { DatabaseSync } from 'node:sqlite'
import type { CanvasKind, CanvasSource } from '@shared/work'
import type { FileForm } from '@shared/work/fileForms'
import type { Caller, WorkCtx } from '../modules'

/**
 * What a canvas kind's own pillar tells Files (docs/agents/work-files.md "The seam with the editors"): how to
 * make a new file of its kind, how to draw a file's page as a picture, what to re-key when a file is
 * renamed or moved, and how many of an agent's suggestions wait in a file; and one pillar's word on how a file is seated (`registerSeatChooser`). Four registries, each empty until something registers. They are this file's own state
 * and no module's `start` touches them, so a pillar may register when it loads, before or after the files
 * module starts, and is kept either way.
 *
 * This file imports nothing but types: a pillar that registers here loads none of Files.
 */

/** Where a maker writes: a path of this host that does not exist yet, in a folder only Files reads. Files moves what was written into the place itself, never over another file. */
export interface FileMakeTarget {
  form: FileForm
  path: string
  /** the file's name without its extension: "Untitled document" */
  title: string
}

export interface FileMaker {
  /** The forms it writes and its editor then edits in place: New offers the kind in a place whose form is one of them. */
  forms: readonly FileForm[]
  /** Writes a blank file of `target.form` at `target.path`. */
  blank(target: FileMakeTarget): Promise<void>
}

/**
 * One page of a file as a PNG, `width` pixels wide; null when it has no such page or cannot be drawn here. A render
 * that knows how many pages the file has says so with `{ png, pages }`, which a preview's pager reads; a bare PNG
 * is a file of one page.
 */
export type FilePreviewer = (source: CanvasSource, opts: { page: number; width: number; signal?: AbortSignal }) => Promise<Uint8Array | { png: Uint8Array; pages: number } | null>

/**
 * A file was renamed or moved: re-key every row and folder this pillar keeps by the file's path. Called inside
 * the savepoint the rename runs in, before the file's items are re-pointed, so it is synchronous and a throw
 * undoes the whole rename.
 */
export type FileMoved = (from: CanvasSource, to: CanvasSource, at: { db: DatabaseSync; dataDir: string; host: string }) => void

/**
 * How many of an agent's suggestions wait in files, from the pillar's own tables and never a file's bytes: `count`
 * for the rows on screen (an answer in their order, 0 for a file it keeps none for), `files` for Home's Waiting on
 * you (every file of this host it keeps some for, `most` at most, by its source).
 */
export interface FileWaiting {
  count(sources: readonly CanvasSource[], db: DatabaseSync): number[]
  files(db: DatabaseSync, host: string, most: number): { source: CanvasSource; count: number }[]
}

/**
 * Where a document made of a file goes, when Files has a word for it (files/word.ts: a Word file of a Teams library
 * opened as a copy in a Files tab goes to the workspace's own folder, where his edits are kept); null: the importer's
 * own rule. `itemId` is the item the document will take the place of.
 */
export type ImportPlace = (original: string, itemId: string | undefined) => string | null

/** A file `work.files.open` names, as it names it. */
export interface SeatAsk {
  workspaceId: string
  ref: CanvasSource
  name?: string
  key?: string
  as?: CanvasKind
  beside?: string
  side?: string
}

/** A file seated another way than Files' own: its tab's key and name, its item, the file it is of, and the other computer's file it stands for. */
export interface Seat {
  key: string
  name: string
  kind: CanvasKind
  source: CanvasSource
  file: { host: string; path: string }
  copyOf?: { host: string; path: string; vm?: boolean }
}

/**
 * A pillar's word on how a file opens in a Files tab, asked once an open before Files seats it its own way (office/live:
 * a shared Office file remembered as Live opens as Word, Excel or PowerPoint on the web, with no copy made); null:
 * Files seats it as it would. A throw is the open's.
 */
export type SeatChooser = (ctx: WorkCtx, by: Caller, ask: SeatAsk, signal?: AbortSignal) => Promise<Seat | null>

const makers = new Map<CanvasKind, FileMaker>()
let importPlace: ImportPlace | null = null
let seatChooser: SeatChooser | null = null
const previewers = new Map<CanvasKind, FilePreviewer>()
const moved = new Set<FileMoved>()
const waiting = new Set<FileWaiting>()

/** A kind's maker; a later registration for the kind replaces the earlier. Returns its off. */
export function registerFileMaker(kind: CanvasKind, maker: FileMaker): () => void {
  makers.set(kind, maker)
  return () => void (makers.get(kind) === maker && makers.delete(kind))
}

/** A kind's page render; a later registration for the kind replaces the earlier. Returns its off. */
export function registerFilePreviewer(kind: CanvasKind, previewer: FilePreviewer): () => void {
  previewers.set(kind, previewer)
  return () => void (previewers.get(kind) === previewer && previewers.delete(kind))
}

/** One more thing to re-key on a rename; every one registered is called, in the order they registered. Returns its off. */
export function registerFileMoved(fn: FileMoved): () => void {
  moved.add(fn)
  return () => void moved.delete(fn)
}

/** One more pillar that keeps suggestions by file; every one registered is asked. Returns its off. */
export function registerFileWaiting(w: FileWaiting): () => void {
  waiting.add(w)
  return () => void waiting.delete(w)
}

/** Files' word on where an import goes (one at a time: a later one replaces the earlier). Returns its off. */
export function registerImportPlace(fn: ImportPlace): () => void {
  importPlace = fn
  return () => void (importPlace === fn && (importPlace = null))
}
export const importPlaceFor = (original: string, itemId: string | undefined): string | null => importPlace?.(original, itemId) ?? null

/** The one pillar that may seat a file before Files does (a later one replaces the earlier). Returns its off. */
export function registerSeatChooser(fn: SeatChooser): () => void {
  seatChooser = fn
  return () => void (seatChooser === fn && (seatChooser = null))
}
export const chooseSeat = (ctx: WorkCtx, by: Caller, ask: SeatAsk, signal?: AbortSignal): Promise<Seat | null> => seatChooser?.(ctx, by, ask, signal) ?? Promise.resolve(null)

/** The registered maker of a kind that writes this form, or null: Files then falls back to its own blank file, if it ships one. */
export const fileMakerFor = (kind: CanvasKind, form: FileForm): FileMaker | null => {
  const maker = makers.get(kind)
  return maker && maker.forms.includes(form) ? maker : null
}
export const filePreviewerFor = (kind: CanvasKind): FilePreviewer | null => previewers.get(kind) ?? null
export const fileMovedHooks = (): readonly FileMoved[] => [...moved]
export const fileWaitingHooks = (): readonly FileWaiting[] => [...waiting]
