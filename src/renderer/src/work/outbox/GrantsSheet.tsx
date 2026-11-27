import { useState } from "react";
import { Region } from "../../components/bones";
import { BusyLabel, Button } from "../../components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import { loadToast } from "../../components/ui/toaster";
import { useLinksMay } from "../../lib/linkMay";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { byWorkspace, grantLine } from "./model";
import { removeGrant, type HostGrant } from "./store";
import { pressFailWords } from "./failWords";
import { SAMPLE_GRANTS } from "./samples";

/**
 * The standing grants, by workspace (docs/DESIGN.md "Settings for Work", a
 * grant row): its name, where and when it was made, and Remove with no
 * confirm (drawn only where this window's key may forget it). A grant is made only from a held item (its Send menu, or the offer
 * under a sent item that earned one); here it can only go. Where the groups mix jobs, each heading's dot hangs in the
 * sheet's inset; groups sit 16px apart.
 */
export function GrantsSheet({
  open,
  onOpenChange,
  grants,
  read,
  nameOf,
  sectorOf,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  grants: HostGrant[];
  /** every host's grants have answered: until then an empty list is bones, never "No grants" */
  read: boolean;
  nameOf: (environmentId: string, workspaceId: string | null) => string;
  sectorOf: (environmentId: string, workspaceId: string | null) => string | null;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const may = useLinksMay();
  const groups = byWorkspace(grants.map((g) => ({ ...g, sector: sectorOf(g.environmentId, g.workspaceId) })));
  // The dot only where jobs mix (DESIGN.md "Colour"): one job's list needs none.
  const mixed = new Set(groups.map((g) => g.sector)).size > 1;
  const remove = async (grant: HostGrant) => {
    setBusy(grant.id);
    try {
      await removeGrant(grant);
    } catch (err) {
      void loadToast().then((t) => t.error(pressFailWords(err, "The grant was not removed")));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Grants</SheetTitle>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-5 pb-5">
          {/* Bones only while every host's grants are out: an empty list before then is not known to be none. */}
          <Region loading={groups.length === 0 && !read} label="Loading the grants" bones={GrantBones}>
            {groups.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">No grants. Everything waits for your press.</p>
            ) : (
              <GrantGroups groups={groups} mixed={mixed} nameOf={nameOf} removable={(g) => may(g.environmentId, "work.outbox.ungrant")} busy={busy} onRemove={(g) => void remove(g)} />
            )}
          </Region>
        </div>
      </SheetContent>
    </Sheet>
  );
}

type Group = ReturnType<typeof byWorkspace<HostGrant & { sector: string | null }>>[number];

/** The grants by workspace: a heading, then each grant's name and record, with Remove where this key may forget it. */
function GrantGroups({ groups, mixed, nameOf, removable, busy, onRemove }: {
  groups: Group[];
  mixed: boolean;
  nameOf: (environmentId: string, workspaceId: string | null) => string;
  removable: (grant: HostGrant) => boolean;
  busy: string | null;
  onRemove: (grant: HostGrant) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => {
        const name = nameOf(group.items[0]!.environmentId, group.workspaceId);
        return (
          <section key={group.key} aria-label={name} className="flex flex-col">
            {/* The dot hangs in the sheet's inset, so the name starts on its rows' edge. */}
            <div className="flex h-7 items-center gap-1 text-xs font-medium text-muted-foreground">
              {mixed ? <SectorDot sector={group.sector} className="-ms-5 size-4" /> : null}
              <span className="min-w-0 truncate">{name}</span>
            </div>
            <ul className="flex flex-col">
              {group.items.map((grant) => (
                <li key={grant.id} className="flex min-h-12 items-center gap-3 border-t border-border py-2 first:border-t-0">
                  <span className="flex min-w-0 flex-1 flex-col">
                    {/* The grant's name is what it lets go unasked: read whole, never cut. */}
                    <span className="break-words text-[13px] leading-5">{grant.label}</span>
                    {/* The record wraps, never cut: a narrow sheet reads its whole line. */}
                    <span className="break-words text-xs leading-4 text-muted-foreground">{grantLine(grant.kind, grant.createdAt)}</span>
                  </span>
                  {removable(grant) ? (
                    <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive" disabled={busy !== null} onClick={() => onRemove(grant)}>
                      <BusyLabel busy={busy === grant.id} label="Remove" />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** While the grants are read: one job's two grants from the sample, with no Remove (the sample has no rights). */
function GrantBones() {
  return <GrantGroups groups={byWorkspace(SAMPLE_GRANTS.map((g) => ({ ...g, sector: null })))} mixed={false} nameOf={() => "Purdue Esports"} removable={() => false} busy={null} onRemove={() => undefined} />;
}
