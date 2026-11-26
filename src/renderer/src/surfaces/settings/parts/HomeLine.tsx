import { registry, useEnvironments } from "../../../lib/connection";
import { computerInLine, useComputerName, useComputerNames } from "../../../lib/settings/computerName";
import { usePageHome, type HomePage } from "../../../lib/settings/pageHome";
import { everyLine, type SettingsHome } from "../../../lib/settingsHome";
import { nameInLine } from "../../../lib/hostWords";

/**
 * The line under an Everywhere page's title: where its one set is kept, as the page's store answered
 * (`usePublishHome`). Until it has, or when it could not, it says "For every computer.", so the line never comes or
 * goes. The computer that keeps the set is said by its one name in this window (`useComputerNames`) when this window
 * knows it, else by the name its store gave.
 */
export function HomeLine({ page }: { page: HomePage }) {
  const home = usePageHome(page);
  const here = computerInLine(useComputerName(registry.primaryEnvironmentId));
  const name = useHomeName(home);
  return <span data-home-line="">{everyLine(home, here, name)}</span>;
}

/** The home's name mid-line: a linked computer of that name by this window's one name for it. */
function useHomeName(home: SettingsHome | null | undefined): string {
  const environments = useEnvironments();
  const names = useComputerNames();
  if (!home) return "";
  const said = home.name.trim().toLowerCase();
  const known = environments.find((environment) => environment.name.trim().toLowerCase() === said);
  return known ? computerInLine(names(known.id)) : nameInLine(home.name);
}
