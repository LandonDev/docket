import { useState } from "react";
import type { Skill, SkillMeta } from "@shared/contract-skills";
import { confirmAction } from "../../../chrome/ConfirmDialog";
import { PageActions, PageEmpty, PageRowsSkeleton } from "../../../components/page";
import { Button } from "../../../components/ui/button";
import { registry, type Link } from "../../../lib/connection";
import { homeNote, refusalWords } from "../../../lib/settingsHome";
import { useWorkspaces } from "../../../lib/tcserver/workspaces";
import { scopeName } from "../addons/addonWords";
import { SkillDialog } from "./SkillDialog";
import { SkillRowView, type SkillMenuPick } from "./SkillRow";
import { useSkillsPage } from "./useSkills";
import { usePublishHome } from "../../../lib/settings/pageHome";
import { useHost } from "../parts/hostRpc";
import { ListFilter, useListFilter } from "../parts/ListFilter";
import { ManagedLine } from "../parts/ManagedLine";
import { ReadFailure } from "../parts/ReadFailure";
import { SettingSection } from "../parts/SettingRow";

const NONE: readonly SkillMeta[] = [];
/** What the find field matches: the name and the description. */
const skillWords = (skill: SkillMeta): string => `${skill.name} ${skill.description}`;

/**
 * Settings → Skills (docs/agents/settings.md "The pages: Everywhere"): one list of every skill this computer knows,
 * where it applies said on each row, a find field past eight, New skill… on the page's title line. Reads through this
 * window's own computer; every write goes to the one copy on the box and carries the row's `updatedAt`, so a skill
 * that moved since it was read is refused rather than written over. A key that may not change skills sees the list
 * as words and one line saying who can.
 */
export function SkillsPage() {
  return <SkillsBody link={registry.primary()} />;
}

export function SkillsBody({ link }: { link: Link }) {
  const { data, error, retry, replaceRow, dropRow } = useSkillsPage(link);
  const [editing, setEditing] = useState<SkillMeta | "new" | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const workspaces = useWorkspaces().filter((w) => w.environmentId === link.environmentId);
  const names = new Map(workspaces.map((w) => [w.id, w.name]));
  const { blocked } = homeNote(data?.home);
  usePublishHome("skills", data ? (data.home ?? null) : undefined);
  const host = useHost(link.environmentId);
  const readOnly = !host.may("skills.set");
  const filter = useListFilter(data?.skills ?? NONE, skillWords);

  const act = <T,>(skill: SkillMeta, run: () => Promise<T>): Promise<T | false> => {
    setRowErrors((cur) => {
      if (!(skill.id in cur)) return cur;
      const next = { ...cur };
      delete next[skill.id];
      return next;
    });
    return run().catch((err: unknown) => {
      setRowErrors((cur) => ({ ...cur, [skill.id]: refusalWords(err) || "The computer refused it" }));
      return false as const;
    });
  };

  // A skill is written whole, so a flip reads its files first.
  const toggle = (skill: SkillMeta, enabled: boolean) =>
    act(skill, async () => {
      const { skill: whole } = await link.request<{ skill: Skill }>("skills.get", { id: skill.id });
      const { skill: saved } = await link.request<{ skill: SkillMeta }>("skills.set", {
        skill: { id: skill.id, name: skill.name, workspaceId: skill.workspaceId, harnesses: skill.harnesses, enabled, files: whole.files },
        expectUpdatedAt: skill.updatedAt,
      });
      replaceRow(saved);
    });

  const pick = (skill: SkillMeta, id: SkillMenuPick) => {
    if (id === "edit") {
      setEditing(skill);
      return;
    }
    void confirmAction({ title: `Remove the skill ${skill.name}`, body: "Threads that start from now no longer get it.", action: "Remove", danger: true }).then((ok) => {
      if (ok) void act(skill, () => link.request("skills.remove", { id: skill.id, expectUpdatedAt: skill.updatedAt }).then(() => dropRow(skill.id)));
    });
  };

  return (
    <>
      {/* Nothing is offered that cannot work: no New skill… before the list has read, while the box is out of reach, or
          for a key that may not write. */}
      {readOnly || !data || blocked ? null : (
        <PageActions>
          <Button variant="ghost" size="sm" onClick={() => setEditing("new")}>
            New skill…
          </Button>
        </PageActions>
      )}
      <SettingSection of="skills.list">
        {data ? <ListFilter filter={filter} label="Find a skill" /> : null}
        {!data ? (
          error ? (
            <ReadFailure computer={link.environmentId} error={error} retry={retry} />
          ) : (
            <PageRowsSkeleton rows={3} description={2} control="switch" />
          )
        ) : data.skills.length === 0 ? (
          <PageEmpty>No skills</PageEmpty>
        ) : (
          filter.shown.map((skill) => (
            <SkillRowView
              key={skill.id}
              skill={skill}
              workspaceName={scopeName(skill.workspaceId, names)}
              blocked={blocked}
              // While the box is out of reach a row is words too, as on Add-ons.
              readOnly={readOnly || blocked}
              error={rowErrors[skill.id]}
              onToggle={(on) => toggle(skill, on)}
              onPick={(id) => pick(skill, id)}
            />
          ))
        )}
        {data && readOnly ? <ManagedLine computer={host.name.name} /> : null}
      </SettingSection>
      {editing ? (
        <SkillDialog
          link={link}
          skill={editing === "new" ? null : editing}
          workspaces={workspaces}
          home={data?.home}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            replaceRow(saved);
            setEditing(null);
          }}
        />
      ) : null}
    </>
  );
}
