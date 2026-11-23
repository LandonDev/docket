import type { TemplatesList } from '@shared/contract-work-templates'
import { handled, NOT_HANDLED } from '@shared/work'
import type { WorkModule } from '../modules'

/**
 * The templates pillar's server module (docs/agents/work-templates.md): the
 * shelf of a Work workspace. A template is a file; a new file is made from
 * one with its fields filled (ooxml.ts, deckFill.ts).
 */
export const templates: WorkModule = {
  id: 'templates',
  ensure() {},
  async handle(req) {
    if (req.method === 'work.templates.list') return handled({ templates: [], hidden: 0 } satisfies TemplatesList)
    return NOT_HANDLED
  }
}
