import { useEffect, useState } from "react";
import type { GoogleAccounts } from "@shared/contract-work-google";
import { useAccountReach } from "./accountReach";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Modal, ModalBody } from "../../chrome/Modal";
import { Region } from "../../components/bones";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { openUrl } from "../../lib/native";
import { AccountRow, AccountRowSample } from "./AccountRow";

export function UploadGoogleDialog({ env, itemId, kind, onClose }: { env: string; itemId: string; kind: "Slides" | "Sheets"; onClose(): void }) {
  const accountsReach = useAccountReach(env);
  const [accounts, setAccounts] = useState<string[] | null>(null);
  const [account, setAccount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (accountsReach.held) return;
    let live = true;
    setError(null);
    void registry.linkOf(env).request<GoogleAccounts>("work.google.accounts", {}).then(
      (result) => {
        if (!live) return;
        const ready = result.accounts.filter((a) => a.files).map((a) => a.account);
        setAccounts(ready);
        setAccount(ready[0] ?? "");
      },
      () => live && setError("Your Google accounts did not load"),
    );
    return () => {
      live = false;
    };
  }, [env, accountsReach.held]);

  const save = async (): Promise<void> => {
    if (saving || !account || accountsReach.held) return;
    setSaving(true);
    setError(null);
    try {
      const { url } = await registry.linkOf(env).request<{ url: string }>("work.google.upload", { account, itemId });
      onClose();
      void loadToast().then((toast) => toast.success(`Saved to Google ${kind}`, { action: { label: "Open in Google", onClick: () => void openUrl(url) } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : `Couldn't save to Google ${kind}`);
      setSaving(false);
    }
  };

  return (
    <Modal title={`Save to Google ${kind}`} onClose={onClose} busy={saving}>
      <form onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}>
        <ModalBody>
          <Region loading={!accountsReach.held && !accounts?.length && !(accounts && !accountsReach.checking) && !error} label="Loading accounts" bones={<AccountRowSample />}>
            {accountsReach.held ? accountsReach.line : accounts?.length ? (
              <AccountRow accounts={accounts} value={account} onChange={setAccount} disabled={saving} />
            ) : accounts && !accountsReach.checking ? (
              <p className="text-[13px] leading-5 text-muted-foreground">No Google account has allowed Drive files. Reconnect one in LifeOS.</p>
            ) : null}
          </Region>
          <ErrorLine error={accountsReach.held ? null : error} />
        </ModalBody>
        <DialogFooter onCancel={onClose} confirmLabel="Save" disabled={!account || accountsReach.held} pending={saving} />
      </form>
    </Modal>
  );
}
