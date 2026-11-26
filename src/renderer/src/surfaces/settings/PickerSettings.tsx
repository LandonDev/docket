import { useState } from "react";
import { HarnessIcon } from "../../chrome/HarnessIcon";
import { Button } from "../../components/ui/button";
import { PageError, PageRowsSkeleton } from "../../components/page";
import { registry } from "../../lib/connection";
import { useHostRead, type HostRead } from "../../lib/connection/hostRead";
import { readHarnessAvailability, type HarnessAvailability } from "../../lib/harness/availability";
import { isPickerProviderVisible, savePickerProviderVisible } from "../../lib/models";
import { HARNESSES, HARNESS_TITLE, type HarnessId } from "../../lib/session";
import { SettingRow } from "./parts/SettingRow";
import { SwitchListDialog } from "./parts/SwitchListDialog";

/** "A, B and C". */
export function namesInLine(names: readonly string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The agent apps this computer has, asked of it: a failure says so with Retry, never "none installed". */
export function useInstalledApps(): HostRead<HarnessAvailability> & { installed: HarnessId[] | undefined } {
  const link = registry.primary();
  const read = useHostRead(link, () => readHarnessAvailability({ environmentId: link.environmentId }));
  return { ...read, installed: read.value ? HARNESSES.filter((harness) => read.value![harness]) : undefined };
}

/**
 * General › Composer › Model picker shows: which installed agent apps have a tab in the model picker (LS
 * `docket.hiddenPickerProviders`). The row names the ones shown and opens a dialog of a switch each; it is absent once
 * the computer said it has none.
 */
export function PickerRow() {
  const apps = useInstalledApps();
  const [hidden, setHidden] = useState(() => new Set(HARNESSES.filter((harness) => !isPickerProviderVisible(harness))));
  const [open, setOpen] = useState(false);
  if (apps.installed?.length === 0) return null;
  const shown = apps.installed?.filter((harness) => !hidden.has(harness)).map((harness) => HARNESS_TITLE[harness]);
  const flip = (id: string, on: boolean) => {
    const harness = id as HarnessId;
    savePickerProviderVisible(harness, on);
    setHidden((was) => {
      const next = new Set(was);
      if (on) next.delete(harness);
      else next.add(harness);
      return next;
    });
  };
  const body =
    apps.installed === undefined ? (
      apps.error ? (
        <PageError
          action={
            <Button variant="ghost" size="sm" onClick={() => void apps.retry()}>
              Retry
            </Button>
          }
        >
          {apps.error}
        </PageError>
      ) : (
        <PageRowsSkeleton rows={2} media control="switch" />
      )
    ) : undefined;
  return (
    <>
      <SettingRow
        id="general.picker"
        description={shown ? (shown.length ? namesInLine(shown) : "None") : undefined}
        onOpen={() => setOpen(true)}
        openLabel="Model picker shows"
      />
      {open ? (
        <SwitchListDialog
          title="Model picker shows"
          body={body}
          items={(apps.installed ?? []).map((harness) => ({
            id: harness,
            label: HARNESS_TITLE[harness],
            media: <HarnessIcon harness={harness} className="size-4" />,
            on: !hidden.has(harness),
          }))}
          onChange={flip}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
