import { PageSection } from "../../components/page";
import { PAGE_WIDTH } from "../../components/pageLayout";
import { cn } from "../../lib/cn";
import { requestSettings } from "../../lib/monaco/debugTab";
import { useWorkOn } from "../../lib/workSwitch";
import { SettingRow } from "./parts/SettingRow";

/**
 * Under AI accounts (the Accounts page, `@aliax/pages`, mounted as it is): the sign-ins Work leans on are Connections'
 * rows, so the page that holds AI sign-ins points there with one open row, in the Accounts page's own column and inset.
 * Only while some computer has Work on: without it there is nothing there to sign in to.
 */
export function AccountsFoot() {
  const workOn = useWorkOn();
  if (!workOn) return null;
  return (
    <div data-slot="accounts-foot" className={cn("mx-auto w-full px-6 pb-6", PAGE_WIDTH.table)}>
      <PageSection>
        <SettingRow id="accounts.connections" onOpen={() => requestSettings("connections")} openLabel="LifeOS, Office and Google sign-ins" />
      </PageSection>
    </div>
  );
}
