import { useCallback, useEffect, useState } from "react";
import { confirmAction } from "../../chrome/ConfirmDialog";
import { PageEmpty, PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { reveal } from "../../components/ui/reveal";
import { loadToast } from "../../components/ui/toaster";
import { cn } from "../../lib/cn";
import { registry } from "../../lib/connection";
import { hostFailure } from "../../lib/hostFailure";
import { copyText } from "../../lib/clipboard";
import { clockTime } from "../../lib/duration";
import { Face } from "../mail/face";
import { MadeLinkDialog } from "./Share";
import { guestsCall, isLive, ROLE_WORDS, shortDay, type GuestLinkRow } from "./api";

/**
 * Settings → Work, Guest links (prototype guest.html, "One list"; the audit
 * list): every link on every Work host, live ones first, who, to what, what
 * they can do, when it ends, when they last opened it, and Revoke. A link
 * that ended or was revoked stays a week, muted. The rows live on the host
 * that serves LifeOS's documents, so in practice one host answers; a host
 * that says another serves them is asked there, once. A host that does not
 * answer is its own red line with Retry, and the others' links stay. A
 * live row's Replace address… (asked first: the old address stops opening)
 * and Revoke show on hover.
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

  // The address is never kept: a new one is made and copied, and the one before stops opening, so he is asked first.
  const replace = async (env: string, id: string, name: string): Promise<void> => {
    const ok = await confirmAction({
      title: "Replace the address?",
      body: `${name}'s current address stops opening. The new one is copied for you to send.`,
      action: "Replace",
      danger: true,
    });
    if (!ok) return;
    setRevoking(`copy:${id}`);
    try {
      const { url } = await registry.linkOf(env).request<{ url: string }>("work.guests.rekey", { linkId: id });
      const row = rows?.find((r) => r.link.id === id)?.link;
      try {
        await copyText(url);
      } catch {
        // The old address no longer opens: the new one must not go with a failed copy. It shows, once, to select.
        if (row) setMade({ url, link: row });
        return;
      }
      const toast = await loadToast();
      toast.success("Copied the new address");
    } catch (err) {
      setError(hostFailure(env, err, "did not replace the address", true));
    } finally {
      setRevoking(null);
    }
  };

  const revoke = async (env: string, id: string): Promise<void> => {
    setRevoking(id);
    try {
      await registry.linkOf(env).request("work.guests.revoke", { linkId: id });
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
          <PageRow key={link.id} media={<Face name={link.name} size="row" />} title={link.name} description={describe(link, live)} className={cn("relative", live ? undefined : "opacity-60")}>
            {live ? (
              // The presses lie over the row's end on hover and keep no room at rest, so the facts take the row's width.
              <div
                data-guest-actions=""
                className={cn("absolute end-0 top-1/2 flex -translate-y-1/2 items-center gap-1 bg-background ps-2", revoking?.endsWith(link.id) ? "opacity-100" : reveal("item", { row: true, overlay: true }))}
              >
                <Button variant="ghost" size="sm" disabled={revoking !== null} onClick={() => void replace(env, link.id, link.name)}>
                  <BusyLabel busy={revoking === `copy:${link.id}`} label="Replace address…" />
                </Button>
                <Button variant="ghost" size="sm" disabled={revoking !== null} onClick={() => void revoke(env, link.id)}>
                  <BusyLabel busy={revoking === link.id} label="Revoke" />
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

/** "Can edit Spring LAN run of show until Dec 18, in it now": one line of facts. */
function describe(link: GuestLinkRow, live: boolean): string {
  // A project's link is named as one, so its name is not taken for a document's.
  // A file is named with the folder it is in, by the folder's name alone: two files of one name are told apart, and no path is shown.
  const folder = link.source.at === "file" ? link.source.path.replace(/[\\/][^\\/]*$/, "").split(/[\\/]/).pop() : undefined;
  const what = `${ROLE_WORDS[link.role]}, ${link.source.table === "projects" ? `${link.title} project` : folder ? `${link.title} in ${folder}` : link.title}`;
  if (!live) return `${what}, ${link.revokedAt ? `revoked ${shortDay(link.revokedAt)}` : `ended ${shortDay(link.expiresAt)}`}`;
  const seen = link.open > 0 ? "in it now" : link.lastOpenedAt ? `opened ${shortDay(link.lastOpenedAt)} ${clockTime(link.lastOpenedAt)}` : "not opened yet";
  return `${what}, until ${shortDay(link.expiresAt)}, ${seen}`;
}
