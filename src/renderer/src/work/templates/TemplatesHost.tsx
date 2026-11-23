import { useEffect, useState } from "react";
import type { CanvasSource } from "@shared/work/canvas";
import type { FolderRef } from "@shared/work/files";
import type { Template } from "@shared/work/templates";
import { defineChunk } from "../../lib/lazyChunk";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { workTemplatePort } from "../../lib/workSwitch";

const dialogs = defineChunk("work-templates", () => import("./TemplatesDialogs"));
const TemplateDialog = dialogs.surface("TemplateDialog");
const SaveDialog = dialogs.surface("SaveDialog");

type Ask =
  | { kind: "open"; env: string; workspaceId: string; into?: FolderRef; intoName?: string; template?: Template }
  | { kind: "save"; env: string; workspaceId: string; source: CanvasSource; name?: string; fields?: readonly string[] };

const envOf = (workspaceId: string): string | null => workspaceStore.getSnapshot().workspaces.find((w) => w.id === workspaceId)?.environmentId ?? null;

/**
 * Fills `workTemplatePort` while Work's shell is up (docs/agents/work-templates.md):
 * "New from a template" and "Save as template", each a dialog from the
 * `work-templates` chunk, on the workspace's own host. One at a time; a second
 * ask takes the first one's place.
 */
export function TemplatesHost() {
  const [ask, setAsk] = useState<Ask | null>(null);
  useEffect(() => {
    workTemplatePort.set({
      open: (a) => {
        const env = envOf(a.workspaceId);
        if (env) setAsk({ kind: "open", env, workspaceId: a.workspaceId, into: a.into as FolderRef | undefined, intoName: a.intoName, template: a.template as Template | undefined });
      },
      save: (a) => {
        const env = envOf(a.workspaceId);
        if (env) setAsk({ kind: "save", env, workspaceId: a.workspaceId, source: a.source as CanvasSource, name: a.name, fields: a.fields });
      },
    });
    return () => workTemplatePort.set(null);
  }, []);
  if (!ask) return null;
  const close = () => setAsk(null);
  return ask.kind === "open" ? (
    <TemplateDialog
      key={`${ask.workspaceId} ${ask.template?.id ?? ""} ${JSON.stringify(ask.into ?? null)}`}
      env={ask.env}
      workspaceId={ask.workspaceId}
      into={ask.into}
      intoName={ask.intoName}
      template={ask.template}
      onClose={close}
    />
  ) : (
    <SaveDialog key={`${ask.workspaceId} ${JSON.stringify(ask.source)}`} env={ask.env} workspaceId={ask.workspaceId} source={ask.source} name={ask.name} fields={ask.fields} onClose={close} />
  );
}
