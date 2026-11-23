/**
 * One-press short answers ("On it", "Thanks!"): their place is the left end
 * of the composer's foot, which draws nothing while this list is empty
 * (the plan's "For the owner", 10). One edit fills it.
 */
export interface QuickAnswer {
  id: string;
  label: string;
  text: string;
}

export const QUICK_ANSWERS: QuickAnswer[] = [];
