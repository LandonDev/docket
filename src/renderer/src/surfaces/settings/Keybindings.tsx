import { Fragment, useMemo, useState } from "react";
import { PageEmpty, PageRow, PageSection } from "../../components/page";
import { Input } from "../../components/ui/input";
import { LOCAL_ENVIRONMENT_ID } from "../../lib/connection";
import { nativePlatform } from "../../lib/native";
import { filterKeybindings, KEYBINDING_SCOPE_LABEL, visibleKeybindingGroups } from "../../lib/settings";
import { isWebMode } from "../../lib/nativeWeb";
import { useWorkHosts, useWorkOn } from "../../lib/workSwitch";
import { captureKeyApi, CaptureKeyRow } from "../../work/capture/CaptureKeyRow";
import { keyCaps } from "../../lib/keys";
import { Keys } from "./keys";
import { SettingRow, SettingSection } from "./parts/SettingRow";
// A lazy place lists its own keys: its table loads with this page, so the list is whole.
import "../../work/files/bindings";

// The Appshot is a Mac's alone, so its key is the Mac's command key wherever the page is drawn.
const [CMD] = keyCaps("mod", true);

/**
 * Settings › Shortcuts: a find field, then the keys that work from any app (the capture key, which this page sets,
 * and the Appshot's double ⌘, which Appshots turns on), then the app's own keys by group (lib/settings.ts
 * `KEYBINDING_GROUPS`). The find field narrows all of them by name, group or keys.
 */
export function KeybindingsPage() {
  const [query, setQuery] = useState("");
  const web = isWebMode();
  const work = useWorkOn();
  const workHere = useWorkHosts().has(LOCAL_ENVIRONMENT_ID);
  const keyApi = useMemo(captureKeyApi, []);
  const groups = useMemo(() => filterKeybindings(visibleKeybindingGroups(web, work), query), [query, web, work]);
  // From any app: the capture key on a desktop with Work on for this computer, the Appshot on a Mac.
  const capture = !web && keyApi !== null && workHere;
  // The window's own platform, as the list decides that Appshots is a Mac's page.
  const appshot = !web && nativePlatform() === "darwin";
  const fromAnyApp = filterKeybindings(
    [{ title: "From any app", bindings: [...(capture ? [{ name: "Open capture", keys: [] }] : []), ...(appshot ? [{ name: "Appshot", keys: [[CMD, CMD]] }] : [])] }],
    query,
  )[0]?.bindings.map((binding) => binding.name);
  const empty = groups.length === 0 && !fromAnyApp?.length;

  return (
    <>
      <div data-setting="keys.find">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a shortcut"
          aria-label="Find a shortcut"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      {fromAnyApp?.length ? (
        <SettingSection of="keys.capture">
          {fromAnyApp.includes("Open capture") && keyApi ? <CaptureKeyRow api={keyApi} /> : null}
          {fromAnyApp.includes("Appshot") ? (
            <SettingRow id="keys.appshot" description="Turned on in Appshots">
              <Keys keys={[CMD, CMD]} className="" />
            </SettingRow>
          ) : null}
        </SettingSection>
      ) : null}
      {empty ? (
        <PageEmpty>No shortcut matches</PageEmpty>
      ) : (
        groups.map((group) => {
          // Where every shortcut of a group works in one place, the group's line says so once.
          const scopes = new Set(group.bindings.map((binding) => binding.scope));
          const shared = scopes.size === 1 ? group.bindings[0]?.scope : undefined;
          // "Editor" over "In the editor" says one thing twice: a line that only repeats the group's name is left out.
          const sharedLine = shared && !KEYBINDING_SCOPE_LABEL[shared].toLowerCase().includes(group.title.toLowerCase()) ? KEYBINDING_SCOPE_LABEL[shared] : undefined;
          return (
          <PageSection key={group.title} title={group.title} description={sharedLine} data-setting="keys.groups">
            {group.bindings.map((binding) => (
              <PageRow key={binding.name} title={binding.name} description={binding.scope && !shared ? KEYBINDING_SCOPE_LABEL[binding.scope] : undefined}>
                {binding.keys.map((chord, index) => (
                  <Fragment key={chord.join("")}>
                    {index > 0 ? <span className="text-xs text-muted-foreground">or</span> : null}
                    <Keys keys={chord} className="" />
                  </Fragment>
                ))}
              </PageRow>
            ))}
          </PageSection>
          );
        })
      )}
    </>
  );
}
