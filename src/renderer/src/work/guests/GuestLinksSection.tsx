import { useCallback, useEffect, useState } from "react";
import { errorText } from "../../chrome/ConfirmDialog";
import { PageEmpty, PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { reveal } from "../../components/ui/reveal";
import { loadToast } from "../../components/ui/toaster";
import { cn } from "../../lib/cn";
import { registry } from "../../lib/connection";
import { copyText } from "../../lib/clipboard";
import { clockTime } from "../../lib/duration";
import { Avatar } from "./Share";
import { guestsCall, isLive, ROLE_WORDS, shortDay, type GuestLinkRow } from "./api";

/**
 * Settings → Work, Guest links (prototype guest.html, "One list"; the audit
 * list): every link on every Work host, live ones first, who, to what, what
 * they can do, when it ends, when they last opened it, and Revoke. A link
 * that ended or was revoked stays a week, muted. The rows live on the host
 * that serves LifeOS's documents, so in practice one host answers; a host
 * that says another serves them is asked there, once. A host that does not
 * answer is its own red line with Retry, and the others' links stay. A
 * live row's Copy new address and Revoke show on hover.
 */
export function GuestLinksSection({ hosts }: { hosts: readonly string[] }) {
  const [rows, setRows] = useState<{ env: string; link: GuestLinkRow }[] | null>(null);
  // A host's read that failed, and a press that failed: each said once, apart from the rows that did come.
  const [failed, setFailed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const key = hosts.join(",");

  const load = useCallback(() => {
    void Promise.allSettled(
      key
        .split(",")
        .filter(Boolean)
        .map((env) => guestsCall<GuestLinkRow[]>(env, "work.guests.list", {}).then(({ env: there, value }) => value.map((link) => ({ env: there, link })))),
    ).then((all) => {
      const now = Date.now();
      // Two hosts sent to the one that serves the links read the same rows: each link once.
      const byId = new Map(all.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).map((row) => [row.link.id, row]));
      setRows([...byId.values()].sort((a, b) => Number(isLive(b.link, now)) - Number(isLive(a.link, now)) || b.link.createdAt - a.link.createdAt));
      setFailed([...new Set(all.flatMap((r) => (r.status === "rejected" ? [errorText(r.reason)] : [])))]);
      setError(null);
    });
  }, [key]);
  useEffect(load, [load]);
  // A link made or revoked anywhere: the host says so.
  useEffect(() => {
    const offs = key
      .split(",")
      .filter(Boolean)
      .map((env) => registry.linkOf(env).onPush((push) => push.push === "work.guests" && load()));
    return () => offs.forEach((off) => off());
  }, [key, load]);

  // The address is never kept: copying makes a new one, and the one before stops opening.
  const copyNew = async (env: string, id: string): Promise<void> => {
    setRevoking(`copy:${id}`);
    try {
      const { url } = await registry.linkOf(env).request<{ url: string }>("work.guests.rekey", { linkId: id });
      await copyText(url);
      const toast = await loadToast();
      toast.success("Copied a new address. The one before no longer opens.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRevoking(null);
    }
  };

  const revoke = async (env: string, id: string): Promise<void> => {
    setRevoking(id);
    try {
      await registry.linkOf(env).request("work.guests.revoke", { linkId: id });
      load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRevoking(null);
    }
  };

  return (
    <PageSection title="Guest links">
      {failed.map((why) => (
        <PageError
          key={why}
          action={
            <Button variant="ghost" size="sm" onClick={load}>
              Retry
            </Button>
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
          <PageRow key={link.id} media={<Avatar name={link.name} />} title={link.name} description={describe(link, live)} className={live ? undefined : "opacity-60"}>
            {live ? (
              <div data-guest-actions="" className={cn("flex shrink-0 items-center gap-1", revoking?.endsWith(link.id) ? "opacity-100" : reveal("item", { row: true }))}>
                <Button variant="ghost" size="sm" disabled={revoking !== null} onClick={() => void copyNew(env, link.id)}>
                  <BusyLabel busy={revoking === `copy:${link.id}`} label="Copy new address" />
                </Button>
                <Button variant="ghost" size="sm" disabled={revoking !== null} onClick={() => void revoke(env, link.id)}>
                  <BusyLabel busy={revoking === link.id} label="Revoke" />
                </Button>
              </div>
            ) : null}
          </PageRow>
        );
      })}
    </PageSection>
  );
}

/** "Can edit Spring LAN run of show until Dec 18, in it now": one line of facts. */
function describe(link: GuestLinkRow, live: boolean): string {
  const what = `${ROLE_WORDS[link.role]}, ${link.title}`;
  if (!live) return `${what}, ${link.revokedAt ? `revoked ${shortDay(link.revokedAt)}` : `ended ${shortDay(link.expiresAt)}`}`;
  const seen = link.open > 0 ? "in it now" : link.lastOpenedAt ? `opened ${shortDay(link.lastOpenedAt)} ${clockTime(link.lastOpenedAt)}` : "not opened yet";
  return `${what}, until ${shortDay(link.expiresAt)}, ${seen}`;
}
