import type { PipelineEvent } from './raw'

/**
 * How a running transcription tells its meeting what it has so far. A job
 * goes through `ctx.convert`, which answers only at the end, so the
 * meeting hands the job a token (`options.progress`) and listens here; the
 * transcriber emits each event under the token while it runs. In-process
 * only: a token no one listens for is dropped.
 */
const listeners = new Map<string, (e: PipelineEvent) => void>()

export function onPipelineEvents(token: string, fn: (e: PipelineEvent) => void): () => void {
  listeners.set(token, fn)
  return () => {
    if (listeners.get(token) === fn) listeners.delete(token)
  }
}

/** Called by the transcriber for each event of the job whose `options.progress` is `token`. A listener that throws never stops the job. */
export function emitPipelineEvent(token: unknown, e: PipelineEvent): void {
  if (typeof token !== 'string') return
  try {
    listeners.get(token)?.(e)
  } catch (err) {
    console.error('[work] meetings: a transcription listener threw:', err)
  }
}
