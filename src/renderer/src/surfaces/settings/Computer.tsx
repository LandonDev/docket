import { useEffect, useState } from "react";
import { HIDES_EMPTY } from "./computers/read";
import { ReadFailure } from "./parts/ReadFailure";
import type { ComputerAppVerdict, ComputerServiceState, ComputerSettings } from "@server/shared/contract-computer";
import type { ActiveAppMode } from "@server/shared/computer/scheduleRules";
import { verdictWords } from "@server/shared/computer/words";
import type { MacBridgeHostPolicy } from "@server/shared/contract-macbridge";
import { confirmAction } from "../../chrome/ConfirmDialog";
import { ChoiceSelect } from "../../components/choice-select";
import { PageEmpty, PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { BusyLabel, Button } from "../../components/ui/button";
import { StatusMark, computerServiceMarkOf } from "../../components/ui/status";
import { setComputerService, useComputerService } from "../../lib/computerSessions";
import { registry } from "../../lib/connection";
import { useHostRead } from "../../lib/connection/hostRead";
import type { Link } from "../../lib/connection/link";
import { refreshMacBridgeHosts, useMacBridgeHosts } from "../../lib/macBridge";
import { openMaySheet } from "../../lib/settings/maySheet";
import { thisDesktopInLine } from "../../lib/native";
import { useComputerNames } from "../../lib/settings/computerName";
import {
  IDLE_MINUTES,
  forgetComputerApps,
  idleMinutes,
  idleMs,
  onComputerSettings,
  readComputerSettings,
  retryComputerService,
  setComputerSettings,
  sortApps,
  useComputerPermissions,
} from "../../lib/tcserver/computerSettings";
import { CommitField } from "./hosts/CommitField";
import { ListFilter, useListFilter } from "./parts/ListFilter";
import { Permissions } from "./parts/Permissions";
import { OpenCue, SettingRow, SettingSection } from "./parts/SettingRow";
import { useSaved, type Saved } from "./parts/useSaved";

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** When a step that needs the app in front gets it (docs/computer-protocol.md §26.6). */
const ACTIVE_APP_CHOICES: { value: ActiveAppMode; label: string }[] = [
  { value: "brief", label: "Bring it forward briefly" },
  { value: "away", label: "Wait until I'm away" },
];

/**
 * Settings › Computer use, on this Mac's own computer (`computer.*`): how threads use this Mac's apps. The helper's
 * row only while it is down; how long he must be away before a thread takes the pointer, what a step does about the
 * app in front, the pictures kept of each step and who may watch, each saved with the mark; who may use the apps
 * (threads here always, each linked computer as Sharing set it); the two macOS grants, the one place both are listed;
 * and every app it learned, with Forget.
 */
export function ComputerPage() {
  const link = registry.primary();
  const mac = thisDesktopInLine();
  const service = useComputerService(link.environmentId);
  const settings = useHostRead(link, () => readComputerSettings(link));
  const { set } = settings;
  const perms = useComputerPermissions(link, service);
  useEffect(() => onComputerSettings(link, set), [link, set]);


  return (
    <>
      <PageSection className={HIDES_EMPTY}>
        <HelperRow link={link} service={service} />
        {settings.value ? (
          <SettingsRows link={link} value={settings.value} onSaved={set} />
        ) : settings.error ? (
          <ReadFailure computer={link.environmentId} error={settings.error} retry={settings.retry} />
        ) : (
          <PageRowsSkeleton rows={[{ control: "number" }, { control: "select", wide: true }, { control: "switch" }, { control: "switch" }]} />
        )}
      </PageSection>

      <WhoMayUse mac={mac} />

      <SettingSection of="computer.accessibility">
        {perms.value === null ? (
          <ReadFailure computer={link.environmentId} error="Couldn't read the permissions" retry={perms.retry} />
        ) : perms.error ? (
          <ReadFailure computer={link.environmentId} error={perms.error} retry={perms.retry} />
        ) : (
          <Permissions
            accessibility={perms.value ? perms.value.accessibility : null}
            screen={perms.value ? perms.value.screenRecording : null}
            without={{ accessibility: "Threads cannot read or use an app without it", screen: "Threads cannot see a window without it" }}
          />
        )}
      </SettingSection>

      {/* One failed read is one line, said once in the first section: the apps it also feeds wait for its Retry. */}
      {settings.value === undefined && settings.error ? null : <AppsSection link={link} apps={settings.value?.apps} onForgot={set} />}
    </>
  );
}

/** The four settings, each asked of this computer and saved with the mark; a refusal puts the control back. */
function SettingsRows({ link, value, onSaved }: { link: Link; value: ComputerSettings; onSaved: (settings: ComputerSettings) => void }) {
  const wait = useSaved();
  const front = useSaved();
  const pictures = useSaved();
  const watch = useSaved();
  const [activeApp, setActiveApp] = useState<ActiveAppMode | null>(null);
  const save = (saved: Saved, patch: Partial<Omit<ComputerSettings, "apps">>) => saved.run(async () => onSaved(await setComputerSettings(link, patch)));

  return (
    <>
      <SettingRow id="computer.wait" saved={wait}>
        <CommitField
          kind="int"
          aria-label="Wait after my last input, in minutes"
          value={idleMinutes(value.sessionIdleMs)}
          min={IDLE_MINUTES.min}
          max={IDLE_MINUTES.max}
          onCommit={(minutes) => (minutes === null ? false : save(wait, { sessionIdleMs: idleMs(minutes) }))}
        />
        <span className="text-xs text-muted-foreground">min</span>
      </SettingRow>
      {/* A long title beside a long choice: at a narrow width the choice takes its own full line. */}
      <SettingRow id="computer.front" saved={front} wide>
        <ChoiceSelect
          className="@max-[30rem]/page:w-full"
          label="When a step needs an app in front"
          value={activeApp ?? value.activeApp}
          options={ACTIVE_APP_CHOICES}
          onChange={(choice) => {
            setActiveApp(choice);
            void save(front, { activeApp: choice }).then(() => setActiveApp(null));
          }}
        />
      </SettingRow>
      <SettingRow id="computer.pictures" saved={pictures}>
        <SettingSwitch
          label="Keep pictures of each step"
          on={value.keepPictures}
          onChange={async (keep) => {
            // Off deletes what was kept: it asks first.
            if (!keep) {
              const yes = await confirmAction({
                title: "Stop keeping pictures",
                body: "The pictures kept of each step are deleted. The steps and what was read stay.",
                action: "Delete pictures",
                danger: true,
              });
              if (!yes) return false;
            }
            return save(pictures, { keepPictures: keep });
          }}
        />
      </SettingRow>
      <SettingRow id="computer.watch" saved={watch}>
        <SettingSwitch label="Let my other devices watch" on={value.videoRemote} onChange={(on) => save(watch, { videoRemote: on })} />
      </SettingRow>
    </>
  );
}

/** The helper's state, only while it cannot run; Try again only while it is down after crashes. */
function HelperRow({ link, service }: { link: Link; service: ComputerServiceState | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!service || (service.state !== "down" && service.state !== "unavailable")) return null;
  const mark = computerServiceMarkOf(service);
  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      setComputerService(link.environmentId, await retryComputerService(link));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    // A mark with its detail and Try again outgrow a narrow page: they take a line of their own there.
    <SettingRow id="computer.helper" error={error} wide={mark.detail !== undefined}>
      <StatusMark state={mark.state} word={mark.word} detail={mark.detail} glyph={mark.state !== "idle"} />
      {service.state === "down" ? (
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void retry()}>
          <BusyLabel busy={busy} label="Try again" />
        </Button>
      ) : null}
    </SettingRow>
  );
}

/** What a linked computer may do with this Mac's apps, as Sharing set it. */
export function appsWords(pc: Pick<MacBridgeHostPolicy, "computer" | "computerLive" | "computerUnavailable">): string {
  if (!pc.computer) return "Not allowed";
  const why = pc.computerUnavailable;
  // His grant stands; the reason this Mac cannot serve it now is the host's own sentence.
  if (why) return `Allowed. ${why}`;
  return pc.computerLive > 0 ? `Allowed, ${pc.computerLive} using it now` : "Allowed";
}

/** Threads here always may; each linked computer by its own name, a row that opens what it may do on this Mac (its sheet). */
function WhoMayUse({ mac }: { mac: string }) {
  const hosts = useMacBridgeHosts();
  const names = useComputerNames();
  useEffect(() => {
    void refreshMacBridgeHosts().catch(() => {});
  }, []);
  return (
    <SettingSection of="computer.others" vars={{ mac }}>
      <SettingRow id="computer.own" vars={{ mac }} description="Always" />
      {hosts.map((host) => {
        const name = names(host.environmentId, host.name).name;
        return (
          <PageRow
            key={host.environmentId}
            data-computer={host.environmentId}
            title={name}
            description={appsWords(host)}
            onOpen={() => openMaySheet(host.environmentId)}
            openLabel={name}
          >
            <OpenCue />
          </PageRow>
        );
      })}
    </SettingSection>
  );
}

/** An app's name; one saved before names were kept is said as one, never as its bundle id. */
export const appName = (app: Pick<ComputerAppVerdict, "name">): string => app.name ?? "An app with no name";

/** Every app it learned, with Forget; the next call to a forgotten app learns it again, so one asks nothing. Forget
 *  all… asks first. */
function AppsSection({
  link,
  apps,
  onForgot,
}: {
  link: Link;
  apps: ComputerAppVerdict[] | undefined;
  onForgot: (settings: Awaited<ReturnType<typeof forgetComputerApps>>) => void;
}) {
  // The app being forgotten ("" for all), and a refusal with the key it belongs to.
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ key: string; line: string } | null>(null);
  const sorted = apps ? sortApps(apps) : [];
  const filter = useListFilter(sorted, appName);
  const forget = async (bundleId: string | null) => {
    const key = bundleId ?? "";
    if (bundleId === null) {
      const yes = await confirmAction({
        title: "Forget every app",
        body: `Docket forgets what it learned about driving ${sorted.length} apps. Each is learned again the next time a thread uses it.`,
        action: "Forget all",
        danger: true,
      });
      if (!yes) return;
    }
    setForgetting(key);
    setRefused(null);
    try {
      onForgot(await forgetComputerApps(link, bundleId));
    } catch (err) {
      setRefused({ key, line: message(err) });
    } finally {
      setForgetting(null);
    }
  };
  return (
    <SettingSection of="computer.apps">
      {apps ? (
        sorted.length ? (
          <>
            <ListFilter filter={filter} label="Find an app" />
            {filter.shown.map((app) => {
              const name = appName(app);
              return (
                <PageRow
                  key={app.bundleId}
                  data-app={app.bundleId}
                  title={name}
                  description={verdictWords(app.classes) ?? undefined}
                  error={refused?.key === app.bundleId ? refused.line : undefined}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`Forget ${app.name ?? "an app with no name"}`}
                    disabled={forgetting !== null}
                    onClick={() => void forget(app.bundleId)}
                  >
                    <BusyLabel busy={forgetting === app.bundleId} label="Forget" />
                  </Button>
                </PageRow>
              );
            })}
            {/* It asks first and forgets them all: last in its section, after the apps it forgets, its refusal under it. */}
            {sorted.length >= 2 ? (
              <div className="pt-2">
                <Button
                  data-setting="computer.forgetAll"
                  variant="ghost"
                  size="sm"
                  className="-ms-2.5 text-muted-foreground hover:text-destructive"
                  disabled={forgetting !== null}
                  onClick={() => void forget(null)}
                >
                  <BusyLabel busy={forgetting === ""} label="Forget all…" />
                </Button>
              </div>
            ) : null}
            {refused?.key === "" ? <PageError>{refused.line}</PageError> : null}
          </>
        ) : (
          <PageEmpty>No apps used yet</PageEmpty>
        )
      ) : (
        <PageRowsSkeleton rows={[{ description: true, control: "button" }, { control: "button" }]} />
      )}
    </SettingSection>
  );
}
