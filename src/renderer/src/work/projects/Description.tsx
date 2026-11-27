import { useMemo, useState } from "react";
import type { DocOpen } from "@shared/contract-work-docs";
import type { CanvasSource } from "@shared/work";
import { DOCUMENT_LADDER, DocumentEditor, EditorAdaptersProvider, EditorKitProvider } from "work-kit/editor";
import { BusyLabel, Button } from "../../components/ui/button";
import { Region } from "../../components/bones";
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
  // His Retry keeps the reason in place, its Retry spinning, until the document answers or fails again.
  const [press, setPress] = useState<{ error: string; seen: boolean } | null>(null);
  if (press && !press.seen && got === null) setPress({ ...press, seen: true });
  else if (press?.seen && got !== null) setPress(null);
  const opened = got && "open" in got ? got : null;
  const error = opened ? null : got && "error" in got ? got.error : (press?.error ?? null);
  const waiting = !opened && error === null;
  // One read, the document's. The lead holds the text's place until it answers; with none yet, two lines from a sample.
  return (
    <Region loading={waiting && !lead} label="Loading the description" bones={DescriptionBones}>
      {opened ? (
        <Editor key={opened.open.doc} host={opened.host} open={opened.open} readOnly={readOnly} />
      ) : error !== null ? (
        <div data-description-lead className="flex flex-col gap-1">
          {lead ? <p className="text-[13px] leading-5 whitespace-pre-wrap text-foreground">{lead}</p> : null}
          <p className="flex items-baseline gap-2 text-xs text-muted-foreground">
            <span className="min-w-0">{error}</span>
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto shrink-0 px-0 text-xs"
              disabled={press !== null}
              onClick={() => {
                setPress({ error, seen: false });
                setAttempt((n) => n + 1);
              }}
            >
              <BusyLabel busy={press !== null} label="Retry" />
            </Button>
          </p>
        </div>
      ) : (
        <p aria-busy className="text-[13px] leading-5 whitespace-pre-wrap text-foreground">
          {lead}
        </p>
      )}
    </Region>
  );
}

/** A description's first lines while it opens, in the lead's type. */
const SAMPLE_DESCRIPTION = ["Two days of open play and the bracket finals in the arena,", "with the varsity team running the stage."] as const;

function DescriptionBones() {
  return (
    <div className="flex flex-col text-[13px] leading-5">
      {SAMPLE_DESCRIPTION.map((line) => (
        <p key={line}>{line}</p>
      ))}
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
