import { ClientRequestSchema, type ClientRequest, type CreateSessionParams } from '@shared/contract'
import type { CanvasSource } from '@shared/work'

/**
 * A window's draft folds its first send into one `session.create` (Ask beside a file or a mail, docs/agents/work-files.md
 * "Ask"): the create, the steps the window ran between the create and the message, and the message. The host runs the
 * steps here, in the window's order, each as the request the window would have sent (`step` puts it through the caller's
 * capability and the path fence, then the one dispatcher), so a fold reaches nothing its parts could not.
 *
 * - `bridge`: `macBridge.thread.set`. Failing, the thread runs without the bridge, as the window's own call allowed.
 * - `mailAdopt`: `work.mail.chat.adopt`, a must step. Failing, the message does not go: the thread stays, as the window's
 *   step left it, and the window runs the step again before its next send ("The chat did not start").
 * - `items`: `work.canvas.open` each (a far file's copy first, `work.office.filesCopy`). Failing, the item is named in
 *   the answer and the message goes all the same.
 *
 * A create with steps boots its harness at the send, after them (sessions.ts `create`'s `eager`): the bridge step
 * reboots a harness that is starting, and the first send used to join that boot and die with it.
 */

export type CreateStepParams = Pick<CreateSessionParams, 'items' | 'mailAdopt' | 'bridge'>
export type ItemFailed = { title: string; error: string }

/** The words a must step's failure stops the send with, the window's own (renderer commands.ts `afterCreate`). */
export const CHAT_DID_NOT_START = 'The chat did not start'

/** Whether a create carries any step to run. */
export const hasCreateSteps = (p: CreateStepParams): boolean => !!(p.bridge || p.mailAdopt || p.items?.length)

/** A step as the request the window would have sent, parsed by the contract as any request is. */
function request(id: string, method: string, params: Record<string, unknown>): ClientRequest {
  return ClientRequestSchema.parse({ id, method, params })
}

const words = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Runs the steps for the new thread `sessionId`; resolves with the items that did not open, throws when the must step fails. */
export async function runCreateSteps(
  sessionId: string,
  p: CreateStepParams,
  step: (req: ClientRequest) => Promise<unknown>,
  stepId: () => string
): Promise<{ itemsFailed: ItemFailed[] }> {
  if (p.bridge) {
    // An older Mac link or a key that may not approve: the thread runs without the bridge.
    await step(request(stepId(), 'macBridge.thread.set', { sessionId, macPeer: p.bridge.macPeer })).catch(() => undefined)
  }
  if (p.mailAdopt) {
    try {
      await step(request(stepId(), 'work.mail.chat.adopt', { ...p.mailAdopt, sessionId }))
    } catch (err) {
      throw new Error(CHAT_DID_NOT_START, { cause: err })
    }
  }
  const itemsFailed: ItemFailed[] = []
  for (const item of p.items ?? []) {
    try {
      let source: CanvasSource = item.source
      if (item.copy) source = ((await step(request(stepId(), 'work.office.filesCopy', { sessionId, source }))) as { source: CanvasSource }).source
      await step(request(stepId(), 'work.canvas.open', { sessionId, kind: item.kind, source, title: item.title }))
    } catch (err) {
      itemsFailed.push({ title: item.title, error: words(err) })
    }
  }
  return { itemsFailed }
}
