import type { AdmissionState } from "@server/shared/contract-admission";
import type { AttachmentSettings } from "@server/shared/contract-attachments";
import type { RemoteStatus } from "@server/shared/contract-remote";
import { PageSection } from "../../../components/page";
import { Button } from "../../../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip";
import { forgetAttachmentSettings } from "../../../lib/attachmentUpload";
import { computerInLine } from "../../../lib/settings/computerName";
import { CommitField } from "../hosts/CommitField";
import { ManagedLine } from "../parts/ManagedLine";
import { SettingRow, SettingSection } from "../parts/SettingRow";
import { useSaved } from "../parts/useSaved";
import type { Host } from "../parts/hostRpc";
import { SectionRead, useComputerRead } from "./read";
import { budgetWords, runningWords } from "./words";

const MB = 1024 * 1024;

/** A number's unit after its field, in the row's muted 12px. */
const Unit = ({ children }: { children: string }) => <span className="text-xs text-muted-foreground">{children}</span>;

/**
 * Threads at once, Tell me a thread is stuck after and Largest attachment for one computer, asked of that computer
 * over its own link (docs/agents/settings.md "The pages: computers"). `rows` is the map's prefix: `here` on this
 * Mac's Threads page, `pc` on another computer's page, under "Threads on <computer>". A key that may only read sees
 * what it may read as words and one line saying who can change them (`saysWhoCan`; a computer's page says it once,
 * under its title). The stuck clock's value requires admin, so the row says Hidden for other keys.
 */
export function ThreadsRows({ host, rows, saysWhoCan = true }: { host: Host; rows: "here" | "pc"; saysWhoCan?: boolean }) {
  const admission = useComputerRead<AdmissionState>(host, "admission.get", { poll: true });
  const manage = host.may("admission.set", { cap: 1 });
  const status = useComputerRead<RemoteStatus>(host, "remote.status", { skip: !manage });
  const attachments = useComputerRead<AttachmentSettings>(host, "attachment.settings");
  const vars = { computer: computerInLine(host.name) };
  const body = (
    <SectionRead read={admission} rows={[{ description: true, control: "number" }, { control: "number" }, { control: "number" }]}>
      {(state) => (
        <>
          <AtOnceRow host={host} id={`${rows}.atOnce`} state={state} onState={admission.set} manage={manage} />
          {manage ? (
            <SectionRead read={status} rows={1}>
              {(value) => <StuckRow host={host} id={`${rows}.stuck`} status={value} onStatus={status.set} />}
            </SectionRead>
          ) : (
            <SettingRow id={`${rows}.stuck`}>
              <span className="text-sm text-muted-foreground">Hidden</span>
            </SettingRow>
          )}
          <SectionRead read={attachments} rows={1}>
            {(value) => <AttachmentRow host={host} id={`${rows}.attachment`} settings={value} onSettings={attachments.set} manage={manage} />}
          </SectionRead>
          {manage || !saysWhoCan ? null : <ManagedLine computer={host.name.name} />}
        </>
      )}
    </SectionRead>
  );
  // This Mac's Threads page is these rows under its own title; another computer's page names them.
  return rows === "here" ? <PageSection>{body}</PageSection> : <SettingSection of="pc.atOnce" vars={vars}>{body}</SettingSection>;
}

function AtOnceRow({ host, id, state, onState, manage }: { host: Host; id: string; state: AdmissionState; onState: (s: AdmissionState) => void; manage: boolean }) {
  const saved = useSaved();
  const pin = (cap: number | null): Promise<boolean> => saved.run(async () => onState(await host.request<AdmissionState>("admission.set", { cap })));
  return (
    <SettingRow
      id={id}
      saved={saved}
      description={
        // What the default is sized from is a hover away, not a line.
        <Tooltip>
          <TooltipTrigger render={<span tabIndex={0} className="cursor-default rounded-sm tabular-nums focus-ring" />}>{runningWords(state)}</TooltipTrigger>
          <TooltipContent>{budgetWords(state)}</TooltipContent>
        </Tooltip>
      }
    >
      {manage ? (
        <>
          {state.pinned !== null ? (
            <Button variant="link" size="xs" className="text-muted-foreground" onClick={() => void pin(null)}>
              Use default
            </Button>
          ) : null}
          <CommitField
            kind="int"
            aria-label="Threads at once"
            value={state.pinned}
            min={1}
            max={10_000}
            placeholder={String(state.default)}
            onCommit={(cap) => (cap === null ? undefined : pin(cap))}
          />
        </>
      ) : (
        <span className="text-sm tabular-nums text-muted-foreground">{state.cap}</span>
      )}
    </SettingRow>
  );
}

function StuckRow({ host, id, status, onStatus }: { host: Host; id: string; status: RemoteStatus; onStatus: (s: RemoteStatus) => void }) {
  const saved = useSaved();
  return (
    <SettingRow id={id} saved={saved}>
      <CommitField
        kind="int"
        aria-label="Minutes before a thread is stuck"
        value={status.stuckMinutes}
        min={1}
        max={1440}
        onCommit={(stuckMinutes) =>
          stuckMinutes === null ? undefined : saved.run(async () => onStatus(await host.request<RemoteStatus>("remote.settings.set", { stuckMinutes })))
        }
      />
      <Unit>min</Unit>
    </SettingRow>
  );
}

function AttachmentRow({
  host,
  id,
  settings,
  onSettings,
  manage,
}: {
  host: Host;
  id: string;
  settings: AttachmentSettings;
  onSettings: (s: AttachmentSettings) => void;
  manage: boolean;
}) {
  const saved = useSaved();
  const value = Math.round(settings.maxBytes / MB);
  return (
    <SettingRow id={id} saved={saved}>
      {manage ? (
        <CommitField
          kind="int"
          aria-label="Largest attachment in MB"
          value={value}
          min={1}
          max={100_000}
          onCommit={(next) =>
            next === null
              ? undefined
              : saved.run(async () => {
                  const answer = await host.request<AttachmentSettings>("attachment.settings.set", { maxBytes: next * MB });
                  // Every window sending to it reads the limit again.
                  forgetAttachmentSettings();
                  onSettings(answer);
                })
          }
        />
      ) : (
        <span className="text-sm tabular-nums text-muted-foreground">{value}</span>
      )}
      <Unit>MB</Unit>
    </SettingRow>
  );
}
