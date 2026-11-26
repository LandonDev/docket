import { useState } from "react";
import type { SavedEnvironment } from "@server/shared/contract-remote";
import { ChoiceToggle } from "../../../components/choice-toggle";
import { Input } from "../../../components/ui/input";
import { DialogFooter, ErrorLine } from "../../../chrome/ConfirmDialog";
import { Field, FieldRow } from "../../../chrome/DialogField";
import { ModalBody, useModalClose } from "../../../chrome/Modal";
import { LOCAL_ENVIRONMENT_ID, useEnvironments } from "../../../lib/connection";
import { hostErrorText } from "../../../lib/hostConnection";
import { thisDesktopInLine } from "../../../lib/native";
import { computerInLine, useComputerName } from "../../../lib/settings/computerName";
import { hostRequest } from "../parts/hostRpc";
import { useFrame } from "./frame";

/**
 * Link this Mac to another computer: by the sign-in link that computer made, or by its address and a key. With
 * `computer` set it signs in to that saved computer again (its key was refused or removed there), and a link that
 * turns out to be another computer's says so.
 */

type With = "link" | "key";

/** `wss://computer/ws` → `https://computer`, the form the Address field takes. */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    return u.origin;
  } catch {
    return "";
  }
}

export function LinkWay({ computer, onClose, onChanged }: { computer?: string; onClose: () => void; onChanged: () => void }) {
  const again = useEnvironments().find((environment) => environment.id === computer);
  const name = useComputerName(computer ?? "");
  const [pending, setPending] = useState(false);
  useFrame({ title: again ? `Sign in to ${computerInLine(name)} again` : `Link ${thisDesktopInLine()} to another computer`, busy: pending });
  return <LinkForm again={again} pending={pending} setPending={setPending} onClose={onClose} onChanged={onChanged} />;
}

function LinkForm({
  again,
  pending,
  setPending,
  onClose,
  onChanged,
}: {
  again?: { id: string; name: string; routes: { url: string }[] };
  pending: boolean;
  setPending: (on: boolean) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const close = useModalClose();
  const [by, setBy] = useState<With>("link");
  const [link, setLink] = useState("");
  const [origin, setOrigin] = useState(again ? originOf(again.routes[0]?.url ?? "") : "");
  const [key, setKey] = useState("");
  const [name, setName] = useState(again?.name ?? "");
  const [error, setError] = useState<string | null>(null);

  const ready = by === "link" ? link.trim().length > 0 : origin.trim().length > 0 && key.trim().length > 0;
  const submit = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      const named = name.trim() ? { name: name.trim() } : {};
      const added =
        by === "link"
          ? await hostRequest<SavedEnvironment>(LOCAL_ENVIRONMENT_ID, "remote.environments.pair", { link: link.trim(), ...named })
          : await hostRequest<SavedEnvironment>(LOCAL_ENVIRONMENT_ID, "remote.environments.add", { url: origin.trim(), key: key.trim(), ...named });
      onChanged();
      setPending(false);
      if (again && added.id !== again.id) {
        setError(`That link is for another computer, ${added.name}, which is now linked too.`);
        return;
      }
      if (close) close(onClose);
      else onClose();
    } catch (err) {
      setError(hostErrorText(err));
      setPending(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !pending) void submit();
      }}
    >
      <ModalBody>
        <FieldRow label="With">
          <ChoiceToggle<With>
            label="With"
            value={by}
            onChange={setBy}
            options={[
              { value: "link", label: "Sign-in link" },
              { value: "key", label: "Address and key" },
            ]}
          />
        </FieldRow>
        {by === "link" ? (
          <Field label="Sign-in link">
            <Input
              value={link}
              autoFocus
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://docket.example.com/pair#ABCDE-12345"
              spellCheck={false}
              autoComplete="off"
              data-environment-field="link"
            />
          </Field>
        ) : (
          <>
            <Field label="Address">
              <Input
                value={origin}
                autoFocus
                onChange={(e) => setOrigin(e.target.value)}
                placeholder="https://docket.example.com"
                spellCheck={false}
                autoComplete="off"
                data-environment-field="origin"
              />
            </Field>
            <Field label="Key">
              <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="tc_…" spellCheck={false} autoComplete="off" type="password" data-environment-field="key" />
            </Field>
          </>
        )}
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Its own name when empty" spellCheck={false} autoComplete="off" data-environment-field="name" />
        </Field>
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel={again ? "Sign in" : "Link"} pending={pending} disabled={!ready} />
    </form>
  );
}
