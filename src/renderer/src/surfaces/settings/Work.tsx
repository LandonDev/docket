import { PageRow, PageRowsSkeleton } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { StatusMark } from "../../components/ui/status";
import { confirmAction, type ConfirmRequest } from "../../chrome/ConfirmDialog";
import { useEnvironments } from "../../lib/connection";
import { defineChunk } from "../../lib/lazyChunk";
import { hostFailure } from "../../lib/hostFailure";
import { managedElsewhere } from "../../lib/linkMay";
import { computerInLine } from "../../lib/settings/computerName";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { setWorkOn, useWorkHosts } from "../../lib/workSwitch";
import { ComputerName } from "./parts/ComputerName";
import { useHost } from "./parts/hostRpc";
import { SaveMark } from "./parts/SaveMark";
import { SettingSection } from "./parts/SettingRow";
import { useSaved } from "./parts/useSaved";

// The rest of the page (each job's access, what goes without asking, travel, where new jobs go) rides Work's own chunk.
export const workPageChunk = defineChunk("work-settings", () => import("../../work/shell/WorkPage"));
const WorkPageBody = workPageChunk.surface("WorkPageBody", <PageRowsSkeleton rows={4} description control="none" />);

/** "Turn Work off on the box?": what the off switch asks first (docs/agents/settings.md "Acts that ask first"). */
export function workOffAsk(computer: string, jobs: number): ConfirmRequest {
  const what = jobs > 0 ? `The Outbox, Work Chats and ${jobs === 1 ? "its job" : `${jobs} jobs`}` : "The Outbox and Work Chats";
  return {
    title: `Turn Work off on ${computer}?`,
    body: `${what} leave the list on every device. Nothing is deleted, and turning it on brings them back.`,
    action: "Turn off",
    danger: true,
  };
}

/**
 * Settings → Work (docs/agents/work.md "The switch", docs/agents/settings.md "The pages: Work"). "Work is on for" is
 * one row per computer this window reaches, each with its own switch: a press writes `work.set` to that computer and
 * no other, and off asks first. A computer this window's key may not switch shows its state in words and who can.
 * The section is `work.on`, where another page's "Work" row lands. With Work on somewhere the rest of the page loads
 * from Work's chunk.
 */
export function WorkPage() {
  const environments = useEnvironments();
  const on = useWorkHosts();
  return (
    <>
      <SettingSection of="work.on">
        {environments.map((environment) => (
          <WorkOnRow key={environment.id} environmentId={environment.id} />
        ))}
      </SettingSection>
      {on.size > 0 ? <WorkPageBody /> : null}
    </>
  );
}

/** One computer's switch: one press, one `work.set`, to this computer alone. */
export function WorkOnRow({ environmentId }: { environmentId: string }) {
  const computer = useHost(environmentId);
  const on = useWorkHosts().has(environmentId);
  const jobs = useWorkspaces().filter((w) => w.kind === "work" && w.environmentId === environmentId).length;
  const saved = useSaved();
  const may = computer.may("work.set", { enabled: !on });
  const flip = async (next: boolean): Promise<boolean> => {
    if (!next && !(await confirmAction(workOffAsk(computerInLine(computer.name), jobs)))) return false;
    return saved.run(async () => {
      // A refusal in the house's words, naming the computer: never the link's own text.
      const answer = await computer.request<{ enabled: boolean }>("work.set", { enabled: next }).catch((err: unknown) => {
        throw new Error(hostFailure(environmentId, err, "did not save the change", true));
      });
      setWorkOn(environmentId, !!answer?.enabled);
    });
  };
  const description = !computer.connected ? "Offline" : !may ? managedElsewhere(computer.name.name) : on && jobs > 0 ? (jobs === 1 ? "1 job" : `${jobs} jobs`) : undefined;
  return (
    <PageRow data-work-on={environmentId} title={<ComputerName computer={computer.name} />} description={description} error={saved.error}>
      {may && computer.connected ? (
        <>
          <SaveMark state={saved.state} />
          <SettingSwitch label={`Work on ${computerInLine(computer.name)}`} on={on} onChange={flip} />
        </>
      ) : (
        <StatusMark state="idle" glyph={false} word={on ? "On" : "Off"} className="text-xs" />
      )}
    </PageRow>
  );
}
