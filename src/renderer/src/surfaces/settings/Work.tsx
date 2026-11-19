import { useState } from "react";
import { PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
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
  const flip = async (next: boolean): Promise<boolean> => {
    const failed: string[] = [];
    await Promise.all(
      environments.map(async (env) => {
        try {
          const answer = await registry.linkOf(env.id).request<{ enabled: boolean }>("work.set", { enabled: next });
          setWorkOn(env.id, !!answer.enabled);
        } catch (error) {
          failed.push(`${env.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
    setRefused(failed);
    return failed.length < environments.length;
  };
  return (
    <>
      <PageSection>
        <PageRow title="Work" description={switchLine(environments, on)}>
          <SettingSwitch label="Work" on={on.size > 0} onChange={(next) => flip(next)} />
        </PageRow>
        {refused.map((line) => (
          <PageError key={line}>{line}</PageError>
        ))}
      </PageSection>
      {on.size > 0 ? <WorkSettingsBody /> : null}
    </>
  );
}
