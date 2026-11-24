import { z, type ZodType } from 'zod'

/**
 * A tool's input must be a `z.object`: Claude's server registers its shape.
 * In a file of its own, with no import of the pillar registry, so the code
 * that mounts tools (apptools.ts) loads no pillar by reaching for it.
 */
export const inputShapeOf = (input: ZodType): Record<string, ZodType> | null => {
  const shape = (input as { shape?: unknown }).shape
  return shape && typeof shape === 'object' ? (shape as Record<string, ZodType>) : null
}

/**
 * The schema Claude's server checks a call against: any object passes, so a bad input reaches the
 * mount and its words (inputWords.ts) rather than the SDK's issue dump. The model is still shown the
 * tool's own JSON schema: zod draws a schema's `_zod.toJSONSchema` in place of its own.
 */
export function claudeInputOf(input: ZodType): ZodType {
  const json = z.toJSONSchema(input, { io: 'input' }) as Record<string, unknown>
  delete json.$schema
  const open = z.looseObject({})
  ;(open._zod as { toJSONSchema?: () => unknown }).toJSONSchema = () => structuredClone(json)
  return open
}
