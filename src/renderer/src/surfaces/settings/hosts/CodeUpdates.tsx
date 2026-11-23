import { useState } from "react";
import type { CodeSettings } from "@server/shared/contract-code";
import { ChoiceSelect } from "../../../components/choice-select";
import { Row } from "./Group";

/** Off's value in the select: no saved environment id takes this shape (they are `env_…`). */
export const CODE_OFF = "__off";

/** This Mac takes code-only updates from one chosen admin host
 *  (docs/agents/code-only-updates.md), picked beside Keep awake's select. A
 *  build that cannot take them (a dev build, no base stamp) or a Mac with no
 *  admin host shows no row; main's last line about them (a fallback, a
 *  refusal) is the row's state. */
export function CodeUpdatesRow({
  settings,
  notice,
  onSet,
}: {
  settings: CodeSettings | null;
  notice?: string;
  /** Resolves null once the change landed, else why it did not. */
  onSet: (host: string | null) => Promise<string | null>;
}) {
  const [error, setError] = useState<string | null>(null);
  if (!settings || settings.cannot !== null || settings.hosts.length === 0) return null;
  const options = [{ value: CODE_OFF, label: "Off" }, ...settings.hosts.map((h) => ({ value: h.id, label: h.name }))];
  return (
    <Row title="Code updates" description={notice || undefined} error={error} data-code-updates>
      <ChoiceSelect
        label="Take code updates from"
        value={settings.host ?? CODE_OFF}
        options={options}
        className="w-44"
        onChange={(value) => {
          setError(null);
          void onSet(value === CODE_OFF ? null : value).then(setError);
        }}
      />
    </Row>
  );
}
