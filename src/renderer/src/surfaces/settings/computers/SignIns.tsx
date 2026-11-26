import { useCallback, useMemo, useState } from "react";
import type { RemoteKey, RemotePairing, RemoteSession } from "@server/shared/contract-remote";
import { PageEmpty, PageRow } from "../../../components/page";
import { Button } from "../../../components/ui/button";
import { confirmAction } from "../../../chrome/ConfirmDialog";
import { openAddComputer } from "../../../lib/settings/addComputer";
import { computerInLine } from "../../../lib/settings/computerName";
import { refusalWords } from "../../../lib/settingsHome";
import { Countdown } from "../hosts/dialogs/fields";
import type { Host } from "../parts/hostRpc";
import { ListFilter, useListFilter } from "../parts/ListFilter";
import { ManagedLine } from "../parts/ManagedLine";
import { SettingSection } from "../parts/SettingRow";
import { SectionRead, useComputerRead } from "./read";
import { lastManager, mayInLine, signInsOf, type SignIn } from "./words";

const REVOKE: Record<SignIn["kind"], string> = { key: "remote.keys.revoke", session: "remote.sessions.revoke", link: "remote.pairings.revoke" };

/**
 * "Who can sign in to <computer>": its phones, computers, browsers and bots in one list, each with what it may do and
 * when it was last used, and the sign-in links still waiting, each with its countdown (docs/agents/settings.md "The
 * pages: computers"). Asked of that computer over its own link every 5 s, so a phone that signs in shows unasked.
 * Add… opens the one Add dialog at its device step for this computer (`openAddComputer`); Remove… asks first. The
 * lists need a key that may manage the computer: any other sees who can.
 */
export function SignIns({ host, rows, saysWhoCan = true }: { host: Host; rows: "sharing" | "pc"; saysWhoCan?: boolean }) {
  const manage = host.may("remote.keys.list");
  const keys = useComputerRead<RemoteKey[]>(host, "remote.keys.list", { poll: true, skip: !manage });
  const sessions = useComputerRead<RemoteSession[]>(host, "remote.sessions.list", { poll: true, skip: !manage });
  const pairings = useComputerRead<RemotePairing[]>(host, "remote.pairings.list", { poll: true, skip: !manage });
  const computer = computerInLine(host.name);
  // Add… only once the list it adds to was read: a computer that did not answer is offered nothing that cannot work.
  const listed = keys.value !== undefined && sessions.value !== undefined && pairings.value !== undefined;
  const add = host.may("remote.pairings.create") && listed ? (
    <Button data-setting={`${rows}.add`} variant="ghost" size="sm" onClick={() => openAddComputer({ way: "device", computer: host.environmentId })}>
      Add…
    </Button>
  ) : null;
  // The three lists stand or fall together: one row list, never a part of it.
  const all = useMemo(
    () => ({
      value: keys.value && sessions.value && pairings.value ? { keys: keys.value, sessions: sessions.value, pairings: pairings.value } : undefined,
      error: keys.error ?? sessions.error ?? pairings.error,
      retry: () => Promise.all([keys.retry(), sessions.retry(), pairings.retry()]).then(() => undefined),
      set: () => {},
    }),
    [keys, sessions, pairings],
  );
  return (
    <SettingSection of={`${rows}.signIns`} vars={{ computer }} action={add}>
      {manage ? (
        <SectionRead read={all} rows={2}>
          {(lists) => <SignInRows host={host} rows={signInsOf(lists, computer)} computer={computer} onChanged={all.retry} />}
        </SectionRead>
      ) : saysWhoCan ? (
        <ManagedLine computer={host.name.name} />
      ) : (
        // The page says who may change it once, under its title; the list itself is shown to such a computer alone.
        <PageEmpty data-managed-list="">{`Listed on a computer that manages ${computer}`}</PageEmpty>
      )}
    </SettingSection>
  );
}

function SignInRows({ host, rows, computer, onChanged }: { host: Host; rows: SignIn[]; computer: string; onChanged: () => Promise<void> }) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const words = useCallback((row: SignIn) => row.name, []);
  const filter = useListFilter(rows, words);
  const revoke = async (row: SignIn): Promise<void> => {
    setErrors(({ [row.id]: _gone, ...rest }) => rest);
    try {
      await host.request(REVOKE[row.kind], { id: row.id });
      await onChanged();
    } catch (err) {
      setErrors((prev) => ({ ...prev, [row.id]: refusalWords(err) }));
    }
  };
  const remove = async (row: SignIn): Promise<void> => {
    const last = lastManager(rows, row) ? ` It is the last device that can manage ${computer}.` : "";
    if (await confirmAction({ title: `Remove ${row.name}?`, body: `It must sign in again to come back.${last}`, action: "Remove", danger: true })) await revoke(row);
  };
  if (rows.length === 0) return <PageEmpty>No devices</PageEmpty>;
  return (
    <>
      <ListFilter filter={filter} label="Find a device" />
      {filter.shown.map((row) =>
        row.kind === "link" ? (
          <PageRow
            key={row.id}
            data-sign-in-link={row.id}
            title={row.name}
            description={
              <span className="tabular-nums">
                Sign-in link, {mayInLine(row.caps, computer)}, <Countdown prefix="ends in" at={row.expiresAt} />
              </span>
            }
            error={errors[row.id]}
          >
            <Button variant="ghost" size="sm" onClick={() => void revoke(row)}>
              Cancel the link
            </Button>
          </PageRow>
        ) : (
          <PageRow key={row.id} data-sign-in={row.id} data-device={row.device} title={row.name} description={row.line} error={errors[row.id]}>
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => void remove(row)}>
              Remove…
            </Button>
          </PageRow>
        ),
      )}
    </>
  );
}
