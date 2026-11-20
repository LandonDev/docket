import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { RichText } from "work-kit/editor";
import { createGuestProjectsClient, Projects, ProjectsClientProvider, ProjectsKitProvider, type GuestProjection, type ProjectsKit, type ProjectsPlace } from "work-kit/projects";
import "work-kit/projects/styles.css";
import "@renderer/work/projects/projects.css";
import { initials, OpenFailed, type ChildItem, type Opened, type Session } from "./session";

/**
 * A project on the hosted page (docs/agents/work-guests.md "A project's
 * link"): the shared project screens (work-kit/projects) on the read-only
 * client, which says no to every right, so no control is drawn and nothing
 * writes. What it shows is the link's projection, asked for again every 15
 * seconds and when the window comes forward: the name, the state, the
 * meter, the description, the tabs, the tree or the board, a task's peek
 * and page, and Documents. A document or sheet opens in place, read only
 * (`onOpen`); nothing here reaches another project, a thread or a comment.
 * A document is its text as it stands, never its live room, so the guest is
 * shown no deleted words, no comment's place and nobody's caret.
 */

/** What the kit's parts read of the page around them; the kit itself never changes. */
const PageContext = createContext<{ session: Session; slot: HTMLElement | null; at: ProjectsPlace["at"]; read: number } | null>(null);
const usePage = () => {
  const page = useContext(PageContext);
  if (!page) throw new Error("The guest's project page is not mounted");
  return page;
};

/**
 * The screens' bar in the page's one 44px line: List or Board at its end.
 * The way back is drawn only from a task's own page; a project's page has
 * none, since the guest has no list of projects to go back to.
 */
function Bar({ crumb, children }: { crumb: ReactNode | null; children: ReactNode }) {
  const { slot, at } = usePage();
  if (!slot) return null;
  return createPortal(
    <>
      <span className="flex min-w-0 items-center">{at === "task" ? crumb : null}</span>
      <span className="flex shrink-0 items-center gap-1">{children}</span>
    </>,
    slot,
  );
}

/** The description: its document's text as it stands, asked for with the project's own reads; the stored lead until it comes, and when it cannot. */
function Description({ docId, lead }: { docId: string; lead: string }) {
  const { session, read } = usePage();
  const child = useMemo(() => session.child({ table: "docs", id: docId }), [session, docId]);
  const [markdown, setMarkdown] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    child.refresh().then(
      (got) => live && setMarkdown(got.markdown ?? null),
      () => live && setMarkdown(null),
    );
    return () => {
      live = false;
    };
    // `read` counts the project's reads: the description is read again with each.
  }, [child, read]);
  return markdown === null ? <p className="whitespace-pre-wrap">{lead}</p> : <RichText body={markdown} format="markdown" />;
}

/** A project's document in place: the document page's own measure and title, with its text as it stands where the live editor would be. */
export function DocText({ id, title, markdown }: { id: string; title: string; markdown: string }) {
  return (
    <article data-guest-doc={id} className="mx-auto w-full max-w-[736px] px-4 pt-6 pb-10 sm:px-8">
      <h1 className="mb-4 text-lg leading-[26px] font-semibold tracking-[-0.01em] text-balance">{title}</h1>
      <div className="[--link:var(--accent)]">
        <RichText body={markdown} format="markdown" />
      </div>
    </article>
  );
}

const kit: ProjectsKit = {
  SectorMark: () => null,
  Face: ({ name, size, className }) => (
    <span aria-hidden className={`inline-grid shrink-0 place-items-center rounded-full bg-muted font-semibold text-muted-foreground ${size === 16 ? "size-4 text-[7px]" : "size-5 text-[8px]"} ${className ?? ""}`}>
      {initials(name)}
    </span>
  ),
  // A page in a browser names no keys of the app.
  Hint: ({ children }) => children,
  toast: () => {},
  keyCaps: (chord) => chord.split("+"),
  Document: Description,
  openItem: () => {},
  Bar,
  verbs: { primary: "ghost", size: "sm" },
};

export function ProjectPage({
  session,
  opened,
  slot,
  hidden,
  onOpen,
  onShown,
  onGone,
}: {
  session: Session;
  opened: Opened;
  /** the page line's place for the screens' controls */
  slot: HTMLElement | null;
  /** a document or sheet is open over it: kept mounted, so the place and the reads stay */
  hidden: boolean;
  onOpen(item: ChildItem & { title: string }): void;
  /** told each time the service answers what the project shows now */
  onShown?(projection: GuestProjection): void;
  onGone(): void;
}) {
  const projectId = opened.projection!.project.id;
  const client = useMemo(() => {
    // The open that drew the page already holds the first read.
    let first: GuestProjection | undefined = opened.projection as GuestProjection;
    return createGuestProjectsClient({
      fetch: async () => {
        if (first) {
          const got = first;
          first = undefined;
          return got;
        }
        try {
          const now = await session.refresh();
          if (!now.projection) throw new OpenFailed("gone");
          onShown?.(now.projection as GuestProjection);
          setRead((n) => n + 1);
          return now.projection as GuestProjection;
        } catch (err) {
          // A link revoked or ended answers "gone": the page says so. Anything else keeps what was shown.
          if (err instanceof OpenFailed && err.why === "gone") onGone();
          throw err;
        }
      },
    });
    // One client for the page's life: the screens call its hooks in a fixed order.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);
  const [read, setRead] = useState(0);
  const [place, setPlace] = useState<ProjectsPlace>({ at: "project", id: projectId, layout: "list", tab: "all" });
  // The guest stands in this project: a way to the list of projects, or to a new one, goes nowhere.
  const onPlace = (next: ProjectsPlace): void => {
    if ((next.at === "project" && next.id === projectId) || next.at === "task") setPlace(next);
  };
  const guestKit = useMemo<ProjectsKit>(() => ({ ...kit, openItem: (item) => (item.kind === "doc" || item.kind === "sheet") && onOpen({ table: item.kind === "doc" ? "docs" : "sheets", id: item.id, title: item.title }) }), [onOpen]);
  const page = useMemo(() => ({ session, slot, at: place.at, read }), [session, slot, place.at, read]);
  return (
    <div hidden={hidden} className="tc-projects h-full min-h-0" data-guest-project>
      <PageContext.Provider value={page}>
        <ProjectsKitProvider kit={guestKit}>
          <ProjectsClientProvider client={client}>
            <Projects sector="life" place={place} onPlace={onPlace} />
          </ProjectsClientProvider>
        </ProjectsKitProvider>
      </PageContext.Provider>
    </div>
  );
}
