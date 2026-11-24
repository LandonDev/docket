/**
 * Whether a row is Work's, read from the row and never from the Work switch
 * (docs/agents/work.md "Code branches on a row"). Every surface that hides a
 * code part (a branch, a diff, a repo's tree, a build) for Work asks here, so
 * the rule lives in one place. Plain data, no imports: first paint may read it.
 */

/** A Work thread: stamped `scope: 'work'` at create, a Work Chat included. */
export const isWorkThread = (row: { scope?: string | null } | null | undefined): boolean => row?.scope === "work";

/** A Work workspace: a job, never a code repository, wherever its folder sits. */
export const isWorkWorkspace = (row: { kind?: string | null } | null | undefined): boolean => row?.kind === "work";
