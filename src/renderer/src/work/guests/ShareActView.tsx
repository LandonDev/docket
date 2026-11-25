import type { GuestLinkAct } from "@shared/contract-work-guests";
import type { ActViewProps } from "../acts/registry";
import { Doc, Project, Table } from "../icons";
import { guestTableOf } from "@shared/work/guestRoles";
import { dayOf, folderNameOf, ROLE_WORDS } from "./api";

/**
 * A held `share.guestLink` in the Outbox (prototype guest.html, "An agent
 * asks"): the link an agent asked for, its three facts and the item (a
 * document, a sheet or a whole project, each by its glyph), exactly as
 * Create link will make it. The address is shown to the thread that
 * asked, once, after his press.
 */
export function View({ item }: ActViewProps) {
  const p = item.payload as GuestLinkAct;
  const table = guestTableOf(p.source);
  const Glyph = table === "projects" ? Project : table === "sheets" ? Table : Doc;
  const folder = folderNameOf(p.source);
  const rows: [string, React.ReactNode][] = [
    [
      "To",
      <span key="to" className="inline-flex min-w-0 items-center gap-1.5">
        <Glyph className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{p.title}</span>
        {/* A file is named with its folder, by the folder's name alone: his press shares that file and no other of the same name, and no path is shown. */}
        {folder ? <span className="shrink-0 text-muted-foreground">in {folder}</span> : null}
      </span>,
    ],
    ["For", p.name],
    ["Can", ROLE_WORDS[p.role]],
    ["Ends", dayOf(p.expiresAt)],
  ];
  return (
    <dl data-slot="act-payload" className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] leading-5">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="truncate text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
