/** How far back and ahead an event is found by its title or place (docs/agents/work-search.md "The sources"). */
export const EVENTS_BACK_DAYS = 30
export const EVENTS_AHEAD_DAYS = 120

const DAY = 86_400_000

export const eventsWindow = (now = Date.now()): { from: number; to: number } => ({ from: now - EVENTS_BACK_DAYS * DAY, to: now + EVENTS_AHEAD_DAYS * DAY })
