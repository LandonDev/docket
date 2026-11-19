import { stubRoute } from './route'

/**
 * `GET …/w/open#t=<ticket>`: the owner's hosted editor for the phone, opened by a single-use ticket (§8.1, §8.6).
 * A stub until milestone 31 fills this file (docs/agents/work-service.md).
 */
export const itemRoute = stubRoute("the owner's hosted editor", 31, /^\/w\/open(\/.*)?$/)
