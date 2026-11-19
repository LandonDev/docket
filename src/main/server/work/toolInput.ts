import type { ZodType } from 'zod'

/**
 * A tool's input must be a `z.object`: Claude's server registers its shape.
 * In a file of its own, with no import of the pillar registry, so the code
 * that mounts tools (apptools.ts) loads no pillar by reaching for it.
 */
export const inputShapeOf = (input: ZodType): Record<string, ZodType> | null => {
  const shape = (input as { shape?: unknown }).shape
  return shape && typeof shape === 'object' ? (shape as Record<string, ZodType>) : null
}
