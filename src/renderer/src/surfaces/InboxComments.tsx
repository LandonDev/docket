import { keyHint, modOrCtrl } from "../lib/keys";
import { openUrl } from "../lib/native";
import { Avatar } from "../components/ui/avatar";
import { BusyLabel, Button } from "../components/ui/button";
import { Tip } from "../components/tip";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { X } from "../chrome/icons";
import { Spinner } from "../components/ui/spinner";
import { Textarea } from "../components/ui/textarea";
import {
  formatRelativeTime,
  githubReviewStateLabel,
  inboxPersonAvatarUrl,
  type InboxProvider,
} from "../lib/githubTasks";
import { AgentMarkdown } from "./AgentMarkdown";
import { FailLine } from "./FailLine";
import { Facts } from "./settings/hosts/Facts";

export type InboxReplyTarget = {
  id: string;
  author: string;
  threadId: string;
};

type InboxComment = {
  id: string;
  kind: string;
  author: string;
  authorAvatarUrl?: string;
  body: string;
  createdAt: string;
  url: string;
  state: string;
  path: string;
  line: number | null;
  resolved: boolean;
  threadId?: string;
  replies: InboxComment[];
};

type InboxThread = {
  comments: InboxComment[];
  truncated: boolean;
};

type Props = {
  thread: InboxThread | null;
  loading: boolean;
  error: string | null;
  cwd: string;
  provider: InboxProvider;
  replyMode?: "thread" | "parent";
  onReply?: (target: InboxReplyTarget) => void;
};

export function InboxComments({
  thread,
  loading,
  error,
  cwd,
  provider,
  replyMode,
  onReply,
}: Props) {
  if (thread && thread.comments.length === 0 && !thread.truncated) {
    if (loading) return <CommentsPending />;
    return null;
  }
  if (!thread) {
    if (error) return <FailLine words="Couldn't load the comments" detail={error} />;
    if (loading) return <CommentsPending />;
    return null;
  }

  const count = thread.comments.reduce(
    (total, comment) => total + 1 + comment.replies.length,
    0,
  );
  const label = count === 1 ? "1 comment" : `${count} comments`;
  const moreOn = provider === "linear" ? "Linear" : "GitHub";

  return (
    <section className="flex flex-col gap-2 border-t border-border pt-6">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <h2 className="font-medium">{label}</h2>
        {thread.truncated ? <span>Latest shown, more on {moreOn}</span> : null}
        {loading ? <Spinner aria-label="Loading comments" className="size-3" /> : null}
      </div>
      {error ? <FailLine words="Couldn't load the comments" detail={error} /> : null}
      <ol className="flex flex-col gap-2">
        {thread.comments.map((comment) => (
          <li key={comment.id}>
            <InboxComment
              comment={comment}
              cwd={cwd}
              provider={provider}
              replyMode={replyMode}
              onReply={onReply}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

export function InboxCommentForm({
  replyTo,
  posting,
  error,
  onCancelReply,
  onSubmit,
}: {
  replyTo: InboxReplyTarget | null;
  posting: boolean;
  error: string | null;
  onCancelReply: () => void;
  onSubmit: (body: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const canPost = draft.trim().length > 0 && !posting;

  useEffect(() => {
    if (!replyTo) return;
    field.current?.focus();
  }, [replyTo]);

  const submit = async () => {
    const body = draft.trim();
    if (!body || posting) return;
    try {
      await onSubmit(body);
      setDraft("");
    } catch {
      // Parent keeps the error next to the button.
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || !modOrCtrl(event)) return;
    event.preventDefault();
    void submit();
  };

  const onFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };

  return (
    <form
      onSubmit={onFormSubmit}
      className="flex flex-col gap-2 border-t border-border pt-6"
    >
      {replyTo ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">
            Replying to {replyTo.author || "comment"}
          </span>
          <Tip label="Cancel reply">
            <Button variant="ghost" size="icon-xs" aria-label="Cancel reply" onClick={onCancelReply} className="shrink-0 text-muted-foreground">
              <X className="size-3" />
            </Button>
          </Tip>
        </div>
      ) : null}
      <Textarea
        ref={field}
        rows={2}
        value={draft}
        disabled={posting}
        aria-label={replyTo ? "Reply" : "Comment"}
        placeholder={
          replyTo ? `Write a reply (${keyHint("mod+return")})` : `Leave a comment (${keyHint("mod+return")})`
        }
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        className="max-h-40 resize-none overflow-x-hidden overflow-y-auto px-3 leading-5 text-foreground"
      />
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 pt-1">
          {error ? <FailLine words="Couldn't post the comment" detail={error} /> : null}
        </div>
        <Button type="submit" size="sm" variant="secondary" disabled={!canPost}>
          <BusyLabel busy={posting} label={replyTo ? "Reply" : "Comment"} busyLabel="Posting…" />
        </Button>
      </div>
    </form>
  );
}

function CommentsPending() {
  return (
    <div
      role="status"
      aria-busy
      className="flex items-center gap-2 border-t border-border pt-6 text-xs text-muted-foreground"
    >
      <Spinner aria-hidden className="size-3.5" />
      Loading comments
    </div>
  );
}

function InboxComment({
  comment,
  cwd,
  provider,
  nested = false,
  replyMode,
  onReply,
}: {
  comment: InboxComment;
  cwd: string;
  provider: InboxProvider;
  nested?: boolean;
  replyMode?: "thread" | "parent";
  onReply?: (target: InboxReplyTarget) => void;
}) {
  const time = formatRelativeTime(comment.createdAt);
  const review = githubReviewStateLabel(comment.state);
  const location = commentLocation(comment);
  const reviewTone =
    comment.state === "APPROVED" ? "text-success" : comment.state === "CHANGES_REQUESTED" ? "text-destructive" : "";
  const hasBody = comment.body.trim().length > 0;
  const hasReplies = !nested && comment.replies.length > 0;
  const canReply =
    onReply != null &&
    (replyMode === "parent" ||
      (replyMode === "thread" && (comment.threadId ?? "").trim().length > 0));

  const inner = (
    <>
      <header
        className={`flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 text-xs text-muted-foreground ${
          nested ? "" : "px-3 py-2"
        } ${!nested && (hasBody || hasReplies) ? "border-b border-border" : ""}`}
      >
        <InboxCommentPerson
          name={comment.author || "ghost"}
          avatarUrl={inboxPersonAvatarUrl(
            provider,
            comment.author,
            comment.authorAvatarUrl,
          )}
        />
        {/* Review state, place, Resolved and time: one comma run, never facts set apart by space alone. */}
        <Facts
          className="[&>span]:min-w-0 [&>span]:max-w-full [&>span]:truncate"
          parts={[
            review ? <span className={reviewTone}>{review}</span> : null,
            location,
            comment.resolved ? <span className="text-success">Resolved</span> : null,
            time && comment.url ? (
              <Tip label={provider === "linear" ? "Open in Linear" : "Open on GitHub"}>
                {/* A 24px target over the 16px line, as every link in a line of facts. */}
                <Button variant="link" size="xs" onClick={() => void openUrl(comment.url)} className="relative h-auto p-0 text-[length:inherit] font-normal tabular-nums text-inherit after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']">
                  {time}
                </Button>
              </Tip>
            ) : (
              time
            ),
          ]}
        />
        {canReply ? (
          <Button
            variant="link"
            size="xs"
            onClick={() =>
              onReply({
                id: comment.id,
                author: comment.author || "ghost",
                threadId: (comment.threadId ?? "").trim(),
              })
            }
            className="relative ms-1 h-auto shrink-0 p-0 text-[length:inherit] font-normal text-inherit after:absolute after:inset-x-0 after:-inset-y-1 after:content-[''] hover:text-foreground hover:no-underline"
          >
            Reply
          </Button>
        ) : null}
      </header>
      {hasBody ? (
        <div className={nested ? "mt-2" : "px-3 py-2.5"}>
          <AgentMarkdown
            className="inbox-comment-md"
            text={comment.body}
            cwd={cwd}
          />
        </div>
      ) : null}
      {hasReplies ? (
        <div className="border-t border-border px-3">
          {comment.replies.map((reply, index) => (
            <div
              key={reply.id}
              className={`py-2.5 ${
                index > 0 ? "border-t border-border" : ""
              }`}
            >
              <InboxComment
                comment={reply}
                cwd={cwd}
                provider={provider}
                nested
                replyMode={replyMode}
                onReply={onReply}
              />
            </div>
          ))}
        </div>
      ) : null}
    </>
  );

  if (nested) return <article>{inner}</article>;
  return (
    <article className="overflow-hidden rounded-lg border border-border bg-card">
      {inner}
    </article>
  );
}

function commentLocation(comment: InboxComment): string {
  const path = comment.path.trim();
  if (!path) return "";
  if (comment.line && comment.line > 0) return `${path}:${comment.line}`;
  return path;
}

function InboxCommentPerson({
  name,
  avatarUrl,
}: {
  name: string;
  avatarUrl: string;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Avatar name={name} src={avatarUrl} size={20} />
      <span className="min-w-0 truncate font-medium text-foreground">{name}</span>
    </span>
  );
}
