import { FieldRow } from "./DialogField";
import { ChoiceSelect } from "../components/choice-select";
import { useAccounts } from "../stores/accounts";
import { pinRowShown, shortName } from "../lib/accountScope";
import { PROVIDER_NAME } from "@server/shared/usageMeter";
import { ROUTED_PROVIDERS, type AccountPins , type AccountsSnapshot } from "@server/shared/accounts";
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
  snapshot: given,
  value,
  onChange,
  inheritLabel,
}: {
  environmentId: string;
  /** The accounts as the page read them; the store's when not given. */
  snapshot?: AccountsSnapshot;
  value: AccountPins;
  onChange: (next: AccountPins) => void;
  /** What an unset provider falls back to, e.g. "Same as the workspace (a@x)". */
  inheritLabel: (provider: (typeof ROUTED_PROVIDERS)[number]) => string;
}) {
  const stored = useAccounts(environmentId).snapshot;
  const snapshot = given ?? stored;
  return (
    <div className="flex flex-col">
      {ROUTED_PROVIDERS.map((provider) => {
        const profiles = snapshot.providers[provider].profiles;
        const current = value[provider] ?? "";
        const known = current === "" || profiles.some((p) => p.name === current);
        if (!pinRowShown(provider, profiles, current)) return null;
        return (
          <FieldRow key={provider} label={providerName(provider)}>
            {profiles.length === 0 && current === "" ? (
              // Nothing to pick: the value as words, never a select that cannot open.
              <span data-account-value className="text-[13px] text-muted-foreground">{inheritLabel(provider)}</span>
            ) : (
            <ChoiceSelect
              label={providerName(provider)}
              size="sm"
              value={current}
              options={[
                { value: "", label: inheritLabel(provider) },
                ...profiles.map((p) => ({ value: p.name, label: shortName(p) })),
                ...(known ? [] : [{ value: current, label: `${current}, not in AI accounts` }]),
              ]}
              onChange={(name) => {
                const next = { ...value };
                if (name) next[provider] = name;
                else delete next[provider];
                onChange(next);
              }}
            />
            )}
          </FieldRow>
        );
      })}
    </div>
  );
}

/** The plan the pin names (Claude, Codex, Meta), never the harness. */
const providerName = (provider: (typeof ROUTED_PROVIDERS)[number]) => PROVIDER_NAME[provider];

/** "Same as the workspace (a@x)" / "Same as the workspace (Auto)" for a project under `workspace`: the words the
 *  workspace page uses for the same state. */
export function projectInheritLabel(workspace: WorkspaceMeta, profiles: { name: string; email?: string; nickname?: string; createdAt: number; active: boolean }[]) {
  return (provider: (typeof ROUTED_PROVIDERS)[number]): string => {
    const name = workspace.accountPins?.[provider];
    if (!name) return "Same as the workspace (Auto)";
    const profile = profiles.find((p) => p.name === name);
    return `Same as the workspace (${profile ? shortName(profile) : name})`;
  };
}
