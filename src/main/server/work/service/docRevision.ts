import { createHash } from 'node:crypto'
import * as Y from 'yjs'

/** Includes the delete set, so deleting text moves the revision too. */
export const docStateRev = (doc: Y.Doc): string =>
  createHash('sha256').update(Y.encodeSnapshot(Y.snapshot(doc))).digest('hex').slice(0, 32)
