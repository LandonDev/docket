import { useCallback, useEffect, useState } from "react";
import { PageEmpty, PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { reveal } from "../../components/ui/reveal";
import { cn } from "../../lib/cn";
import { registry } from "../../lib/connection";
import { hostFailure } from "../../lib/hostFailure";
import { Face } from "../mail/face";
import { confirmReplace, confirmRevoke, MadeLinkDialog } from "./Share";
import { guestsCall, isLive, linkFacts, type GuestLinkRow } from "./api";

/**
 * Settings → Work, Guest links (prototype guest.html, "One list"; the audit
 * list): every link on every Work host, live ones first, who, to what, what
 * they can do, when it ends, when they last opened it, and Revoke. A link
 * that ended or was revoked stays a week, muted. The rows live on the host
 * that serves LifeOS's documents, so in practice one host answers; a host
 * that says another serves them is asked there, once. A host that does not
 * answer is its own red line with Retry, and the others' links stay. A
 * live row's Replace address… (asked first: the old address stops opening;
 * the new one shows once, to copy) and Revoke… (asked first, never undone)
 * show on hover. Each row's facts are `linkFacts`, as the Share sheet's.
 */
export function GuestLinksSection({ hosts }: { hosts: readonly string[] }) {
  const [rows, setRows] = useState<{ env: string; link: GuestLinkRow }[] | null>(null);
  // A host's read that failed, and a press that failed: each said once, apart from the rows that did come.
  const [failed, setFailed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ url: string; link: GuestLinkRow } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const key = hosts.join(",");

  const load = useCallback((): Promise<void> => {
    const envs = key.split(",").filter(Boolean);
    return Promise.allSettled(
      envs.map((env) => guestsCall<GuestLinkRow[]>(env, "work.guests.list", {}).then(({ env: there, value }) => value.map((link) => ({ env: there, link })))),
    ).then((all) => {
      const now = Date.now();
      // Two hosts sent to the one that serves the links read the same rows: each link once.
      const byId = new Map(all.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).map((row) => [row.link.id, row]));
      setRows([...byId.values()].sort((a, b) => Number(isLive(b.link, now)) - Number(isLive(a.link, now)) || b.link.createdAt - a.link.createdAt));
      setFailed([...new Set(all.flatMap((r, i) => (r.status === "rejected" ? [hostFailure(envs[i], r.reason, "could not list its guest links")] : [])))]);
      setError(null);
    });
  }, [key]);
  useEffect(() => void load(), [load]);
  // A failed host's Retry spins while the hosts are asked again, and takes no second press meanwhile.
  const [retrying, setRetrying] = useState(false);
  const retry = (): void => {
    if (retrying) return;
    setRetrying(true);
    void load().finally(() => setRetrying(false));
  };
  // A link made or revoked anywhere: the host says so.
  useEffect(() => {
    const offs = key
      .split(",")
      .filter(Boolean)
      .map((env) => registry.linkOf(env).onPush((push) => push.push === "work.guests" && load()));
    return () => offs.forEach((off) => off());
  }, [key, load]);

  // The address is never kept: a new one is made and shown once to copy, and the one before stops opening, so he is asked first.
  const replace = async (env: string, link: GuestLinkRow): Promise<void> => {
    if (!(await confirmReplace(link.name))) return;
    setRevoking(`copy:${link.id}`);
    try {
      const { url } = await registry.linkOf(env).request<{ url: string }>("work.guests.rekey", { linkId: link.id });
      setMade({ url, link });
    } catch (err) {
      setError(hostFailure(env, err, "did not replace the address", true));
    } finally {
      setRevoking(null);
    }
  };

  // Asked first, with no Undo after: a revoked address must never open again (decision 21).
  const revoke = async (env: string, link: GuestLinkRow): Promise<void> => {
    if (!(await confirmRevoke(link.name))) return;
    setRevoking(link.id);
    try {
      await registry.linkOf(env).request("work.guests.revoke", { linkId: link.id });
      void load();
    } catch (err) {
      setError(hostFailure(env, err, "did not revoke the link", true));
    } finally {
      setRevoking(null);
    }
  };

  return (
    <PageSection title="Guest links">
      {/* One line per host that did not answer, and one Retry for them all: each would run the same read of every host. */}
      {failed.map((why, i) => (
        <PageError
          key={why}
          action={
            i === failed.length - 1 ? (
              <Button variant="ghost" size="sm" disabled={retrying} onClick={retry}>
                <BusyLabel busy={retrying} label="Retry" />
              </Button>
            ) : undefined
          }
        >
          {why}
        </PageError>
      ))}
      {error ? <PageError>{error}</PageError> : null}
      {rows === null ? <PageRowsSkeleton rows={2} description control="button" media /> : null}
      {rows?.length === 0 && failed.length === 0 ? <PageEmpty>No guest links</PageEmpty> : null}
      {rows?.map(({ env, link }) => {
        const live = isLive(link);
        return (
          <PageRow key={link.id} media={<Face name={link.name} size="row" />} title={link.name} description={linkFacts(link, { item: true })} className={cn("relative", live ? undefined : "opacity-60")}>
            {live ? (
              // The presses lie over the row's end on hover and keep no room at rest, so the facts take the row's width.
              <div
                data-guest-actions=""
                className={cn("absolute end-0 top-1/2 flex -translate-y-1/2 items-center gap-1 bg-background ps-2", revoking?.endsWith(link.id) ? "opacity-100" : reveal("item", { row: true, overlay: true }))}
              >
                <Button variant="ghost" size="sm" disabled={revoking !== null} onClick={() => void replace(env, link)}>
                  <BusyLabel busy={revoking === `copy:${link.id}`} label="Replace address…" />
                </Button>
                <Button variant="ghost" size="sm" disabled={revoking !== null} onClick={() => void revoke(env, link)}>
                  <BusyLabel busy={revoking === link.id} label="Revoke…" />
                </Button>
              </div>
            ) : null}
          </PageRow>
        );
      })}
      {made ? <MadeLinkDialog url={made.url} link={made.link} title={made.link.title} onClose={() => setMade(null)} /> : null}
    </PageSection>
  );
}
