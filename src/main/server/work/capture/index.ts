import { CaptureFileParamsSchema } from '@shared/contract-work-capture'
import { handled, NOT_HANDLED } from '@shared/work'
import type { WorkModule } from '../modules'
import { captureState, ensureCaptureTables, fileCapture } from './file'

/**
 * The capture pillar's server module (docs/agents/work-capture.md): the
 * desktop's capture window and the phone's voice note file through it. It
 * lists no tool and adds nothing to a thread's preamble: a capture is the
 * owner's own write, never an agent's.
 */
export const capture: WorkModule = {
  id: 'capture',
  ensure: ensureCaptureTables,
  async handle(req, ctx, by) {
    if (req.method === 'work.capture.state') return handled(captureState(ctx))
    if (req.method === 'work.capture.file') return handled(await fileCapture(ctx, CaptureFileParamsSchema.parse(req.params), by))
    return NOT_HANDLED
  }
}
