import { ChoiceSelect } from "../../../components/choice-select";
import { PageRow } from "../../../components/page";
import { SettingSwitch } from "../../../components/setting-switch";
import { Button } from "../../../components/ui/button";
import { FileHeader } from "../../files/FileTabView";
import { LiveControl } from "./LiveControl";

const OF = { mode: "live" as const, address: "https://purdue0.sharepoint.com/sites/RecWell/Shared%20Documents/Plan.docx?web=1", app: "word" as const, tenant: "purdue0", desktops: [] };
const noop = (): void => undefined;

/** A live tab's header while Word loads, at rest, and while it signs in; then a library's row in Settings → Teams files. */
export function LivePreview() {
  const header = (note: string | null, progress: number | null, live: boolean) => (
    <FileHeader
      name="Plan.docx"
      line={null}
      where="Team RecWell"
      running={null}
      onRun={noop}
      rows={[]}
      onPick={noop}
      ask={{ disabled: false, pressed: false, run: noop }}
      note={note}
      progress={progress}
      end={<LiveControl of={OF} live={live} busy={false} desktops={[]} onSwitch={noop} onNoAddress={noop} />}
    />
  );
  return (
    <div className="flex w-full flex-col gap-6 bg-background p-4">
      {header("Opening in Word…", 45, true)}
      {header(null, null, true)}
      {header("Signing in at login.microsoftonline.com", null, true)}
      {header(null, null, false)}
      <div className="rounded-xl border border-border">
        <PageRow title="Team RecWell Documents">
          <div className="flex items-center gap-2">
            <ChoiceSelect label="Where Team RecWell Documents's Office files open" size="sm" value="live" options={[{ value: "here", label: "TempCode" }, { value: "live", label: "Office on the web" }]} onChange={noop} />
            <Button variant="ghost" size="sm">
              Web link…
            </Button>
            <SettingSwitch label="Team RecWell Documents" on onChange={noop} />
          </div>
        </PageRow>
      </div>
    </div>
  );
}
