import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { HealthFix, HealthReport } from "@shared/work/health";
import { lapseLine } from "@shared/work/health";
import { errorText } from "../../chrome/ConfirmDialog";
import { PageActions, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { StatusMark } from "../../components/ui/status";
import { registry, useEnvironments, useEnvironmentStatuses } from "../../lib/connection";
import { requestSettings } from "../../lib/monaco/debugTab";
import { openUrl } from "../../lib/native";
import { useWorkHosts } from "../../lib/workSwitch";
import { AddinRow } from "../office/AddinRow";
import { SignInDialog } from "../shell/settings";
import { useLifeosStatus } from "../shell/lifeos";
import { fixVariant, markOf, sectionsOf, unchecked, usableFix, type HostView, type PlacedRow } from "./model";

/**
 * Settings → Connections (docs/agents/work-connections.md): every sign-in
 * and helper Work leans on, per host, as working, broken or needs you, with
 * the fix beside each. The checks run when the page opens and on Check
 * again, never on a timer; a host this window is not linked to now is
 * offline, not broken.
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
    setViews((all) => ({ ...all, [id]: { id, name, status: "checking", report: viewReport(all[id]) } }));
    let next: HostView;
    try {
      const report = await withDeadline(registry.linkOf(id).request<HealthReport>("work.health", {}), CHECK_DEADLINE_MS);
      next = { id, name, status: "ready", report };
    } catch (err) {
      next = { id, name, status: "failed", error: errorText(err) };
    }
    setViews((all) => ({ ...all, [id]: next.status === "failed" ? { ...next, report: viewReport(all[id]) } : next }));
  }, []);

  const linked = (id: string): boolean => statuses.get(id)?.transport === "open";
  const checkAll = (): void => {
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
  return (
    <>
      <PageActions>
        <Button variant="ghost" size="sm" disabled={checking} onClick={checkAll}>
          <BusyLabel busy={checking} label="Check again" />
        </Button>
      </PageActions>
      <ConnectionsView hosts={shown} onRecheck={(id) => void checkHost(id, hosts.find((h) => h.id === id)?.name ?? id)} />
    </>
  );
}

const viewReport = (view: HostView | undefined): HealthReport | undefined => (view && "report" in view ? view.report : undefined);

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("The host did not answer")), ms);
    promise.then(
      (value) => (window.clearTimeout(timer), resolve(value)),
      (err: unknown) => (window.clearTimeout(timer), reject(err)),
    );
  });
}

/** The page as the hosts' answers leave it: what the preview and the test draw. */
export function ConnectionsView({ hosts, onRecheck, now = Date.now() }: { hosts: readonly HostView[]; onRecheck: (hostId: string) => void; now?: number }) {
  const sections = sectionsOf(hosts);
  const away = unchecked(hosts);
  const waiting = hosts.filter((h) => h.status === "checking" && !h.report);
  return (
    <>
      {away.length ? (
        <PageSection title="Hosts">
          {away.map((host) =>
            host.status === "offline" ? (
              <PageRow key={host.id} title={host.name} description={<StatusMark state="stopped" word="Offline" detail="Checked when it is back" />} />
            ) : (
              <PageRow key={host.id} title={host.name} description={<StatusMark state="failed" word="Did not answer" detail={host.status === "failed" ? host.error : undefined} />}>
                <Button variant="ghost" size="sm" onClick={() => onRecheck(host.id)}>
                  Retry
                </Button>
              </PageRow>
            ),
          )}
        </PageSection>
      ) : null}
      {sections.map((section) => (
        <PageSection key={section.group} title={section.group}>
          {section.rows.map((placed) => (
            <ConnectionRow key={placed.key} placed={placed} now={now} onDone={() => onRecheck(placed.hostId)} />
          ))}
        </PageSection>
      ))}
      {waiting.length && !sections.length ? (
        <PageSection>
          <PageRowsSkeleton rows={6} description control="button" />
        </PageSection>
      ) : null}
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
function ConnectionRow({ placed, now, onDone }: { placed: PlacedRow; now: number; onDone: () => void }) {
  const own = OWN_ROWS[placed.row.id];
  if (own) return <>{own(placed.hostId, placed.title)}</>;
  return <FixRow placed={placed} now={now} onDone={onDone} />;
}

function FixRow({ placed, now, onDone }: { placed: PlacedRow; now: number; onDone: () => void }) {
  const { row, hostId } = placed;
  const mark = markOf(row.state);
  const fix = usableFix(row.fix);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const press = async (fix: HealthFix): Promise<void> => {
    setError(null);
    if (fix.kind === "open") return void openUrl(fix.url).catch((err: unknown) => setError(errorText(err)));
    if (fix.kind === "page") {
      if (fix.page === "lifeos-sign-in") return setSigningIn(true);
      if (fix.page.startsWith("settings:")) return requestSettings(fix.page.slice("settings:".length) as never);
      return;
    }
    setBusy(true);
    try {
      await registry.linkOf(hostId).request(fix.method, fix.params ?? {});
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageRow title={placed.title} description={<StatusMark state={mark.state} word={mark.word} detail={row.line} />} error={error ?? undefined}>
        {row.until ? <span className="text-xs tabular-nums text-muted-foreground">{lapseLine(row.until, now)}</span> : null}
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

/** The LifeOS sign-in dialog Settings → Work has always used, for this host. */
function LifeosSignIn({ environmentId, onClose }: { environmentId: string; onClose: () => void }) {
  const status = useLifeosStatus(environmentId);
  if (!status) return null;
  return <SignInDialog environmentId={environmentId} state={status.lifeos} onClose={onClose} />;
}
