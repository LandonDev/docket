import type { ReactNode } from "react";
import type { RemoteStatus } from "@server/shared/contract-remote";
import { PageSection } from "../../../components/page";
import { SettingSwitch } from "../../../components/setting-switch";
import { confirmAction } from "../../../chrome/ConfirmDialog";
import { LOCAL_ENVIRONMENT_ID, WEB_ENVIRONMENT_ID, registry, useEnvironmentStatus } from "../../../lib/connection";
import { isWebMode } from "../../../lib/nativeWeb";
import { computerInLine } from "../../../lib/settings/computerName";
import { CommitField } from "../hosts/CommitField";
import { CopyButton } from "../hosts/CopyButton";
import { Fold } from "../parts/Fold";
import type { Host } from "../parts/hostRpc";
import { ManagedLine } from "../parts/ManagedLine";
import { SettingRow } from "../parts/SettingRow";
import { useSaved } from "../parts/useSaved";
import { SectionRead, useComputerRead } from "./read";

type Patch = { enabled?: boolean; port?: number; publicOrigin?: string };

/** Why the listener is not where the setting puts it; nothing while it runs as set. */
export function reachWords(status: RemoteStatus): string | undefined {
  if (status.running) return status.port !== status.configuredPort ? `TEMP_CODE_REMOTE_PORT holds it on ${status.port}` : undefined;
  if (status.error) return status.error;
  return status.enabled ? "Off: TEMP_CODE_REMOTE_PORT is 0" : undefined;
}

/** The page reaches the computer through the listener these rows change: a desktop's page of another computer, or
 *  the page the box serves. This Mac's own Sharing reaches its server without it. */
export const travelsThrough = (environmentId: string): boolean => isWebMode() || environmentId !== LOCAL_ENVIRONMENT_ID;

/**
 * Advanced, folded (docs/agents/settings.md "The pages: computers"): Let other devices reach <computer>, Port, Web
 * address and Computer ID, asked of that computer over its own link. Turning the listener off, or moving its port,
 * from a page that reaches the computer through it asks first: the page loses the computer. `children` are rows only
 * this Mac's Sharing has (Pause other computers' commands above load), between the address and the ID.
 */
export function Advanced({ host, rows, children, saysWhoCan = true, open = false }: { host: Host; rows: "sharing" | "pc"; children?: ReactNode; saysWhoCan?: boolean; open?: boolean }) {
  const manage = host.may("remote.settings.set", {});
  const status = useComputerRead<RemoteStatus>(host, "remote.status", { skip: !manage });
  const computer = computerInLine(host.name);
  // The id the computer answers its hello with: this window's own server and the page's own computer go by a fixed id here.
  const hello = useEnvironmentStatus(host.environmentId === LOCAL_ENVIRONMENT_ID ? registry.primaryEnvironmentId : host.environmentId).lastHello;
  const fixed = host.environmentId === LOCAL_ENVIRONMENT_ID || host.environmentId === WEB_ENVIRONMENT_ID;
  const id = fixed ? (hello?.environmentId ?? status.value?.environmentId) : host.environmentId;
  return (
    <Fold label="Advanced" defaultOpen={open}>
      <PageSection>
        {manage ? (
          <SectionRead read={status} computer={host.environmentId} rows={[{ control: "switch" }, { control: "number" }, { description: true, control: "field", wide: true }]}>
            {(value) => <ListenerRows host={host} rows={rows} status={value} onStatus={status.set} computer={computer} />}
          </SectionRead>
        ) : null}
        {children}
        {id ? (
          // The id is for pasting, never for reading: it sits behind Copy.
          <SettingRow id={`${rows}.id`}>
            <CopyButton text={id} label="Copy the computer ID" />
          </SettingRow>
        ) : null}
        {manage || !saysWhoCan ? null : <ManagedLine computer={host.name.name} />}
      </PageSection>
    </Fold>
  );
}

function ListenerRows({ host, rows, status, onStatus, computer }: { host: Host; rows: "sharing" | "pc"; status: RemoteStatus; onStatus: (s: RemoteStatus) => void; computer: string }) {
  const reach = useSaved();
  const port = useSaved();
  const address = useSaved();
  const travels = travelsThrough(host.environmentId);
  const set = (saved: ReturnType<typeof useSaved>, patch: Patch): Promise<boolean> =>
    saved.run(async () => onStatus(await host.request<RemoteStatus>("remote.settings.set", patch)));
  /** A change that cuts the line this page reaches the computer by asks first; false: he kept it. */
  const losesPage = (title: string, action: string): Promise<boolean> =>
    travels ? confirmAction({ title, body: "This page loses the computer until it can be reached again.", action, danger: true }) : Promise.resolve(true);
  return (
    <>
      <SettingRow id={`${rows}.reach`} vars={{ computer }} saved={reach} description={reachWords(status)}>
        <SettingSwitch
          label={`Let other devices reach ${computer}`}
          on={status.enabled}
          onChange={async (enabled) => (enabled || (await losesPage(`Stop other devices reaching ${computer}?`, "Turn off")) ? set(reach, { enabled }) : false)}
        />
      </SettingRow>
      <SettingRow id={`${rows}.port`} saved={port}>
        <CommitField
          kind="int"
          aria-label="Port"
          value={status.configuredPort}
          min={1}
          max={65535}
          onCommit={async (next) => (next !== null && (await losesPage(`Move ${computer} to port ${next}?`, "Move")) ? set(port, { port: next }) : false)}
        />
      </SettingRow>
      <SettingRow
        id={`${rows}.address`}
        wide
        saved={address}
        description={status.publicOrigin ? "Sign-in links start with it" : `Sign-in links start with ${status.origin}${status.learnedOrigin ? ", learned from the tunnel" : ""}`}
      >
        <CommitField
          aria-label="Web address"
          value={status.publicOrigin}
          placeholder="https://docket.example.com"
          className="w-64 @max-[30rem]/page:w-full"
          onCommit={(publicOrigin) => set(address, { publicOrigin })}
        />
      </SettingRow>
    </>
  );
}
