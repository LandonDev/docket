import { useMemo, useState } from "react";
import type { DocOpen } from "@shared/contract-work-docs";
import type { CanvasSource } from "@shared/work";
import { DOCUMENT_LADDER, DocumentEditor, EditorAdaptersProvider, EditorKitProvider } from "work-kit/editor";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { useColorScheme } from "../../hooks/useColorScheme";
import { useDocument, useOpened } from "../docs/DocumentCanvas";
import type { DocHost } from "../docs/host";

/**
 * A project's description: its LifeOS document in the shared block editor,
 * live through the Work service as any document is (docs/agents/work-docs.md).
 * While the service cannot be reached it is the stored lead, read-only, with
 * the reason and Retry under it. The project page folds it to one line and
 * opens it in place; it has no title of its own (the project's name is the
 * page's).
 */
export function Description({ env, docId, readOnly, lead }: { env: string; docId: string; readOnly: boolean; lead: string }) {
  const source = useMemo((): CanvasSource => ({ at: "lifeos", table: "docs", id: docId }), [docId]);
  const [attempt, setAttempt] = useState(0);
  const got = useOpened(env, source, attempt);
  if (got && "open" in got) return <Editor key={got.open.doc} host={got.host} open={got.open} readOnly={readOnly} />;
  if (got && "error" in got)
    return (
      <div data-description-lead className="flex flex-col gap-1">
        {lead ? <p className="text-[13px] leading-5 whitespace-pre-wrap text-foreground">{lead}</p> : null}
        <p className="flex items-baseline gap-2 text-xs text-muted-foreground">
          <span className="min-w-0">{got.error}</span>
          <Button type="button" variant="link" size="xs" className="h-auto shrink-0 px-0 text-xs" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </Button>
        </p>
      </div>
    );
  // The lead holds the text's place until the document answers; with none yet, two lines of bones.
  return lead ? (
    <p aria-busy className="text-[13px] leading-5 whitespace-pre-wrap text-foreground">
      {lead}
    </p>
  ) : (
    <div aria-busy className="flex flex-col gap-2 py-1">
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

function Editor({ host, open, readOnly }: { host: DocHost; open: DocOpen; readOnly: boolean }) {
  const doc = useDocument(host, open);
  const scheme = useColorScheme();
  return (
    <EditorKitProvider value={{ theme: scheme, ladder: DOCUMENT_LADDER }}>
      <EditorAdaptersProvider adapters={doc.adapters}>
        <DocumentEditor documentName={open.doc} editable={!readOnly && open.role === "edit"} review={null} />
      </EditorAdaptersProvider>
    </EditorKitProvider>
  );
}
