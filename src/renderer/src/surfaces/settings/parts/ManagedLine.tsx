import { PageEmpty } from "../../../components/page";
import { managedElsewhere } from "../../../lib/linkMay";
import { nameInLine } from "../../../lib/hostWords";

/** The line's words: "Changed from the box." where the computer that manages it is known, else "Changed from a
 *  computer that manages the box.", always a sentence with its stop. */
export function managedWords(computer: string, by?: string | null): string {
  if (by) return `Changed from ${nameInLine(by)}.`;
  const words = managedElsewhere(computer);
  return /[.!?]$/.test(words) ? words : `${words}.`;
}

/**
 * In place of controls this window's key may not use on a computer: one muted line saying who can. `by` names the
 * computer that manages it, where the caller knows it ("Changed from the box."); else the line says "a computer that
 * manages <computer>". The values themselves stay on the page as words; nothing is offered that cannot work.
 */
export function ManagedLine({ computer, by }: { computer: string; by?: string | null }) {
  return <PageEmpty data-managed="">{managedWords(computer, by)}</PageEmpty>;
}
