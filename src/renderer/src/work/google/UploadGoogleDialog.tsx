import { useEffect, useState } from "react";
import type { GoogleAccounts } from "@shared/contract-work-google";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { FieldRow } from "../../chrome/DialogField";
import { Modal, ModalBody } from "../../chrome/Modal";
import { ChoiceSelect } from "../../components/choice-select";
import { Skeleton } from "../../components/ui/skeleton";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { openUrl } from "../../lib/native";

export function UploadGoogleDialog({ env, itemId, kind, onClose }: { env: string; itemId: string; kind: "Slides" | "Sheets"; onClose(): void }) {
  const [accounts, setAccounts] = useState<string[] | null>(null);
  const [account, setAccount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
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
  }, [env]);

  const save = async (): Promise<void> => {
    if (saving || !account) return;
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
          {accounts?.length ? (
            <FieldRow label="Account">
              <ChoiceSelect label="Account" value={account} options={accounts.map((value) => ({ value, label: value }))} onChange={setAccount} disabled={saving} />
            </FieldRow>
          ) : accounts ? (
            <p className="text-[13px] leading-5 text-muted-foreground">No Google account has allowed Drive files. Reconnect one in LifeOS.</p>
          ) : error ? null : (
            <div aria-busy className="flex h-8 items-center"><Skeleton className="h-3 w-1/2" /></div>
          )}
          <ErrorLine error={error} />
        </ModalBody>
        <DialogFooter onCancel={onClose} confirmLabel="Save" disabled={!account} pending={saving} />
      </form>
    </Modal>
  );
}
