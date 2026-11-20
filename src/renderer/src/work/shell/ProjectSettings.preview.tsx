import { Button } from "@renderer/components/ui/button";
import { ChoiceSelect } from "../../components/choice-select";
import { DialogFooter as Footer, ErrorLine } from "../../chrome/ConfirmDialog";
import { FieldRow } from "../../chrome/DialogField";
import type { GuestLinkRow } from "@shared/contract-work-guests";
import { LinkRows } from "../guests/Share";
import { WorkProjectFields, type LifeosReach, type ProjectState } from "./ProjectSettings";

/**
 * A Work project's settings sheet, still, for `bun run ui:preview
 * src/renderer/src/work/shell/ProjectSettings.preview.tsx#WorkProjectSheetPreview`:
 * the sheet's own box, head and foot around the real fields, since a sheet
 * draws in a portal a static page cannot hold. Rendered by nothing in the app.
 */

const noop = (): void => {};

const DAY = 86_400_000;
const guest = (id: string, name: string, days: number): GuestLinkRow => ({ id, name, source: { at: "lifeos", table: "projects", id: "kp1" }, title: "Spring LAN", role: "view", createdAt: 0, expiresAt: Date.UTC(2026, 10, 19) + days * DAY, revokedAt: null, by: "owner", lastOpenedAt: null, open: 0 });
/** The Sharing section's states: nobody, two guests, the read on its way. */
const GUESTS: Record<string, GuestLinkRow[] | null> = { none: [], two: [guest("a", "Dana Lee", 29), guest("b", "Marcus Reed", 6)], loading: null };

const REACH: Record<string, LifeosReach> = {
  ready: { status: "ready" },
  loading: { status: "loading" },
  signedOut: { status: "failed", line: "Sign in to LifeOS to change its name or state" },
  unreachable: { status: "failed", line: "LifeOS did not answer", retry: noop },
  gone: { status: "failed", line: "This project is no longer in LifeOS" },
  local: { status: "local" },
};

export function WorkProjectSheetPreview({
  reach = "ready",
  name = "Spring LAN",
  state = "active",
  rules = "86 words",
  accounts = true,
  error = null,
  dirty = false,
  pending = false,
  sharing = "none",
}: {
  reach?: keyof typeof REACH;
  name?: string;
  state?: ProjectState | null;
  rules?: string;
  accounts?: boolean;
  error?: string | null;
  dirty?: boolean;
  pending?: boolean;
  /** which Sharing state to draw; "off" for a project that mirrors nothing */
  sharing?: keyof typeof GUESTS | "off";
}) {
  const at = REACH[reach]!;
  return (
    <div className="flex w-[440px] flex-col overflow-hidden rounded-2xl bg-popover text-sm text-popover-foreground shadow-overlay ring-1 ring-border">
      <div className="flex flex-col gap-1 p-5 pe-12">
        <h2 className="text-base leading-6 font-semibold tracking-[-0.01em] text-foreground">Project settings</h2>
        <p className="min-w-0 truncate text-xs text-muted-foreground">Purdue Esports</p>
      </div>
      <WorkProjectFields
        name={name}
        onName={noop}
        state={state}
        onState={noop}
        reach={at}
        rules={rules}
        onEditRules={noop}
        sharing={
          sharing === "off" ? null : (
            <div className="-mx-2">
              <LinkRows rows={GUESTS[sharing]!} project layout="section" onRevoke={noop} onRetry={noop} onNew={noop} />
            </div>
          )
        }
        accounts={
          accounts ? (
            <div className="flex flex-col">
              <FieldRow label="Claude">
                <ChoiceSelect label="Claude" size="sm" value="" options={[{ value: "", label: "Inherit (auto)" }]} onChange={noop} />
              </FieldRow>
              <FieldRow label="Codex">
                <ChoiceSelect label="Codex" size="sm" value="work" options={[{ value: "work", label: "work@purdue.edu" }]} onChange={noop} />
              </FieldRow>
            </div>
          ) : null
        }
      />
      {error ? (
        <div className="flex items-start gap-3 px-5 py-3">
          <div className="min-w-0 flex-1">
            <ErrorLine error={error} />
          </div>
          <Button type="button" variant="link" size="xs" className="h-auto shrink-0 px-0 text-xs">
            Retry
          </Button>
        </div>
      ) : null}
      <Footer
        start={
          at.status === "ready" ? (
            <Button type="button" variant="ghost" disabled={pending}>
              Delete project
            </Button>
          ) : null
        }
        onCancel={noop}
        confirmLabel="Save"
        pending={pending}
        disabled={!dirty}
      />
    </div>
  );
}
