/**
 * What the answers read says to the rest of the pillar (docs/agents/work-msforms.md
 * "Answers as data in Work"): new answers came in. The tell, the Today row and the
 * routine trigger hear it. It carries counts and the workbook's `Id` range alone:
 * never an answer, a name or an address.
 */
export interface NewAnswers {
  workspaceId: string
  formId: string
  title: string
  /** how many answers are new since the last read */
  added: number
  /** the form's count now */
  count: number
  /** the workbook's `Id` range of the new answers, both ends included */
  fromId: number
  toId: number
  at: number
}

const listeners = new Set<(e: NewAnswers) => void>()

export function onNewAnswers(fn: (e: NewAnswers) => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

export function emitNewAnswers(e: NewAnswers): void {
  for (const fn of listeners) {
    try {
      fn(e)
    } catch {
      // a listener's fault is its own: the read goes on
    }
  }
}
