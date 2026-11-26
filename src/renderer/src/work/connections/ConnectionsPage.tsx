import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ClientRequest } from "@shared/contract";
import type { HealthFix, HealthReport, HealthRow } from "@shared/work/health";
import { lapseLine } from "@shared/work/health";
import { syncWhen } from "@shared/work/messages";
import { PageActions, PageRow, PageSection } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { StatusMark } from "../../components/ui/status";
import { registry, useEnvironments, useEnvironmentStatuses } from "../../lib/connection";
import { hostFailure } from "../../lib/hostFailure";
import { NO_ANSWER } from "../../lib/connection/openRead";
import { nameInLine } from "../../lib/hostWords";
import { managedElsewhere, signInElsewhere, useLinkMay } from "../../lib/linkMay";
import { requestSettings } from "../../lib/monaco/debugTab";
import { openUrl } from "../../lib/native";
import { workErrorWords } from "../../lib/workErrorWords";
import { useWorkHosts, workSwitch } from "../../lib/workSwitch";
import { AddinRow } from "../office/AddinRow";
import { SignInFor } from "../shell/DownSignIn";
import { useLifeosStatusHeard } from "../shell/lifeos";
import { signInOnVm } from "../winvm/signIn";
import { FirstCheckBones } from "./FirstCheckBones";
import { checkFailure, commandOf, fixVariant, markOf, sectionsOf, signOutAsk, signsOut, unchecked, usableFix, type HostView, type PlacedRow } from "./model";
import { confirmAction } from "../../chrome/ConfirmDialog";
import { computerInLine, useComputerNames } from "../../lib/settings/computerName";
import { ComputerName } from "../../surfaces/settings/parts/ComputerName";
import { OpenCue } from "../../surfaces/settings/parts/SettingRow";
import { COPIED_MS, copyText } from "../../lib/clipboard";

/**
 * Settings → Connections (docs/agents/work-connections.md): every sign-in
 * and helper Work leans on, per host, as working, broken or needs you, with
 * the fix beside each. The checks run when the page opens, on Check again
 * and when a host's LifeOS state changes, never on a timer; a host this
 * window is not linked to now is offline, not broken.
 */

/** A host's checks can take each pillar's 10 s at once, then the trip: past this the host is said not to answer. */
const CHECK_DEADLINE_MS = 25_000;

/**
 * Each host's last report, in this window's memory: the page opens on it, every row still checking, rather than on
 * bones for up to 25 s. Names and states of his connections only; dropped with Work off on every host.
 */
const lastReports = new Map<string, HealthReport>();
workSwitch.subscribe(() => {
  if (!workSwitch.anyOn()) lastReports.clear();
});
/** Tests: nothing kept. */
export const forgetReports = (): void => lastReports.clear();

export function ConnectionsPage() {
  const environments = useEnvironments();
  const statuses = useEnvironmentStatuses();
  const on = useWorkHosts();
  // Each computer by its one name, and this window's own as "this Mac" mid-sentence.
  const names = useComputerNames();
  const hosts = environments.filter((e) => on.has(e.id)).map((e) => ({ ...e, name: names(e.id).name, inLine: computerInLine(names(e.id)), own: names(e.id).own }));
  const [views, setViews] = useState<Record<string, HostView>>(() =>
    Object.fromEntries(hosts.flatMap((h) => {
      const report = lastReports.get(h.id);
      return report ? [[h.id, { id: h.id, name: h.name, status: "checking", report } as HostView]] : [];
    })),
  );

  /**
   * `fresh`: his own press, which the host runs anew; the page's open may be answered from the host's last few seconds.
   * `by`: the press that began the check (`HostView` checking), whose button alone spins.
   */
  const checkHost = useCallback(async (id: string, name: string, fresh = false, by?: string): Promise<void> => {
    // A host whose check failed keeps its Hosts row while it is asked again.
    setViews((all) => ({ ...all, [id]: { id, name, status: "checking", report: viewReport(all[id]), ...(wasSilent(all[id]) ? { silent: true } : {}), ...failedOf(all[id]), ...(by ? { by } : {}) } }));
    let next: HostView;
    try {
      const report = await withDeadline(registry.linkOf(id).request<HealthReport>("work.health", fresh ? { fresh: true } : {}), CHECK_DEADLINE_MS);
      lastReports.set(id, report);
      next = { id, name, status: "ready", report };
    } catch (err) {
      const { error, silent } = checkFailure(workErrorWords(err, { host: nameInLine(name) }));
      next = { id, name, status: "failed", error, silent };
    }
    setViews((all) => ({ ...all, [id]: next.status === "failed" ? { ...next, report: viewReport(all[id]) } : next }));
  }, []);

  const linked = (id: string): boolean => statuses.get(id)?.transport === "open";
  // Check again spins only for a round it began (the page's first, or its own press): a row's Retry spins itself, and a
  // check the page ran by itself (a link back, LifeOS changed, a fix done) spins nothing.
  const [round, setRound] = useState(true);
  const checkAll = (): void => {
    setRound(true);
    for (const host of hosts) if (linked(host.id)) void checkHost(host.id, host.name, true);
  };

  // Once when the page opens, and again each time a host's link comes back: a host that went offline is forgotten, so its return is checked, never its old rows shown as now.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const host of hosts) {
      if (!linked(host.id)) {
        asked.current.delete(host.id);
        continue;
      }
      if (asked.current.has(host.id)) continue;
      asked.current.add(host.id);
      void checkHost(host.id, host.name);
    }
  });

  const shown: HostView[] = hosts.map((h) => ({ ...(linked(h.id) ? (views[h.id] ?? { id: h.id, name: h.name, status: "checking" }) : { id: h.id, name: h.name, status: "offline" }), inLine: h.inLine, own: h.own }) as HostView);
  const checking = shown.some((h) => h.status === "checking");
  useEffect(() => {
    if (!checking) setRound(false);
  }, [checking]);
  // With no host linked there is nothing to ask: Check again is off, and each host's row says it is offline.
  const none = !shown.some((h) => h.status !== "offline");
  return (
    <>
      <PageActions>
        <Button variant="ghost" size="sm" disabled={checking || none} onClick={checkAll}>
          <BusyLabel busy={checking && round} label="Check again" />
        </Button>
      </PageActions>
      <ConnectionsView hosts={shown} onRecheck={(id, by) => void checkHost(id, hosts.find((h) => h.id === id)?.name ?? id, true, by)} />
      {hosts.map((one) => (linked(one.id) ? <LifeosWatch key={one.id} environmentId={one.id} onChange={() => void checkHost(one.id, one.name, true)} /> : null))}
    </>
  );
}

/**
 * A host's LifeOS state as its push says it: when it changes (signed in elsewhere, LifeOS back, a sign-out), that host
 * is checked again, so its LifeOS rows are true with no press. The first state it hears is what the page opened on.
 */
function LifeosWatch({ environmentId, onChange }: { environmentId: string; onChange: () => void }) {
  // Heard, not asked: the page's own check asks the host, and the rail already watches it.
  const state = useLifeosStatusHeard(environmentId)?.lifeos.state ?? null;
  const heard = useRef<string | null>(null);
  useEffect(() => {
    if (state === null) return;
    const was = heard.current;
    heard.current = state;
    if (was !== null && was !== state) onChange();
    // `onChange` is a new function each render; the state alone says when to ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  return null;
}

const viewReport = (view: HostView | undefined): HealthReport | undefined => (view && "report" in view ? view.report : undefined);
/** A host whose last check went unanswered, or that is asked again after one. */
const failedOf = (view: HostView | undefined): { failed?: { error?: string } } =>
  view?.status === "failed" ? { failed: view.error ? { error: view.error } : {} } : view?.status === "checking" && view.failed ? { failed: view.failed } : {};
const wasSilent = (view: HostView | undefined): boolean => (view?.status === "failed" || view?.status === "checking") && !!view.silent;

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(NO_ANSWER)), ms);
    promise.then(
      (value) => (window.clearTimeout(timer), resolve(value)),
      (err: unknown) => (window.clearTimeout(timer), reject(err)),
    );
  });
}

/**
 * A row's state line as a block in the description, its detail wrapping: a narrow window cuts none of the fix's words.
 * The glyph keeps the word's first 16px line (1px over its 14px), never the middle of a wrapped block.
 */
const STATE_LINE = "flex [&>[data-slot=status-detail]]:whitespace-normal [&>[data-slot=status-glyph]]:mt-px [&>[data-slot=status-glyph]]:self-start";

/** The page as the hosts' answers leave it: what the preview and the test draw. */
export function ConnectionsView({ hosts, onRecheck, now = Date.now() }: { hosts: readonly HostView[]; onRecheck: (hostId: string, by?: string) => void; now?: number }) {
  // The Windows VM is a computer: its row stands under Computers, with the computers that could not be checked.
  const all = sectionsOf(hosts);
  const machines = all.filter((section) => section.group === "Windows VM").flatMap((section) => section.rows);
  const sections = all.filter((section) => section.group !== "Windows VM");
  const away = unchecked(hosts);
  const waiting = hosts.filter((h) => h.status === "checking" && !h.report);
  // Each host asked now, with the press that asked it (none for a round or a check of the page's own).
  const checking = new Map(hosts.flatMap((h) => (h.status === "checking" ? [[h.id, h.by ?? null] as const] : [])));
  return (
    <>
      {away.length || machines.length ? (
        <PageSection title="Computers" data-setting="connections.list">
          {away.map((one) => {
            const title = <ComputerName computer={{ name: one.name, own: !!one.own }} />;
            if (one.status === "offline") return <PageRow key={one.id} title={title} description={<StatusMark state="stopped" word="Offline" detail="Checked when it is back" />} />;
            const why = one.status === "failed" ? one.error : one.status === "checking" ? one.failed?.error : undefined;
            // Work off there is no failure and no Retry can mend it: the words, and the way to the switch.
            if (why && workOff(why))
              return (
                <PageRow key={one.id} data-work-off={one.id} title={title} description={why} onOpen={() => requestSettings("work", "work.on")} openLabel="Work is on for">
                  <OpenCue />
                </PageRow>
              );
            return (
              <PageRow key={one.id} title={title} description={<StatusMark className={STATE_LINE} state="failed" word={"silent" in one && one.silent ? "Did not answer" : "Not checked"} detail={why} />}>
                {/* The row's own press, a ghost as every Retry is; it spins while the check it began runs, and a new cause replaces the reason. */}
                <Button data-host-retry variant="ghost" size="sm" disabled={one.status === "checking"} onClick={() => onRecheck(one.id, "hosts")}>
                  <BusyLabel busy={one.status === "checking" && one.by === "hosts"} label="Retry" />
                </Button>
              </PageRow>
            );
          })}
          {machines.map((placed) => (
            <ConnectionRow key={placed.key} placed={placed} now={now} checking={checking.has(placed.hostId)} spinning={checking.get(placed.hostId) === placed.key} onRetry={() => onRecheck(placed.hostId, placed.key)} onDone={() => onRecheck(placed.hostId)} />
          ))}
        </PageSection>
      ) : null}
      {sections.map((section) => (
        <PageSection key={section.group} data-setting="connections.list" title={section.titled ? section.group : undefined} aria-label={section.titled ? undefined : section.group}>
          {section.rows.map((placed) => (
            <ConnectionRow key={placed.key} placed={placed} now={now} checking={checking.has(placed.hostId)} spinning={checking.get(placed.hostId) === placed.key} onRetry={() => onRecheck(placed.hostId, placed.key)} onDone={() => onRecheck(placed.hostId)} />
          ))}
        </PageSection>
      ))}
      {/* A heading's bone over the rows, as the first section lands. */}
      {waiting.length && !sections.length ? <FirstCheckBones /> : null}
    </>
  );
}

/**
 * A row the page draws with a pillar's own control rather than a fix: the
 * Office add-in, whose pairings (Pair…, each paired add-in with Remove) live
 * only here. The host's row still says the same for a thread.
 */
const OWN_ROWS: Record<string, (hostId: string, title: string) => ReactNode> = {
  "office.addin": (hostId, title) => <AddinRow link={registry.linkOf(hostId)} title={title} />,
};

/** One connection: what it is, its state and its one line, then when it lapses and the fix. */
function ConnectionRow(props: { placed: PlacedRow; now: number; checking: boolean; spinning: boolean; onRetry: () => void; onDone: () => void }) {
  const own = OWN_ROWS[props.placed.row.id];
  if (own) return <>{own(props.placed.hostId, props.placed.title)}</>;
  return <FixRow {...props} />;
}

/**
 * `checking`: the row's host is being asked again (its Retry is off); `spinning`: by this row's Retry, which spins.
 * `onRetry` asks that host again for this row's press; `onDone` asks it again once a fix is done, with no spin.
 */
function FixRow({ placed, now, checking, spinning, onRetry, onDone }: { placed: PlacedRow; now: number; checking: boolean; spinning: boolean; onRetry: () => void; onDone: () => void }) {
  const { row, hostId } = placed;
  const mark = markOf(row.state);
  const usable = usableFix(row.fix, registry.primary().environmentId === hostId);
  // A fix this window's key may not run on that host (LifeOS's sign-in and sign-out on a given computer) is not drawn;
  // on a row that needs him, a line says who can, by the act (`signInElsewhere` for LifeOS's sign-in), as every reader does.
  const fix = useLinkMay(hostId, fixMethod(usable) ?? "work.health") ? usable : null;
  const hostName = registry.environment(hostId)?.name ?? "this computer";
  // The computer by the name this window lists it under, for the words a press asks with.
  const listed = useEnvironments().find((e) => e.id === hostId)?.name ?? hostName;
  const whoCan = usable && !fix && row.state === "needs-you" ? (usable.kind === "page" && usable.page === "lifeos-sign-in" ? signInElsewhere(hostName) : managedElsewhere(hostName)) : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  // LifeOS's silence: Retry asks the row's host again, that host alone, as Check again would, beside the row's account
  // control (the sign-in row's Sign out), which stays as it is. A row its silent host left (`hushed`) has none.
  const retry = !placed.hushed && row.lifeos === "unreachable";
  // A shell command in the host's line rides "Copy the fix": the line reads as words.
  const { words: line, command } = commandOf(placed.line ?? row.line ?? "");
  const press = async (fix: HealthFix): Promise<void> => {
    setError(null);
    // A sign-out asks first, naming what stops working until the next sign-in.
    if (signsOut(fix) && !(await confirmAction(signOutAsk(placed.row.title, nameInLine(listed))))) return;
    if (fix.kind === "open") return void openUrl(fix.url).catch((err: unknown) => setError(workErrorWords(err) || "The page did not open."));
    if (fix.kind === "page") {
      if (fix.page === "lifeos-sign-in") return setSigningIn(true);
      if (fix.page.startsWith("settings:")) return requestSettings(fix.page.slice("settings:".length) as never);
      if (fix.page !== "windows-vm-sign-in") return;
    }
    setBusy(true);
    try {
      if (fix.kind === "page") await signInOnVm(hostId);
      else await registry.linkOf(hostId).request(fix.method, fix.params ?? {});
      onDone();
    } catch (err) {
      setError(hostFailure(hostId, err, "did not finish it", true));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {/* A row that ends on a date is wide: under 480px of page its date and press take a line under the words, which keep their room. So is a LifeOS row the page words, whose sentence names the computer, when a press follows it. */}
      <PageRow
        wide={Boolean(row.until) || Boolean(placed.line && (fix || retry))}
        title={placed.title}
        description={
          <>
            <StatusMark className={STATE_LINE} state={mark.state} word={mark.word} detail={placed.hushed ? undefined : row.at === undefined ? line : [line, syncWhen(row.at, now)].filter(Boolean).join(" ")} />
            {whoCan ? <span data-who-can className="block">{whoCan}</span> : null}
          </>
        }
        error={error ?? undefined}
      >
        {row.until ? <span className="text-xs tabular-nums text-muted-foreground">{lapseWords(row, now)}</span> : null}
        {retry ? (
          <Button variant="ghost" size="sm" disabled={checking} onClick={onRetry}>
            <BusyLabel busy={spinning} label="Retry" />
          </Button>
        ) : null}
        {command ? <CopyFix command={command} /> : null}
        {fix ? (
          <Button variant={fixVariant(row.state)} size="sm" disabled={busy} onClick={() => void press(fix)}>
            <BusyLabel busy={busy} label={fixLabel(fix)} />
          </Button>
        ) : null}
      </PageRow>
      {signingIn ? <LifeosSignIn environmentId={hostId} onClose={() => (setSigningIn(false), onDone())} /> : null}
    </>
  );
}

/**
 * A fix's words on its button: one that opens a dialog or asks first ends in "…" (a sign-in, a sign-out), so the same
 * verb never reads two ways on two rows.
 */
export function fixLabel(fix: HealthFix): string {
  const asks = signsOut(fix) || fix.kind === "page";
  return asks && !fix.label.endsWith("…") ? `${fix.label}…` : fix.label;
}

/** What a row's end date is: the Windows VM's is its licence's, a sign-in's is the sign-in's. */
export function lapseWords(row: Pick<HealthRow, "until" | "group" | "id">, now: number): string {
  const line = lapseLine(row.until!, now);
  const what = row.group === "Windows VM" ? "Licence" : /sign/i.test(row.id) ? "Sign-in" : null;
  return what ? `${what} ${line.charAt(0).toLowerCase()}${line.slice(1)}` : line;
}

/** A check refused because Work is off on that computer: words and the way to Setup, never a failure. */
export const workOff = (why: string): boolean => /^Work is off\b/i.test(why.trim());

/** The command a host put in a row's line, copied at a press: the word says Copied for a moment after. */
function CopyFix({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <Button data-copy-fix={command} variant="ghost" size="sm" onClick={() => void copyText(command).then(() => setCopied(true), () => setCopied(false))}>
      {copied ? "Copied" : "Copy the fix"}
    </Button>
  );
}

/** The host method a fix's press ends in, if any: what `linkMay` asks before it is drawn. */
export function fixMethod(fix: HealthFix | null): ClientRequest["method"] | null {
  if (fix?.kind === "run") return fix.method as ClientRequest["method"];
  if (fix?.kind === "page" && fix.page === "lifeos-sign-in") return "work.lifeos.pairStart";
  if (fix?.kind === "page" && fix.page === "windows-vm-sign-in") return "work.office.vmSignIn";
  return null;
}

/**
 * The LifeOS sign-in dialog Settings → Work has always used, for this host, loaded on the press (`SignInFor`): the
 * page's own chunk no longer carries the whole of Work's settings for a dialog most visits never open.
 */
const LifeosSignIn = SignInFor;
