import type { WorkModule } from '../modules'

/**
 * The formats pillar's own parts: milestone 21's file (import and export),
 * merged into the module by index.ts, which milestone 15 owns. Its `convert`
 * list comes after the toolchain's LibreOffice converters, so a pair both
 * name runs the toolchain's (`convertersOf` keeps the first); its `handle`
 * hears every `work.formats.*` method the toolchain does not answer.
 */
export const formatsPillar: Pick<WorkModule, 'handle' | 'tools' | 'convert' | 'start' | 'preamble' | 'sessionsRemoved' | 'workspaceRemoved'> & {
  ensure?: WorkModule['ensure']
} = {}
