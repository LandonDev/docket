import { stubRoute } from './route'

/**
 * `GET …/f/<formId>`, `POST …/f/<formId>`: a published form's fillers (§8.1).
 * A stub until milestone 36 fills this file (docs/agents/work-service.md).
 */
export const formRoute = stubRoute('published forms', 36, /^\/f(\/.*)?$/)
