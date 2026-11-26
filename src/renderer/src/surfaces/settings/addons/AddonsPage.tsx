import { useState } from "react";
import { grantFieldNames } from "@shared/addons";
import type { AddonRow } from "@shared/contract-addons";
import { confirmAction } from "../../../chrome/ConfirmDialog";
import { PageActions, PageEmpty, PageError, PageRowsSkeleton } from "../../../components/page";
import { Button } from "../../../components/ui/button";
import { registry, type Link } from "../../../lib/connection";
import { isWebMode } from "../../../lib/nativeWeb";
import { homeNote, refusalWords } from "../../../lib/settingsHome";
import { useWorkspaces } from "../../../lib/tcserver/workspaces";
import { AddonDialog } from "./AddonDialog";
import { AddonKeyDialog } from "./AddonKeyDialog";
import { AddonRowView } from "./AddonRow";
import { scopeName, type AddonMenuPick } from "./addonWords";
import { useAddonsPage } from "./useAddons";
import { usePublishHome } from "../../../lib/settings/pageHome";
import { useHost } from "../parts/hostRpc";
import { ListFilter, useListFilter } from "../parts/ListFilter";
import { ManagedLine } from "../parts/ManagedLine";
import { SettingSection } from "../parts/SettingRow";

const NONE: readonly AddonRow[] = [];
/** What the find field matches: the name, its description, and where it connects. */
const addonWords = (row: AddonRow): string => `${row.name} ${row.description} ${row.spec.transport === "http" ? row.spec.url : row.spec.command}`;

/**
 * Settings → Add-ons (docs/agents/settings.md "The pages: Everywhere"): one list of every add-on this computer knows,
 * where it applies said on each row, a find field past eight, Add… on the page's title line. It reads through this
 * window's own computer, which forwards every write to the one copy on the box; the page's line says where that is
 * (`usePublishHome`), and while the box is out of reach every control is held. A key that may not change add-ons sees
 * the list as words and one line saying who can.
 */
export function AddonsPage() {
  return <AddonsBody link={registry.primary()} />;
}

export function AddonsBody({ link }: { link: Link }) {
  const { data, error, retry, grantsError, retryGrants, replaceRow, dropRow } = useAddonsPage(link);
  const [editing, setEditing] = useState<AddonRow | "new" | null>(null);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const workspaces = useWorkspaces().filter((w) => w.environmentId === link.environmentId);
  const names = new Map(workspaces.map((w) => [w.id, w.name]));
  const { blocked } = homeNote(data?.home);
  usePublishHome("addons", data ? (data.home ?? null) : undefined);
  const host = useHost(link.environmentId);
  const readOnly = !host.may("addons.set");
  const filter = useListFilter(data?.addons ?? NONE, addonWords);
  const web = isWebMode();
  const unread = data?.grants === undefined ? "Loading" : data.grants === null ? (grantsError ?? "Couldn't read the keys") : undefined;

  const setRowError = (id: string, message: string | null) =>
    setRowErrors((cur) => {
      if (message === null && !(id in cur)) return cur;
      const next = { ...cur };
      if (message === null) delete next[id];
      else next[id] = message;
      return next;
    });
  /** A request a row makes: its refusal goes under the row, without "refused: ". */
  const act = <T,>(row: AddonRow, run: () => Promise<T>): Promise<T | false> => {
    setRowError(row.id, null);
    return run().catch((err: unknown) => {
      setRowError(row.id, refusalWords(err) || "The computer refused it");
      return false as const;
    });
  };

  const toggle = (row: AddonRow, enabled: boolean) =>
    act(row, () =>
      link
        .request<{ addon: AddonRow }>("addons.set", { addon: { id: row.id, name: row.name, workspaceId: row.workspaceId, description: row.description, spec: row.spec, enabled } })
        .then((answer) => replaceRow(answer.addon)),
    );

  const pick = (row: AddonRow, id: AddonMenuPick) => {
    switch (id) {
      case "edit":
        setEditing(row);
        return;
      case "key":
        setKeyFor(row.id);
        return;
      case "signin":
        void act(row, () => link.request("addons.grant.signIn", { id: row.id }));
        return;
      case "cancel-signin":
        void act(row, () => link.request("addons.grant.cancel", { id: row.id }));
        return;
      case "signout":
        void confirmAction({
          title: `Sign out of ${row.name}`,
          body: "Its tools stop working until you sign in again.",
          action: "Sign out",
          danger: true,
        }).then((ok) => {
          if (ok) void act(row, () => link.request("addons.grant.clear", { id: row.id }));
        });
        return;
      case "remove":
        void confirmAction({
          title: `Remove the add-on ${row.name}`,
          body: "Its tools leave every thread, and its key or sign-in goes with it.",
          action: "Remove",
          danger: true,
        }).then((ok) => {
          if (ok) void act(row, () => link.request<{ removed: boolean }>("addons.remove", { id: row.id }).then(() => dropRow(row.id)));
        });
        return;
    }
  };

  const keyRow = keyFor ? data?.addons.find((r) => r.id === keyFor) : undefined;
  return (
    <>
      {readOnly ? null : (
        <PageActions>
          <Button variant="ghost" size="sm" disabled={!data || blocked} onClick={() => setEditing("new")}>
            Add…
          </Button>
        </PageActions>
      )}
      <SettingSection of="addons.list">
        {data ? <ListFilter filter={filter} label="Find an add-on" /> : null}
        {!data ? (
          error ? (
            <PageError
              action={
                <Button variant="ghost" size="sm" onClick={retry}>
                  Retry
                </Button>
              }
            >
              {error}
            </PageError>
          ) : (
            <PageRowsSkeleton rows={3} description={2} control="switch" />
          )
        ) : data.addons.length === 0 ? (
          <PageEmpty>No add-ons</PageEmpty>
        ) : (
          filter.shown.map((row) => {
            const grant = data.grants === undefined || data.grants === null ? undefined : (data.grants.get(row.id) ?? null);
            const signInError = grant?.signIn?.state === "failed" ? grant.signIn.error : undefined;
            return (
              <AddonRowView
                key={row.id}
                row={row}
                status={data.status[row.id]}
                grant={grant}
                unread={unread}
                workspaceName={scopeName(row.workspaceId, names)}
                web={web}
                blocked={blocked}
                readOnly={readOnly}
                error={rowErrors[row.id] ?? signInError}
                onToggle={(on) => toggle(row, on)}
                onPick={(id) => pick(row, id)}
              />
            );
          })
        )}
        {data && grantsError ? (
          <PageError
            action={
              <Button variant="ghost" size="sm" onClick={retryGrants}>
                Retry
              </Button>
            }
          >
            {grantsError}
          </PageError>
        ) : null}
        {data && readOnly ? <ManagedLine computer={host.name.name} /> : null}
      </SettingSection>
      {editing ? (
        <AddonDialog
          link={link}
          row={editing === "new" ? null : editing}
          workspaces={workspaces}
          home={data?.home}
          onClose={() => setEditing(null)}
          onSaved={(saved, isNew) => {
            replaceRow(saved);
            setEditing(null);
            if (isNew && grantFieldNames(saved.spec).length > 0) setKeyFor(saved.id);
          }}
        />
      ) : null}
      {keyRow ? <AddonKeyDialog link={link} row={keyRow} grant={data?.grants?.get(keyRow.id) ?? null} onClose={() => setKeyFor(null)} /> : null}
    </>
  );
}
