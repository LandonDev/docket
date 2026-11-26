import type { Row } from '../lib/row'
import { CODE_ROWS } from './code'
import { FILE_ROWS } from './files'
import { MAIL_ROWS } from './mail'
import { VIEW_ROWS } from './views'

/** Every perf row, in the order a run takes them: the LifeOS views while the sandbox is fresh, then files; then the code family's. */
export const ROWS: Row[] = [...VIEW_ROWS, ...MAIL_ROWS, ...FILE_ROWS, ...CODE_ROWS]

export const rowsMatching = (patterns: string[] | undefined): Row[] =>
  !patterns?.length ? ROWS : ROWS.filter((row) => patterns.some((p) => (p.endsWith('*') ? row.id.startsWith(p.slice(0, -1)) : row.id === p)))
