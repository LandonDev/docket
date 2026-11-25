import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ClientRequest } from "@shared/contract";
import type { HealthFix, HealthReport } from "@shared/work/health";
import { lapseLine } from "@shared/work/health";
import { syncWhen } from "@shared/work/messages";
import { PageActions, PageRow, PageSection } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { StatusMark } from "../../components/ui/status";
import { registry, useEnvironments, useEnvironmentStatuses } from "../../lib/connection";
import { hostFailure } from "../../lib/hostFailure";
import { nameInLine } from "../../lib/hostWords";
import { managedElsewhere, signInElsewhere, useLinkMay } from "../../lib/linkMay";
import { requestSettings } from "../../lib/monaco/debugTab";
import { openUrl } from "../../lib/native";
import { workErrorWords } from "../../lib/workErrorWords";
import { useWorkHosts } from "../../lib/workSwitch";
import { AddinRow } from "../office/AddinRow";
import { SignInFor } from "../shell/DownSignIn";
import { useLifeosStatusHeard } from "../shell/lifeos";
import { signInOnVm } from "../winvm/signIn";
import { FirstCheckBones } from "./FirstCheckBones";
import { checkFailure, fixVariant, markOf, sectionsOf, unchecked, usableFix, type HostView, type PlacedRow } from "./model";

/**
 * Settings → Connections (docs/agents/work-connections.md): every sign-in
 * and helper Work leans on, per host, as working, broken or needs you, with
 * the fix beside each. The checks run when the page opens, on Check again
 * and when a host's LifeOS state changes, never on a timer; a host this
 * window is not linked to now is offline, not broken.
 */

/** A host's checks can take each pillar's 10 s at once, then the trip: past this the host is said not to answer. */
const CHECK_DEADLINE_MS = 25_000;

export function ConnectionsPage() {
  const environments = useEnvironments();
  const statuses = useEnvironmentStatuses();
  const on = useWorkHosts();
  const hosts = environments.filter((e) => on.has(e.id));
  const [views, setViews] = useState<Record<string, HostView>>({});

  const checkHost = useCallback(async (id: string, name: string): Promise<void> => {
    // A host whose check failed keeps its Hosts row while it is asked again: its Retry spins in place.
    setViews((all) => ({ ...all, [id]: { id, name, status: "checking", report: viewReport(all[id]), ...(wasSilent(all[id]) ? { silent: true } : {}), ...failedOf(all[id]) } }));
    let next: HostView;
    try {
      const report = await withDeadline(registry.linkOf(id).request<HealthReport>("work.health", {}), CHECK_DEADLINE_MS);
      next = { id, name, status: "ready", report };
    } catch (err) {
      const { error, silent } = checkFailure(workErrorWords(err, { host: nameInLine(name) }));
      next = { id, name, status: "failed", error, silent };
    }
    setViews((all) => ({ ...all, [id]: next.status === "failed" ? { ...next, report: viewReport(all[id]) } : next }));
  }, []);

  const linked = (id: string): boolean => statuses.get(id)?.transport === "open";
  // Check again spins only for a round it began (the page's first, or its own press): a Hosts row's Retry spins itself.
  const [round, setRound] = useState(true);
  const checkAll = (): void => {
    setRound(true);
    for (const host of hosts) if (linked(host.id)) void checkHost(host.id, host.name);
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

  const shown: HostView[] = hosts.map((h) => (linked(h.id) ? (views[h.id] ?? { id: h.id, name: h.name, status: "checking" }) : { id: h.id, name: h.name, status: "offline" }));
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
      <ConnectionsView hosts={shown} onRecheck={(id) => void checkHost(id, hosts.find((h) => h.id === id)?.name ?? id)} />
      {hosts.map((host) => (linked(host.id) ? <LifeosWatch key={host.id} environmentId={host.id} onChange={() => void checkHost(host.id, host.name)} /> : null))}
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
    const timer = window.setTimeout(() => reject(new Error("The host did not answer")), ms);
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
export function ConnectionsView({ hosts, onRecheck, now = Date.now() }: { hosts: readonly HostView[]; onRecheck: (hostId: string) => void; now?: number }) {
  const sections = sectionsOf(hosts);
  const away = unchecked(hosts);
  const waiting = hosts.filter((h) => h.status === "checking" && !h.report);
  const checking = new Set(hosts.filter((h) => h.status === "checking").map((h) => h.id));
  return (
    <>
      {away.length ? (
        <PageSection title="Hosts">
          {away.map((host) =>
            host.status === "offline" ? (
              <PageRow key={host.id} title={host.name} description={<StatusMark state="stopped" word="Offline" detail="Checked when it is back" />} />
            ) : (
              <PageRow key={host.id} title={host.name} description={<StatusMark className={STATE_LINE} state="failed" word={"silent" in host && host.silent ? "Did not answer" : "Not checked"} detail={host.status === "failed" ? host.error : host.status === "checking" ? host.failed?.error : undefined} />}>
                {/* The row's own press, at the LifeOS rows' weight; it spins while its check runs, and a new cause replaces the reason. */}
                <Button data-host-retry variant={fixVariant("broken")} size="sm" disabled={host.status === "checking"} onClick={() => onRecheck(host.id)}>
                  <BusyLabel busy={host.status === "checking"} label="Retry" />
                </Button>
              </PageRow>
            ),
          )}
        </PageSection>
      ) : null}
      {sections.map((section) => (
        <PageSection key={section.group} title={section.titled ? section.group : undefined} aria-label={section.titled ? undefined : section.group}>
          {section.rows.map((placed) => (
            <ConnectionRow key={placed.key} placed={placed} now={now} checking={checking.has(placed.hostId)} onDone={() => onRecheck(placed.hostId)} />
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
function ConnectionRow({ placed, now, checking, onDone }: { placed: PlacedRow; now: number; checking: boolean; onDone: () => void }) {
  const own = OWN_ROWS[placed.row.id];
  if (own) return <>{own(placed.hostId, placed.title)}</>;
  return <FixRow placed={placed} now={now} checking={checking} onDone={onDone} />;
}

/** `checking`: the row's host is being asked again; `onDone` asks it again, that host alone. */
function FixRow({ placed, now, checking, onDone }: { placed: PlacedRow; now: number; checking: boolean; onDone: () => void }) {
  const { row, hostId } = placed;
  const mark = markOf(row.state);
  const usable = usableFix(row.fix, registry.primary().environmentId === hostId);
  // A fix this window's key may not run on that host (LifeOS's sign-in and sign-out on a given computer) is not drawn;
  // on a row that needs him, a line says who can, by the act (`signInElsewhere` for LifeOS's sign-in), as every reader does.
  const fix = useLinkMay(hostId, fixMethod(usable) ?? "work.health") ? usable : null;
  const hostName = registry.environment(hostId)?.name ?? "this host";
  const whoCan = usable && !fix && row.state === "needs-you" ? (usable.kind === "page" && usable.page === "lifeos-sign-in" ? signInElsewhere(hostName) : managedElsewhere(hostName)) : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  // LifeOS's silence: Retry asks the row's host again, that host alone, as Check again would, beside the row's account
  // control (the sign-in row's Sign out), which stays as it is. A row its silent host left (`hushed`) has none.
  const retry = !placed.hushed && row.lifeos === "unreachable";
  const line = placed.line ?? row.line;
  const press = async (fix: HealthFix): Promise<void> => {
    setError(null);
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
        {row.until ? <span className="text-xs tabular-nums text-muted-foreground">{lapseLine(row.until, now)}</span> : null}
        {retry ? (
          <Button variant={fixVariant(row.state)} size="sm" disabled={checking} onClick={onDone}>
            <BusyLabel busy={checking} label="Retry" />
          </Button>
        ) : null}
        {fix ? (
          <Button variant={fixVariant(row.state)} size="sm" disabled={busy} onClick={() => void press(fix)}>
            <BusyLabel busy={busy} label={fix.label} />
          </Button>
        ) : null}
      </PageRow>
      {signingIn ? <LifeosSignIn environmentId={hostId} onClose={() => (setSigningIn(false), onDone())} /> : null}
    </>
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
