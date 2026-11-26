import { SKILL_HARNESSES } from "@shared/skills";
import { andList } from "@shared/addons";
import { CLI_LABELS } from "./skillForm";
import type { SkillMeta } from "@shared/contract-skills";
import { MoreHorizontal } from "../../../chrome/icons";
import { RowsMenu, type MenuRow } from "../../../chrome/menuRows";
import { useLayoutEffect, useState } from "react";
import { PageRow } from "../../../components/page";
import { SettingSwitch } from "../../../components/setting-switch";
import { Button } from "../../../components/ui/button";
import { Facts } from "../hosts/Facts";

export type SkillMenuPick = "edit" | "remove";
const MENU: MenuRow[] = [{ kind: "item", id: "edit", label: "Edit…" }, { kind: "sep" }, { kind: "item", id: "remove", label: "Remove…", danger: true }];

/** The row's third line: which agent apps get it, the workspace it is for (every workspace is the list's rule, said on
 *  no row), its version, the thread that wrote it. */
export const skillFacts = (skill: SkillMeta, workspaceName: string | null): string[] => [
  andList((skill.harnesses === "all" ? [...SKILL_HARNESSES] : SKILL_HARNESSES.filter((h) => skill.harnesses.includes(h))).map((h) => CLI_LABELS[h])),
  ...(workspaceName ? [workspaceName] : []),
  `v${skill.version}`,
  ...(skill.writtenBy.kind === "thread" ? [`written by ${skill.writtenBy.title || "a thread"}`] : []),
];

/**
 * One skill on Settings → Skills: its name, its description on one line (cut,
 * and whole on the open control's tooltip only while cut), one comma run of
 * its CLIs, scope, version and the thread that wrote it, and a red line for
 * what the host refused. The switch and the ⋯ sit over the row's open
 * control, which opens Edit….
 */
export function SkillRowView({
  skill,
  workspaceName,
  blocked,
  readOnly = false,
  error,
  onToggle,
  onPick,
}: {
  skill: SkillMeta;
  workspaceName: string | null;
  blocked: boolean;
  /** This window's key may not change skills there: the row is words alone. */
  readOnly?: boolean;
  error?: string;
  onToggle: (on: boolean) => Promise<unknown>;
  onPick: (pick: SkillMenuPick) => void;
}) {
  // The description takes two lines before it is cut, and is whole on the open control's tooltip only while cut.
  const [line, setLine] = useState<HTMLElement | null>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    if (!line) return;
    const measure = () => setCut(line.scrollHeight > line.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(line);
    return () => observer.disconnect();
  }, [line, skill.description]);
  return (
    <PageRow
      data-skill={skill.name}
      title={skill.name}
      description={
        <>
          <span ref={setLine} data-skill-description className="line-clamp-2">
            {skill.description}
          </span>
          <span className="mt-1 block">
            <Facts parts={skillFacts(skill, workspaceName)} />
          </span>
        </>
      }
      error={error}
      {...(readOnly ? {} : { onOpen: () => onPick("edit"), openLabel: `Edit ${skill.name}`, openTip: cut ? skill.description : undefined, openDisabled: blocked })}
    >
      {readOnly ? null : (
        <>
      <SettingSwitch label={skill.name} on={skill.enabled} disabled={blocked} onChange={onToggle} />
      {/* Nothing is offered that cannot work: while the box is out of reach the row has no ⋯. */}
      {blocked ? null : (
      <RowsMenu
        label={`${skill.name} actions`}
        trigger={
          <Button variant="ghost" size="icon-sm" aria-label={`${skill.name} actions`} className="text-muted-foreground">
            <MoreHorizontal />
          </Button>
        }
        rows={MENU}
        onPick={(id) => onPick(id as SkillMenuPick)}
        align="end"
      />
      )}
        </>
      )}
    </PageRow>
  );
}
