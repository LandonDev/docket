import { registry } from "../../../lib/connection";
import { computerInLine, useComputerName } from "../../../lib/settings/computerName";
import { usePageHome, type HomePage } from "../../../lib/settings/pageHome";
import { everyLine } from "../../../lib/settingsHome";

/**
 * The line under an Everywhere page's title: where its one set is kept, as the page's store answered
 * (`usePublishHome`). Until it has, the line holds its height and says nothing, so the page does not move when it lands.
 */
export function HomeLine({ page }: { page: HomePage }) {
  const home = usePageHome(page);
  const here = computerInLine(useComputerName(registry.primaryEnvironmentId));
  return <span data-home-line="">{home === undefined ? " " : everyLine(home, here)}</span>;
}
