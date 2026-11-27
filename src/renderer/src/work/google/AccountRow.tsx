import { FieldRow } from "../../chrome/DialogField";
import { ChoiceSelect } from "../../components/choice-select";

/** A Google dialog's one choice, the account: the row Open from Google and Save to Google draw, and their bones. */
export function AccountRow({ accounts, value, onChange, disabled }: { accounts: readonly string[]; value: string; onChange: (account: string) => void; disabled?: boolean }) {
  return (
    <FieldRow label="Account">
      <ChoiceSelect label="Account" value={value} options={accounts.map((account) => ({ value: account, label: account }))} onChange={onChange} disabled={disabled} />
    </FieldRow>
  );
}

const SAMPLE = ["maya.chen@example.com"];

/** The account row at rest, from a sample address, while the host is asked for his accounts. */
export function AccountRowSample() {
  return <AccountRow accounts={SAMPLE} value={SAMPLE[0]!} onChange={() => undefined} />;
}
