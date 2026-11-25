// @vitest-environment jsdom
/**
 * Files' LifeOS place while the host's LifeOS is down (docs/agents/work-files.md "LifeOS, From mail and Projects"):
 * the page says the session's state in the body's place by the host's live status, with the computer named and the
 * rule's one press, offers no New, and lists the folder again once the host says connected. Council round 10, Opus
 * Files 1.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LifeosStatus } from "@shared/contract-work-lifeos";
import type { FilePage } from "@shared/contract-work-files";
import type { FilePlace } from "@shared/work/files";

vi.mock("../../lib/connection", async (original) => {
  const linkOf = (id: string) => ({
    environmentId: id,
    connected: true,
    request: async () => ({ lifeos: { state: "signed-out" }, keys: [] }),
    onPush: () => () => undefined,
    onOpen: () => () => undefined,
    onClose: () => () => undefined,
  });
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf, link: linkOf, has: () => true, environment: (id: string) => ({ id, name: "The box", platform: "linux" }), environments: () => [], onLink: () => () => undefined } };
});
// The sign-in dialog the press opens in place (its own chunk, DownSignIn.tsx).
vi.mock("../shell/settings", () => ({ SignInDialog: () => <div role="dialog" aria-label="Sign in to LifeOS" /> }));

const { PageView } = await import("./Page");
const { resetFilesStore, lifeosMoved } = await import("./store");
const { lifeosSaved } = await import("./lifeosPlace");
const { resetLifeos, setLifeosStatus, setLifeosUnanswered } = await import("../shell/lifeos");

const ROOT = { at: "place", id: "lifeos" } as const;
const place = (state: FilePlace["state"]): FilePlace => ({ id: "lifeos", kind: "lifeos", name: "LifeOS", host: "", env: "box", shared: false, can: ["make", "rename", "move", "edit"], state, root: ROOT, makes: ["document", "sheet"] });
const copyOf = (state: FilePlace["state"]) => ({ place: place(state), link: "box", host: "The box", wire: "files" as const });
const PAGE: FilePage = { at: ROOT, name: "LifeOS" };
const st = (state: string): LifeosStatus => ({ lifeos: { state, ...(state === "pairing" ? { expiresAt: Date.now() + 60_000 } : {}) }, keys: [] }) as unknown as LifeosStatus;
type Listed = NonNullable<Parameters<typeof PageView>[0]["listing"]>;
const failed = (retry = vi.fn()): Listed => ({ entries: [], trail: [], loaded: true, more: false, loading: false, error: "Not signed in to LifeOS on the box. Sign in under Settings, Connections.", away: false, loadMore: () => undefined, retry });

function draw(listed: Listed, copy = copyOf({ state: "signed-out", detail: "LifeOS is not signed in on this host.", lifeos: "pairing" })) {
  const acts = { place: copy.place, from: copy, tabs: true, make: vi.fn(), rename: vi.fn(), carry: vi.fn(), trash: vi.fn(), star: vi.fn(), openTab: vi.fn(), ask: vi.fn(), pickUpload: vi.fn(), upload: vi.fn(), drop: vi.fn(), share: vi.fn() };
  return render(
    <PageView
      page={PAGE}
      panelId="p1"
      listing={listed}
      copy={copy}
      acts={acts as never}
      trail={[{ name: "LifeOS", at: ROOT }]}
      canBack={false}
      canForward={false}
      busy={null}
      fixes={{ busy: false, run: () => undefined }}
      onBack={() => undefined}
      onForward={() => undefined}
      onGo={() => undefined}
      onOpen={() => undefined}
    />,
  );
}

beforeEach(() => {
  localStorage.clear();
  resetFilesStore();
});
afterEach(() => {
  cleanup();
  resetLifeos();
});

describe("Files' LifeOS place while LifeOS is down", () => {
  it("says the host's live state in the body's place with its press, no New and no Retry, and lists again once connected", async () => {
    setLifeosStatus("box", st("pairing"));
    const retry = vi.fn();
    const { container } = draw(failed(retry));
    const body = container.querySelector("[data-lifeos-down]")!;
    expect(body.getAttribute("data-lifeos-down")).toBe("pairing");
    expect(body.textContent).toBe("The LifeOS sign-in on the box waits for your approvalShow the code");
    expect(screen.queryByText("This folder did not load")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New" })).toBeNull();
    // A status that changes changes the line at once: the old cause is never said again.
    act(() => setLifeosStatus("box", st("signed-out")));
    expect(container.querySelector("[data-lifeos-down]")!.textContent).toBe("Not signed in to LifeOS on the boxSign in");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("dialog", { name: "Sign in to LifeOS" })).toBeTruthy();
    // On its way: a wait with no press.
    act(() => setLifeosStatus("box", st("connecting")));
    expect(container.querySelector("[data-lifeos-waits]")!.textContent).toBe("LifeOS is still connecting on the box");
    expect(retry).not.toHaveBeenCalled();
    act(() => setLifeosStatus("box", st("connected")));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("says silence with Retry alone, which asks the host again", () => {
    setLifeosUnanswered("box");
    const { container } = draw(failed());
    expect(container.querySelector("[data-lifeos-down]")!.textContent).toBe("The box did not answerRetry");
  });

  it("lists as it always did once the folder listed, whatever the place said before", () => {
    setLifeosStatus("box", st("connected"));
    const copy = copyOf({ state: "signed-out", lifeos: "signed-out" });
    expect(lifeosSaved(copy, { loaded: true, loading: false, error: null })).toBe(null);
    expect(lifeosSaved(copy, { loaded: true, loading: false, error: "x" })).toBe("signed-out");
    // A host a release behind said signed-out for every state; an ok place with a listing that failed for LifeOS says its words.
    expect(lifeosSaved(copyOf({ state: "signed-out" }), null)).toBe("signed-out");
    expect(lifeosSaved(copyOf({ state: "ok" }), { loaded: true, loading: false, error: "The box did not answer. Try again once it is connected." })).toBe(null);
    // Any other place is not this rule's.
    expect(lifeosSaved({ ...copy, place: { ...copy.place, kind: "folder" } }, null)).toBe(null);
  });

  it("asks the host for its places again when its LifeOS comes back or goes", () => {
    const answer = (state: FilePlace["state"]) => ({ host: "box", places: [place(state)], rev: 1, sources: [] });
    expect(lifeosMoved(answer({ state: "signed-out", lifeos: "signed-out" }), true)).toBe(true);
    expect(lifeosMoved(answer({ state: "ok" }), false)).toBe(true);
    expect(lifeosMoved(answer({ state: "ok" }), true)).toBe(false);
    expect(lifeosMoved(answer({ state: "signed-out" }), false)).toBe(false);
    expect(lifeosMoved(undefined, true)).toBe(false);
  });
});

describe("a reason kept as words (savedOfReason)", () => {
  it("reads the host's own LifeOS sentences, and never a wait or a fetch of the window's as LifeOS's", async () => {
    const { savedOfReason } = await import("../shell/DownEmpty");
    expect(savedOfReason("This host is not signed in to LifeOS")).toBe("signed-out");
    expect(savedOfReason("This host's LifeOS sign-in waits for approval")).toBe("pairing");
    expect(savedOfReason("LifeOS is still connecting")).toBe("connecting");
    expect(savedOfReason("LifeOS is unreachable")).toBe("unreachable");
    expect(savedOfReason("LifeOS refused this host's sign-in; sign in again")).toBe("refused");
    expect(savedOfReason("Work is off on this host")).toBe("off");
    expect(savedOfReason("Not signed in to LifeOS on the box. Sign in under Settings, Connections.")).toBe("signed-out");
    expect(savedOfReason("work.docs.open timed out after 30 s")).toBe(null);
    expect(savedOfReason("fetch failed")).toBe(null);
    expect(savedOfReason("LifeOS did not answer with the task it made.")).toBe(null);
    expect(savedOfReason(null)).toBe(null);
  });
});

/**
 * Council round 10, the walk: Files' search and Home left LifeOS's rows out in silence while it was down. A search of
 * every place is tested through the real Search tab (lifeosWaits.dom.test.tsx): the round 10 case here mounted the
 * page with a copy the tab never gives, and so missed that the tab's line never had a host.
 */
describe("Home while the host's LifeOS is down", () => {
  it("puts the line over Home and claims no empty Home while LifeOS's rows are left out", async () => {
    const { HomePage } = await import("./Home");
    setLifeosStatus("box", st("signed-out"));
    const down = { environmentId: "box", sector: null, client: null, state: "signed-out" as const };
    render(<HomePage panelId="p1" home={{ waiting: [], starred: [], recent: [] }} error={null} busy={null} bar={null} lifeos={{ environmentId: "box", down, waits: false }} onRetry={() => undefined} onOpen={() => undefined} />);
    expect(document.querySelector("[data-session-down]")?.textContent).toBe("Not signed in to LifeOS on the boxSign in");
    expect(screen.queryByText("Nothing here yet")).toBeNull();
  });
});
