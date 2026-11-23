import { dayTime } from "../../lib/duration";

const dates = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/**
 * When an item was held, as a time that names its day: "7:42 AM" today,
 * "Sun 7:40 PM" within the last six days, the date alone before that. For a
 * place where a bare date would read as something else: on Today a bare
 * date in the facts' column is a late task's due date, so the held row and
 * the sheet it opens both say it this way.
 */
export function heldWhen(ts: number, now = Date.now()): string {
  const day = (t: number): number => new Date(t).setHours(0, 0, 0, 0);
  return Math.round((day(now) - day(ts)) / 86_400_000) < 7 ? dayTime(ts, now) : dates.format(ts);
}
