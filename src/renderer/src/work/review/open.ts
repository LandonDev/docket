import { openWorkPlaceAt } from "../../lib/workPlaceAt";

/**
 * Opens Review, at the week that holds `week` when given (any moment of it:
 * a routine run's `open.at`, Today's row). The one way in for another pillar
 * (docs/agents/work-review.md "Borders"); it loads nothing of the page.
 */
export function openReview(o: { week?: number } = {}): void {
  openWorkPlaceAt("review", o.week);
}
