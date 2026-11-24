import { useState } from "react";
import { PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { BusyLabel, Button } from "../../components/ui/button";
import { registry, useEnvironments } from "../../lib/connection";
import { setWorkOn, useWorkHosts } from "../../lib/workSwitch";
import { workShellChunk } from "../chunks";

const WorkSettingsBody = workShellChunk.surface("WorkSettingsBody", <PageRowsSkeleton rows={4} description control="button" />);

/** "On for the box, off for this Mac": which hosts differ, by name. */
export function switchLine(environments: readonly { id: string; name: string }[], on: ReadonlySet<string>): string | undefined {
  if (on.size === 0) return "On adds the Outbox, Work Chats and your Work workspaces to the rail";
  const off = environments.filter((e) => !on.has(e.id));
  if (off.length === 0) return undefined;
  const names = (list: readonly { name: string }[]): string => list.map((e) => e.name).join(", ");
  return `On for ${names(environments.filter((e) => on.has(e.id)))}, off for ${names(off)}`;
}

/**
 * Settings → Work (docs/agents/work.md "The switch"): the switch, written to
 * every host this window is linked to, since no sync engine carries it; then,
 * while it is on somewhere, LifeOS, models and where Work runs (Work's own
 * chunk). With every host off the page is the switch alone.
 */
export function WorkPage() {
  const environments = useEnvironments();
  const on = useWorkHosts();
  const [refused, setRefused] = useState<string[]>([]);
  const [joining, setJoining] = useState(false);
  // On somewhere and off on another host (a PC just paired): the switch already reads on, so the hosts left off get their own press,
  // which asks those hosts alone: a host already on is never written, and the switch is never turned off to turn one on.
  const off = on.size > 0 ? environments.filter((e) => !on.has(e.id)) : [];
  const flip = async (next: boolean, only: readonly { id: string; name: string }[] = environments): Promise<boolean> => {
    const failed: string[] = [];
    await Promise.all(
      only.map(async (env) => {
        try {
          const answer = await registry.linkOf(env.id).request<{ enabled: boolean }>("work.set", { enabled: next });
          setWorkOn(env.id, !!answer.enabled);
        } catch (error) {
          failed.push(`${env.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
    setRefused(failed);
    return failed.length < only.length;
  };
  const joinOff = async (): Promise<void> => {
    setJoining(true);
    await flip(true, off);
    setJoining(false);
  };
  return (
    <>
      <PageSection>
        <PageRow title="Work" description={switchLine(environments, on)}>
          <div className="flex items-center gap-2">
            {off.length ? (
              <Button variant="secondary" size="sm" disabled={joining} onClick={() => void joinOff()}>
                <BusyLabel busy={joining} label={`Turn on for ${off.map((e) => e.name).join(", ")}`} />
              </Button>
            ) : null}
            <SettingSwitch label="Work" on={on.size > 0} onChange={(next) => flip(next)} />
          </div>
        </PageRow>
        {refused.map((line) => (
          <PageError key={line}>{line}</PageError>
        ))}
      </PageSection>
      {on.size > 0 ? <WorkSettingsBody /> : null}
    </>
  );
}
