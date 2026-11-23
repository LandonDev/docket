import type { DatabaseSync } from 'node:sqlite'
import type { CanvasKind, CanvasSource } from '@shared/work'
import type { FileForm } from '@shared/work/fileForms'

/**
 * What a canvas kind's own pillar tells Files (docs/agents/work-files.md "The seam with the editors"): how to
 * make a new file of its kind, how to draw a file's page as a picture, and what to re-key when a file is
 * renamed or moved. Three registries, each empty until something registers. They are this file's own state
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

/** One page of a file as a PNG, `width` pixels wide; null when it has no such page or cannot be drawn here. */
export type FilePreviewer = (source: CanvasSource, opts: { page: number; width: number; signal?: AbortSignal }) => Promise<Uint8Array | null>

/**
 * A file was renamed or moved: re-key every row and folder this pillar keeps by the file's path. Called inside
 * the savepoint the rename runs in, before the file's items are re-pointed, so it is synchronous and a throw
 * undoes the whole rename.
 */
export type FileMoved = (from: CanvasSource, to: CanvasSource, at: { db: DatabaseSync; dataDir: string; host: string }) => void

const makers = new Map<CanvasKind, FileMaker>()
const previewers = new Map<CanvasKind, FilePreviewer>()
const moved = new Set<FileMoved>()

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

/** The registered maker of a kind that writes this form, or null: Files then falls back to its own blank file, if it ships one. */
export const fileMakerFor = (kind: CanvasKind, form: FileForm): FileMaker | null => {
  const maker = makers.get(kind)
  return maker && maker.forms.includes(form) ? maker : null
}
export const filePreviewerFor = (kind: CanvasKind): FilePreviewer | null => previewers.get(kind) ?? null
export const fileMovedHooks = (): readonly FileMoved[] => [...moved]
