import { stubRoute } from './route'

/**
 * `…/w/full/<token>/*`: the owner's full editor, by a per-open token, never a guest (§8.1, §12.1).
 * A stub until milestone 40 fills this file (docs/agents/work-service.md).
 */
export const fullEditorRoute = stubRoute('the full editor', 40, /^\/w\/full(\/.*)?$/)
