import { useState } from "react";
import { BusyLabel, Button } from "../../components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import { loadToast } from "../../components/ui/toaster";
import { byWorkspace, grantLine } from "./model";
import { removeGrant, type HostGrant } from "./store";

/**
 * The standing grants, by workspace (docs/DESIGN.md "Settings for Work", a
 * grant row): its name, where and when it was made, and Remove with no
 * confirm. A grant is made only from a held item's Send menu; here it can
 * only go.
 */
export function GrantsSheet({
  open,
  onOpenChange,
  grants,
  nameOf,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  grants: HostGrant[];
  nameOf: (environmentId: string, workspaceId: string | null) => string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const groups = byWorkspace(grants.map((g) => ({ ...g, sector: null as string | null })));
  const remove = async (grant: HostGrant) => {
    setBusy(grant.id);
    try {
      await removeGrant(grant);
    } catch (err) {
      void loadToast().then((t) => t.error(err instanceof Error ? err.message : String(err)));
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
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-x-hidden overflow-y-auto px-5 pb-5">
          {groups.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No grants. Every act waits for your press.</p>
          ) : (
            groups.map((group) => {
              const name = nameOf(group.items[0]!.environmentId, group.workspaceId);
              return (
                <section key={group.key} aria-label={name} className="flex flex-col">
                  <div className="flex h-7 items-center text-xs font-medium text-muted-foreground">{name}</div>
                  <ul className="flex flex-col">
                    {group.items.map((grant) => (
                      <li key={grant.id} className="flex min-h-12 items-center gap-3 border-t border-border py-2 first:border-t-0">
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-[13px] leading-5">{grant.label}</span>
                          <span className="truncate text-xs leading-4 text-muted-foreground">{grantLine(grant.kind, grant.createdAt)}</span>
                        </span>
                        <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive" disabled={busy !== null} onClick={() => void remove(grant)}>
                          <BusyLabel busy={busy === grant.id} label="Remove" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
