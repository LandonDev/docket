import { useCallback, useEffect, useState } from "react";
import { PageEmpty, PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { registry } from "../../lib/connection";
import { hostFailure } from "../../lib/hostFailure";
import { Face } from "../mail/face";
import { confirmReplace, confirmRevoke, MadeLinkDialog } from "./Share";
import { guestsCall, isLive, linkFacts, shortDay, type GuestLinkRow } from "./api";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import { NO_ANSWER } from "../../lib/connection/openRead";
import { ReadFailure } from "../../surfaces/settings/parts/ReadFailure";
import { MoreHorizontal } from "../../chrome/icons";
import { RowsMenu, type MenuRow } from "../../chrome/menuRows";
import { ListFilter, useListFilter } from "../../surfaces/settings/parts/ListFilter";
import { SettingRow } from "../../surfaces/settings/parts/SettingRow";

/**
 * Settings → Files, Shared with guests (prototype guest.html, "One list"; the audit list): one open row that says
 * how many links are live and when the next ends, opening a sheet of every link on every Work computer, live ones
 * first: who, to what, what they can do, when it ends, when they last opened it. A link that ended or was revoked
 * stays a week, muted. The rows live on the computer that serves LifeOS's documents, so in practice one answers; one
 * that says another serves them is asked there, once. One that does not answer is its own red line with Retry, and
 * the others' links stay. A live row's Replace address… (asked first: the old address stops opening; the new one
 * shows once, to copy) and Revoke… (asked first, never undone) show on hover. Each row's facts are `linkFacts`, as
 * the Share sheet's. Past eight links a find field narrows them.
 */
export function GuestLinksRow({ hosts, open: startOpen = false }: { hosts: readonly string[]; /** The sheet open from the first paint: the preview's seam. */ open?: boolean }) {
  const guests = useGuestLinks(hosts);
  const [open, setOpen] = useState(startOpen);
  return (
    <>
      {/* A computer that did not answer leaves the count unsaid: its line stands under the row, never "None". */}
      <SettingRow
        id="files.guests"
        description={guests.rows && guests.failed.length === 0 ? guestsWords(guests.rows.map((r) => r.link)) : undefined}
        // Nothing read: the row holds its name, with no way into a sheet that could show nothing.
        onOpen={guests.rows?.length || !guests.failedOn.length ? () => setOpen(true) : undefined}
        openLabel="Shared with guests"
      />
      {/* Each computer that did not give its links, named once on the page, its Retry asking again. */}
      {guests.failedOn.map((f) => (
        <ReadFailure key={f.env} computer={f.env} error={f.error} retry={guests.load} />
      ))}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" data-guests-sheet="">
          <SheetHeader>
            <SheetTitle>Shared with guests</SheetTitle>
          </SheetHeader>
          <div className="@container/page flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-5 pb-5">
            <GuestLinksList guests={guests} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

/** "3 links. The next ends Dec 2", or "None": the live links, by what the row needs. */
export function guestsWords(links: readonly GuestLinkRow[], now = Date.now()): string {
  const live = links.filter((l) => isLive(l, now));
  if (live.length === 0) return "None";
  const next = Math.min(...live.map((l) => l.expiresAt));
  return `${live.length === 1 ? "1 link" : `${live.length} links`}. The next ends ${shortDay(next)}`;
}

/** The list alone, as the sheet holds it; the old section's name, for its tests and previews. */
export function GuestLinksSection({ hosts }: { hosts: readonly string[] }) {
  return (
    <PageSection>
      <GuestLinksList guests={useGuestLinks(hosts)} />
    </PageSection>
  );
}

type GuestLinks = ReturnType<typeof useGuestLinks>;

const LINK_MENU: MenuRow[] = [{ kind: "item", id: "replace", label: "Replace address…" }, { kind: "sep" }, { kind: "item", id: "revoke", label: "Revoke…", danger: true }];

function useGuestLinks(computers: readonly string[]) {
  const [rows, setRows] = useState<{ env: string; link: GuestLinkRow }[] | null>(null);
  // A host's read that failed, and a press that failed: each said once, apart from the rows that did come.
  const [failed, setFailed] = useState<string[]>([]);
  // The same failures by computer, for the page's own line (`ReadFailure`): a silence as the read's own words.
  const [failedOn, setFailedOn] = useState<{ env: string; error: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ url: string; link: GuestLinkRow } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const key = computers.join(",");

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
      setFailedOn(
        all.flatMap((r, i) => {
          if (r.status !== "rejected") return [];
          const words = hostFailure(envs[i]!, r.reason, "could not list its guest links");
          return [{ env: envs[i]!, error: /did not answer/.test(words) ? NO_ANSWER : words }];
        }),
      );
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

  return { rows, failed, failedOn, error, setError, retrying, retry, load, made, setMade, revoking, setRevoking };
}

const linkWords = (row: { link: GuestLinkRow }): string => `${row.link.name} ${row.link.title}`;
const NO_ROWS: { env: string; link: GuestLinkRow }[] = [];

function GuestLinksList({ guests }: { guests: GuestLinks }) {
  const { rows, failed, error, setError, retrying, retry, load, made, setMade, revoking, setRevoking } = guests;
  const filter = useListFilter(rows ?? NO_ROWS, linkWords);
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
    <>
      <ListFilter filter={filter} label="Find a link" />
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
      {filter.shown.map(({ env, link }) => {
        const live = isLive(link);
        return (
          <PageRow key={link.id} data-guest-link={link.id} media={<Face name={link.name} size="row" />} title={link.name} description={linkFacts(link, { item: true })}>
            {live ? (
              // Both acts ask first and sit in the row's menu, there at rest, never on hover alone.
              <RowsMenu
                label={`${link.name}'s link`}
                trigger={
                  <Button data-guest-actions="" variant="ghost" size="icon-sm" aria-label={`${link.name}'s link`} disabled={revoking !== null} className="text-muted-foreground">
                    {revoking?.endsWith(link.id) ? <BusyLabel busy label="" /> : <MoreHorizontal />}
                  </Button>
                }
                rows={LINK_MENU}
                onPick={(id) => void (id === "replace" ? replace(env, link) : revoke(env, link))}
                align="end"
              />
            ) : null}
          </PageRow>
        );
      })}
      {made ? <MadeLinkDialog url={made.url} link={made.link} title={made.link.title} onClose={() => setMade(null)} /> : null}
    </>
  );
}
