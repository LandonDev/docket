import { openUrl } from "../../../lib/native";
import { Button } from "../../../components/ui/button";
import { Region } from "../../../components/bones";
import { SettingRow } from "./SettingRow";

const PANE_URL = "x-apple.systempreferences:com.apple.preference.security?";

type Grant = {
  id: "computer.accessibility" | "computer.screen";
  /** The Privacy pane's anchor. */
  pane: string;
  granted: boolean | null;
  /** What the page cannot do without it, said only while it is missing. */
  without: string;
};

/**
 * The two macOS grants. Computer use lists both, the one place they are listed; another page (`missingOnly`:
 * Appshots) shows one only while it is missing, as the reason a thing there does not work. A grant not yet known is its
 * word drawn as bones; granted is the muted word; missing is its line in amber with Grant…, which opens its System Settings
 * pane, never a system prompt.
 */
export function Permissions({
  accessibility,
  screen,
  missingOnly = false,
  without,
}: {
  accessibility: boolean | null;
  screen: boolean | null;
  missingOnly?: boolean;
  without: { accessibility: string; screen: string };
}) {
  const grants: Grant[] = [
    { id: "computer.accessibility", pane: "Privacy_Accessibility", granted: accessibility, without: without.accessibility },
    { id: "computer.screen", pane: "Privacy_ScreenCapture", granted: screen, without: without.screen },
  ];
  return (
    <>
      {grants
        .filter((grant) => !missingOnly || grant.granted === false)
        .map((grant) => (
          <PermissionLine key={grant.id} grant={grant} shown={missingOnly} />
        ))}
    </>
  );
}

function PermissionLine({ grant, shown }: { grant: Grant; shown: boolean }) {
  const missing = grant.granted === false;
  return (
    <SettingRow id={grant.id} shown={shown} description={missing ? <span className="text-warning">{grant.without}</span> : undefined}>
      <Region
        loading={grant.granted === null}
        label=""
        className="shrink-0"
        bones={
          <span data-testid="permission-skeleton" className="text-xs text-muted-foreground">
            Granted
          </span>
        }
      >
        {grant.granted === null ? null : grant.granted ? (
          <span className="text-xs text-muted-foreground">Granted</span>
        ) : (
          // macOS prompts once; after a denial only System Settings can grant it.
          <Button variant="secondary" size="sm" onClick={() => void openUrl(PANE_URL + grant.pane)}>
            Grant…
          </Button>
        )}
      </Region>
    </SettingRow>
  );
}
