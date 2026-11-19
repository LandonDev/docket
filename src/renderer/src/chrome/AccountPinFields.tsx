import { FieldRow } from "./DialogField";
import { ChoiceSelect } from "../components/choice-select";
import { useAccounts } from "../stores/accounts";
import { pinRowShown, shortName } from "../lib/accountScope";
import { PROVIDER_NAME } from "@server/shared/usageMeter";
import { ROUTED_PROVIDERS, type AccountPins } from "@server/shared/accounts";
import type { WorkspaceMeta } from "../lib/tcserver/types";

/*
 * A project's account pins, in a file of their own: the code project's
 * sheet (ProjectDialogs.tsx) and a Work project's (work/shell/ProjectSettings.tsx)
 * both draw them, and neither chunk should carry the other's sheet for it.
 */

/**
 * One select per gateway provider: the project's own account, or inherit
 * (the workspace's pin when it has one, else auto).
 */
export function AccountPinFields({
  environmentId,
  value,
  onChange,
  inheritLabel,
}: {
  environmentId: string;
  value: AccountPins;
  onChange: (next: AccountPins) => void;
  /** What an unset provider falls back to, e.g. "Inherit (workspace: a@x)". */
  inheritLabel: (provider: (typeof ROUTED_PROVIDERS)[number]) => string;
}) {
  const { snapshot } = useAccounts(environmentId);
  return (
    <div className="flex flex-col">
      {ROUTED_PROVIDERS.map((provider) => {
        const profiles = snapshot.providers[provider].profiles;
        const current = value[provider] ?? "";
        const known = current === "" || profiles.some((p) => p.name === current);
        if (!pinRowShown(provider, profiles, current)) return null;
        return (
          <FieldRow key={provider} label={providerName(provider)}>
            <ChoiceSelect
              label={providerName(provider)}
              size="sm"
              value={current}
              disabled={profiles.length === 0 && current === ""}
              options={[
                { value: "", label: inheritLabel(provider) },
                ...profiles.map((p) => ({ value: p.name, label: shortName(p) })),
                ...(known ? [] : [{ value: current, label: `${current} (not in Aliax)` }]),
              ]}
              onChange={(name) => {
                const next = { ...value };
                if (name) next[provider] = name;
                else delete next[provider];
                onChange(next);
              }}
            />
          </FieldRow>
        );
      })}
    </div>
  );
}

/** The plan the pin names (Claude, Codex, Meta), never the harness. */
const providerName = (provider: (typeof ROUTED_PROVIDERS)[number]) => PROVIDER_NAME[provider];

/** "Inherit (workspace: a@x)" / "Inherit (auto)" for a project under `workspace`. */
export function projectInheritLabel(workspace: WorkspaceMeta, profiles: { name: string; email?: string; nickname?: string; createdAt: number; active: boolean }[]) {
  return (provider: (typeof ROUTED_PROVIDERS)[number]): string => {
    const name = workspace.accountPins?.[provider];
    if (!name) return "Inherit (auto)";
    const profile = profiles.find((p) => p.name === name);
    return `Inherit (workspace: ${profile ? shortName(profile) : name})`;
  };
}
