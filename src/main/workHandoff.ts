import type { App } from 'electron'
import { REVEAL_INVALID, RevealParamsSchema, type RevealParams } from '@shared/contract-work-reveal'

export const WORK_HANDOFF = 'dev.landon.tempcode.open'
export const willContinueWork = (type: string): boolean => type === WORK_HANDOFF

/** macOS delivers the same strict envelope as the work.reveal method. */
export function workHandoffParams(type: string, userInfo: unknown): RevealParams | null {
  if (!willContinueWork(type)) return null
  const parsed = RevealParamsSchema.safeParse(userInfo)
  return parsed.success ? parsed.data : null
}

export function registerWorkHandoff(app: App, open: (params: RevealParams) => void, refuse: (words: string) => void): void {
  app.on('will-continue-activity', (event, type) => {
    if (willContinueWork(type)) event.preventDefault()
  })
  app.on('continue-activity', (event, type, userInfo) => {
    if (!willContinueWork(type)) return
    event.preventDefault()
    const params = workHandoffParams(type, userInfo)
    if (params) open(params)
    else refuse(REVEAL_INVALID)
  })
}

/** macOS can deliver an activity before the app's first shell mounts. */
export function queueWorkHandoff(open: (params: RevealParams) => Promise<void>, refuse: (words: string) => void) {
  let ready = false
  let pending: RevealParams | null = null
  const dispatch = (params: RevealParams): void => {
    void open(params).catch((error: unknown) => refuse(error instanceof Error ? error.message : String(error)))
  }
  return {
    receive(params: RevealParams) {
      if (ready) dispatch(params)
      else pending = params
    },
    windowReady() {
      ready = true
      const next = pending
      pending = null
      if (next) dispatch(next)
    }
  }
}
