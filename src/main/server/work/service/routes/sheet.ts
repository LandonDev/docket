import { stubRoute } from './route'

/**
 * `wss …/w/sheet/<sheetId>`: live sheets, checked as documents are (architecture §8.1).
 * A stub until milestone 27 fills this file (docs/agents/work-service.md).
 */
export const sheetRoute = stubRoute('live sheets', 27, /^\/w\/sheet(\/.*)?$/)
