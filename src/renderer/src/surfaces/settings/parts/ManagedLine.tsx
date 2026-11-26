import { PageEmpty } from "../../../components/page";
import { managedElsewhere } from "../../../lib/linkMay";

/**
 * In place of controls this window's key may not use on a computer: one muted line saying who can ("Changed from a
 * computer that manages the box"). The values themselves stay on the page as words; nothing is offered that cannot work.
 */
export function ManagedLine({ computer }: { computer: string }) {
  return <PageEmpty data-managed="">{managedElsewhere(computer)}</PageEmpty>;
}
