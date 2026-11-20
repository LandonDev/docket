import { z } from 'zod'
import { CanvasSourceSchema } from './work/canvas'
import { SectorKeySchema, type SectorKey } from './work/ids'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The capture pillar's wire (docs/agents/work-capture.md): a thought, a
 * link or a file filed to LifeOS as the owner in a few seconds, from the
 * desktop's capture window or the phone's voice note. The host writes it
 * as his own quick add ("Capture" in the sector he picked, "Unsorted" in
 * Life for LifeOS's bot to file), keeps its files in the sector's Work
 * workspace folder on this host, and starts a Work thread on it when he
 * asks. No model is called to sort it.
 */
export const CAPTURE_TEXT_MAX = 20_000
export const CAPTURE_FILES_MAX = 20

export const CaptureFileParamsSchema = z.object({
  /** the capture's own id: a retry with the same key files nothing twice */
  key: z.string().min(8).max(100),
  text: z.string().max(CAPTURE_TEXT_MAX),
  /** null: unsorted, filed in Life for LifeOS's bot to move */
  sector: SectorKeySchema.nullable(),
  /** files on this host (`{ at: 'file' }`), copied into the sector's Work workspace folder */
  files: z.array(CanvasSourceSchema).max(CAPTURE_FILES_MAX).optional(),
  /** also start a Work thread on it */
  start: z.boolean().optional()
})
export type CaptureFileParams = z.infer<typeof CaptureFileParamsSchema>

export const CaptureRequestSchemas = [
  /** → CaptureState */
  request('work.capture.state', z.object({})),
  /** → CaptureFiled */
  request('work.capture.file', CaptureFileParamsSchema)
] as const

/** What the capture window needs before he types: where it went last and which sectors can keep a file here. */
export interface CaptureState {
  /** the sector of his last capture on this host; null when it was unsorted or there was none */
  last: SectorKey | null
  /** sectors with a Work workspace on this host, so a file or a thread has a home */
  homes: SectorKey[]
  /** LifeOS answers: a capture can be filed now */
  connected: boolean
}

/** What a capture made: the LifeOS task, the files kept (names in the folder) and the thread it started. */
export interface CaptureFiled {
  taskId: string
  kept: string[]
  threadId?: string
}

export type CapturePush = never
export const CAPTURE_CAPS = {
  'work.capture.state': 'read',
  'work.capture.file': 'operate'
} satisfies CapsOf<typeof CaptureRequestSchemas>
export const CAPTURE_RELAY = {} satisfies RelayOf<typeof CaptureRequestSchemas>
