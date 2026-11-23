import type { ReactNode } from "react";
import type { Template } from "@shared/work/templates";
import { Layers, X } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { registry, type Link } from "../../lib/connection";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { FieldsForm } from "./FieldsForm";
import { SaveForm } from "./SaveDialog";
import { TemplateSteps } from "./TemplateDialog";
import type { WorkViewProps } from "../views/registry";
import { Head, View } from "./TemplatesView";

/**
 * The Templates pillar's screens over one fixed host, for `bun run ui:preview
 * src/renderer/src/work/templates/Templates.preview.tsx#<Export> --props '{"width":560}'`:
 * the view under the frame's 40px header (`state`: shelf, loading, empty,
 * error), New from a template, a template's fields (`state`: rest, pending,
 * error) and Save as template. A dialog draws in a portal a static page cannot
 * hold, so each is drawn in the Modal's own box (chrome/Modal.tsx) around its
 * real body. `width` sets the box the screen stands in. Rendered by nothing in
 * the app.
 */

const tpl = (id: string, name: string, kind: Template["kind"], fields: string[] = []): Template => ({
  id,
  name,
  kind,
  form: kind === "sheet" ? "xlsx" : kind === "deck" ? "pptx" : "docx",
  where: id.startsWith("job:") ? "job" : id.startsWith("all:") ? "all" : "starter",
  fields,
  source: { at: "file", host: "local", path: `/w/Templates/${name}` },
});

const SHELF: Template[] = [
  tpl("job:Crew memo.docx", "Crew memo", "document"),
  tpl("job:Mileage log.xlsx", "Mileage log", "sheet"),
  tpl("starter:ref/game-report", "Game report", "document", ["Home", "Away", "Site"]),
  tpl("starter:ref/incident-report", "Incident report", "document", ["Home", "Away"]),
  tpl("starter:ref/season-log", "Season log", "sheet"),
  tpl("all:Weekly agenda.docx", "Weekly agenda", "document"),
  tpl("all:Season review deck with a long name.pptx", "Season review deck with a long name", "deck"),
  tpl("starter:any/meeting-notes", "Meeting notes", "document", ["Meeting"]),
];

type ViewState = "shelf" | "loading" | "empty" | "error";
let viewState: ViewState = "shelf";

const link = {
  environmentId: "local",
  profile: "local",
  connected: true,
  onOpen: () => () => {},
  onClose: () => () => {},
  onPush: () => () => {},
  request<T>(method: string): Promise<T> {
    if (method !== "work.templates.list") return Promise.reject(new Error(`no ${method}`));
    if (viewState === "loading") return new Promise(() => {});
    if (viewState === "error") return Promise.reject(new Error("refused: the box did not answer"));
    return Promise.resolve({ templates: viewState === "empty" ? [] : SHELF, hidden: viewState === "shelf" ? 0 : 3 } as T);
  },
} as unknown as Link;
Object.assign(registry, { primary: () => link, linkOf: () => link, link: () => link });

const WORKSPACE = { id: "ws", environmentId: "local", name: "Dummy Esports", path: "/w/Dummy Esports", kind: "work", sector: "ref", git: false, createdAt: 0 };
const catalog = { ...workspaceStore.getSnapshot(), workspaces: [WORKSPACE] };
Object.assign(workspaceStore, { getSnapshot: () => catalog });

const props = { env: "local", workspace: WORKSPACE, sector: "ref", lifeos: {}, startThread: () => {} } as unknown as WorkViewProps;
const noop = (): void => {};

/** The box a screen stands in: the page's width, or `width`. */
const Box = ({ width, children }: { width?: number; children: ReactNode }) => <div style={width ? { width } : undefined}>{children}</div>;

export function TemplatesViewPreview({ state = "shelf", width }: { state?: ViewState; width?: number }) {
  viewState = state;
  return (
    <Box width={width}>
      <div className="flex min-h-[480px] flex-col bg-background">
        {/* The view frame's 40px header (work/shell/WorkViewPage.tsx). */}
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4 text-[13px]">
          <Layers className="size-3.5 text-muted-foreground" />
          <span className="font-medium text-foreground">Templates</span>
          <span className="flex-1" />
          <Head {...props} />
        </div>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          <View {...props} />
        </div>
      </div>
    </Box>
  );
}

/** The Modal's panel (chrome/Modal.tsx ModalPanel at `size`), around a dialog's real body. */
function ModalBox({ title, size, children }: { title: string; size: "sm" | "md"; children: ReactNode }) {
  return (
    <div className="grid place-items-center bg-background p-8">
      <div className={`flex w-full flex-col overflow-hidden rounded-2xl bg-popover text-sm leading-[22px] text-popover-foreground shadow-overlay ring-1 ring-border ${size === "md" ? "max-w-xl" : "max-w-md"}`}>
        <header className="flex shrink-0 items-start gap-2 px-5 pt-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-base leading-6 font-semibold tracking-[-0.01em] text-balance">{title}</h2>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Close" className="-me-1 -mt-0.5 text-muted-foreground">
            <X />
          </Button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
}

export function TemplateDialogPreview({ width, kept = false }: { width?: number; kept?: boolean }) {
  viewState = "shelf";
  return (
    <Box width={width}>
      <ModalBox title="New from a template" size="md">
        <TemplateSteps
          env="local"
          workspaceId="ws"
          {...(kept ? { into: { at: "file" as const, host: "local", path: "/w/Dummy Esports/Game reports" } } : {})}
          chosen={null}
          fromTiles
          making={null}
          setMaking={noop}
          choose={noop}
          onClose={noop}
        />
      </ModalBox>
    </Box>
  );
}

export function FieldsPreview({ width, state = "rest" }: { width?: number; state?: "rest" | "pending" | "error" }) {
  const report = SHELF[2]!;
  return (
    <Box width={width}>
      <ModalBox title={report.name} size="md">
        <FieldsForm
          template={report}
          pending={state === "pending"}
          error={state === "error" ? "The workspace's folder is gone" : null}
          onBack={noop}
          onCancel={noop}
          onCreate={noop}
        />
      </ModalBox>
    </Box>
  );
}

export function SavePreview({ width, fields = true }: { width?: number; fields?: boolean }) {
  return (
    <Box width={width}>
      <ModalBox title="Save as template" size="sm">
        <SaveForm
          env="local"
          workspaceId="ws"
          source={{ at: "file", host: "local", path: "/w/Dummy Esports/Game report - North.docx" }}
          name="Game report"
          {...(fields ? { fields: ["Home", "Away", "Site"] } : {})}
          onClose={noop}
          pending={false}
          setPending={noop}
        />
      </ModalBox>
    </Box>
  );
}
