import { stubRoute } from './route'

/**
 * `wss …/w/office`, `GET …/w/addin/*`: the Office add-in and its assets, by a per-add-in key (§8.1, §10).
 * A stub until milestone 29 fills this file (docs/agents/work-service.md).
 */
export const officeRoute = stubRoute('the Office add-in', 29, /^\/w\/(office|addin)(\/.*)?$/)
