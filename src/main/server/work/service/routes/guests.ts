import { stubRoute } from './route'

/**
 * `GET …/g/<linkId>`, `wss …/g/ws`, `POST …/g/comment`: a named guest on one shared item, checked against the link row on connect and on every write (§8.6).
 * A stub until milestone 31 fills this file (docs/agents/work-service.md).
 */
export const guestsRoute = stubRoute('guest links', 31, /^\/g(\/.*)?$/)
