import { Button } from "@renderer/components/ui/button";
import { ChoiceSelect } from "../../components/choice-select";
import { DialogFooter as Footer, ErrorLine } from "../../chrome/ConfirmDialog";
import { FieldRow } from "../../chrome/DialogField";
import { Share as ShareGlyph } from "../icons";
import { WorkProjectFields, type LifeosReach, type ProjectState } from "./ProjectSettings";

/**
 * A Work project's settings sheet, still, for `bun run ui:preview
 * src/renderer/src/work/shell/ProjectSettings.preview.tsx#WorkProjectSheetPreview`:
 * the sheet's own box, head and foot around the real fields, since a sheet
 * draws in a portal a static page cannot hold. Rendered by nothing in the app.
 */

const noop = (): void => {};

const REACH: Record<string, LifeosReach> = {
  ready: { status: "ready" },
  loading: { status: "loading" },
  connecting: { status: "loading", waits: "LifeOS is still connecting on the box" },
  retrying: { status: "failed", line: "LifeOS did not answer the box", press: { label: "Retry", run: noop }, busy: true },
  signedOut: { status: "failed", line: "Not signed in to LifeOS", press: { label: "Sign in", run: noop } },
  unreachable: { status: "failed", line: "LifeOS did not answer", press: { label: "Retry", run: noop } },
  withheld: { status: "failed", line: "This computer cannot read LifeOS through the box" },
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
  sharing = true,
  target = "2027-03-14",
  setup = false,
}: {
  reach?: keyof typeof REACH;
  name?: string;
  state?: ProjectState | null;
  rules?: string;
  accounts?: boolean;
  error?: string | null;
  dirty?: boolean;
  pending?: boolean;
  /** false for a project that mirrors nothing */
  sharing?: boolean;
  /** "YYYY-MM-DD", or "" for no target */
  target?: string;
  /** Thread setup drawn open */
  setup?: boolean;
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
        target={target}
        onTarget={noop}
        setupOpen={setup}
        onSetupOpen={noop}
        reach={at}
        rules={rules}
        onEditRules={noop}
        sharing={
          sharing ? (
            <Button type="button" variant="ghost" size="sm">
              <ShareGlyph />
              Share
            </Button>
          ) : null
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
            <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" disabled={pending}>
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
