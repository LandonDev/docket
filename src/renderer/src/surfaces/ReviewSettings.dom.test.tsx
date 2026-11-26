// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOME_RECHECK_MS } from "../lib/settingsHome";
import type { ReviewSettings } from "@server/shared/review";

const state = vi.hoisted(() => ({
  get: null as null | ((params: unknown) => Promise<unknown>),
  set: vi.fn(async (_params: unknown): Promise<unknown> => ({})),
  connected: true,
  opens: new Set<() => void>(),
}));

vi.mock("../components/choice-select", async () => await import("../components/choice-select-body"));
vi.mock("../components/choice-combobox", async () => await import("../components/choice-combobox-body"));
vi.mock("../chrome/ProjectDialogs", () => ({
  ProjectSettingsDialog: ({ project }: { project: { name: string } }) => <div role="dialog" aria-label={`Sheet ${project.name}`} />,
}));
const catalog = vi.hoisted(() => ({
  projects: [] as { id: string; name: string; environmentId: string; workspaceId: string }[],
  own: new Set<string>(),
}));
vi.mock("../lib/tcserver/workspaces", () => ({
  useWorkspaceCatalog: () => ({ projects: catalog.projects, workspaces: [{ id: "w1", name: "temp-code", environmentId: "local" }] }),
}));
vi.mock("../lib/connection", () => ({
  registry: {
    primary: () => ({ environmentId: "local" }),
    linkOf: () => ({
      get connected() {
        return state.connected;
      },
      onOpen: (l: () => void) => {
        state.opens.add(l);
        return () => state.opens.delete(l);
      },
      request: (method: string, params: unknown, options?: unknown) => {
        const projectId = (params as { projectId?: string | null }).projectId;
        if (method === "review.get" && projectId)
          return Promise.resolve({ override: null, global: null, settings: null, source: catalog.own.has(projectId) ? "project" : "global" });
        return method === "review.get" ? state.get!({ params, options }) : state.set(params);
      },
    }),
  },
}));
vi.mock("../lib/sounds", () => ({ playCue: () => {} }));
vi.mock("../lib/tcserver/rules", () => ({ useRulesScope: () => ({ scope: undefined, catalog: null }) }));
vi.mock("../lib/models", () => ({ resolveModel: (harness: string) => ({ harness, id: "m", settings: [] }) }));
vi.mock("../lib/tcserver/defaults", async (original) => ({
  ...(await original<typeof import("../lib/tcserver/defaults")>()),
  effortLadder: () => [],
}));
vi.mock("../lib/reviewScope", async (original) => ({
  ...(await original<typeof import("../lib/reviewScope")>()),
  reviewerModel: () => null,
  reviewerModelOptions: (provider: string) =>
    provider === "codex" ? [{ value: "gpt-6.1-sol", label: "GPT-6.1 Sol" }] : [{ value: "claude-opus-5-5", label: "Opus 5.5" }],
}));

const { ReviewsPage } = await import("./ReviewSettings");
const { ReviewFields, useReviewScope } = await import("../chrome/ReviewFields");

const SETTINGS: ReviewSettings = {
  beforeMerge: false,
  provider: "codex",
  model: "gpt-6.1-sol",
  reasoning: "high",
  blockOn: "confirmed",
  maxMinutes: 15,
};

function answer(settings: ReviewSettings) {
  state.get = async () => ({ override: null, global: settings, settings, source: "global" });
}

const lastSet = () => (state.set.mock.calls.at(-1)?.[0] as { settings: ReviewSettings }).settings;

async function renderPage() {
  render(<ReviewsPage />);
  await act(async () => {});
}

beforeEach(() => {
  answer(SETTINGS);
  state.set.mockReset();
  state.set.mockImplementation(async () => ({}));
  state.connected = true;
  state.opens.clear();
  catalog.projects = [];
  catalog.own = new Set();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The window's socket opening: the link turns connected and tells its listeners. */
async function openSocket() {
  state.connected = true;
  await act(async () => {
    for (const l of [...state.opens]) l();
  });
}

describe("Reviews page", () => {
  it("keeps the review set beside its home and rechecks only while offline", async () => {
    vi.useFakeTimers();
    const offline = { name: "box", online: false };
    const online = { ...offline, online: true };
    const scope = { override: null, global: SETTINGS, settings: SETTINGS, source: "global" };
    const read = vi.fn().mockResolvedValueOnce({ ...scope, home: offline }).mockResolvedValue({ ...scope, home: online });
    state.get = read;
    const { result } = renderHook(() => useReviewScope("local", null));
    await act(async () => {});
    expect(result.current.scope).toEqual({ ...scope, home: offline });
    await act(() => vi.advanceTimersByTimeAsync(HOME_RECHECK_MS));
    expect(result.current.scope).toEqual({ ...scope, home: online });
    await act(() => vi.advanceTimersByTimeAsync(HOME_RECHECK_MS));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shows skeleton rows before review.get answers", () => {
    state.get = () => new Promise(() => {});
    render(<ReviewsPage />);
    expect(screen.getByTestId("review-skeleton")).toBeTruthy();
    // The page's five rows in their shape: the switch, three choices, the minutes field.
    expect([...document.querySelectorAll<HTMLElement>("[data-slot=page-row-skeleton]")].map((r) => r.dataset.control)).toEqual(["switch", "select", "select", "select", "number"]);
  });

  it("asks with the link's retry, so a read before the socket opens lands once it does", async () => {
    const asked: unknown[] = [];
    state.get = async (call) => {
      asked.push(call);
      return { override: null, global: SETTINGS, settings: SETTINGS, source: "global" };
    };
    await renderPage();
    expect(asked[0]).toMatchObject({ options: { retry: true } });
  });

  it("waits for the socket after a reload and loads the moment it opens", async () => {
    state.connected = false;
    const asked: unknown[] = [];
    state.get = async (call) => {
      asked.push(call);
      return { override: null, global: SETTINGS, settings: SETTINGS, source: "global" };
    };
    await renderPage();
    expect(asked).toHaveLength(0);
    expect(screen.getByTestId("review-skeleton")).toBeTruthy();
    await openSocket();
    expect(asked).toHaveLength(1);
    expect(screen.getByRole("switch", { name: "Review before merge" })).toBeTruthy();
  });

  it("says the host did not answer at the deadline, then loads when a socket opens", async () => {
    vi.useFakeTimers();
    state.connected = false;
    render(<ReviewsPage />);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(screen.getByText("The computer did not answer").className).toContain("text-destructive");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    await openSocket();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("switch", { name: "Review before merge" })).toBeTruthy();
    expect(screen.queryByText("The computer did not answer")).toBeNull();
  });

  it("lands an answer that comes after the deadline, with no Retry and no new socket", async () => {
    vi.useFakeTimers();
    let answerNow: (v: unknown) => void = () => {};
    state.get = () => new Promise((resolve) => (answerNow = resolve));
    render(<ReviewsPage />);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(screen.getByText("The computer did not answer")).toBeTruthy();
    await act(async () => answerNow({ override: null, global: SETTINGS, settings: SETTINGS, source: "global" }));
    expect(screen.getByRole("switch", { name: "Review before merge" })).toBeTruthy();
    expect(screen.queryByText("The computer did not answer")).toBeNull();
  });

  it("says why the load failed, and Retry asks again", async () => {
    state.get = async () => {
      throw new Error("not connected");
    };
    await renderPage();
    expect(screen.getByText("not connected").className).toContain("text-destructive");
    answer(SETTINGS);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(screen.getByRole("switch", { name: "Review before merge" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows one row while off and four while on", async () => {
    await renderPage();
    expect(document.querySelectorAll("[data-slot=page-row]")).toHaveLength(1);
    cleanup();
    answer({ ...SETTINGS, beforeMerge: true });
    await renderPage();
    expect(document.querySelectorAll("[data-slot=page-row]")).toHaveLength(4);
  });

  it("turns review on through review.set", async () => {
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Review before merge" }));
    });
    expect(lastSet().beforeMerge).toBe(true);
    expect(document.querySelectorAll("[data-slot=page-row]")).toHaveLength(4);
  });

  it("saves Stop the merge for", async () => {
    answer({ ...SETTINGS, beforeMerge: true });
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole("combobox", { name: "Stop the merge for" }));
    });
    const option = await screen.findByRole("option", { name: "Any finding" });
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: "mouse" });
      fireEvent.click(option);
    });
    expect(lastSet().blockOn).toBe("any");
  });

  it("picks the review model from one searchable list over both agent apps", async () => {
    answer({ ...SETTINGS, beforeMerge: true });
    await renderPage();
    await act(async () => {
      fireEvent.click(document.querySelector("[data-slot=combobox-trigger][aria-label='Review model']")!);
    });
    const option = await screen.findByRole("option", { name: "Opus 5.5" });
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: "mouse" });
      fireEvent.click(option);
    });
    expect(lastSet()).toMatchObject({ provider: "claude", model: "claude-opus-5-5" });
  });

  it("commits Wait at most on Enter and reverts what is out of range", async () => {
    answer({ ...SETTINGS, beforeMerge: true });
    await renderPage();
    expect(screen.getByText("Past it the merge goes ahead unreviewed")).toBeTruthy();
    const field = screen.getByRole("textbox", { name: "Wait at most" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "30" } });
    await act(async () => {
      field.focus();
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(lastSet().maxMinutes).toBe(30);
    for (const bad of ["0", "999"]) {
      state.set.mockClear();
      fireEvent.change(field, { target: { value: bad } });
      await act(async () => {
        fireEvent.blur(field);
      });
      expect(state.set).not.toHaveBeenCalled();
      expect(field.value).toBe("30");
    }
  });

  it("puts a refused change back and says why under its row", async () => {
    state.set.mockImplementation(async () => {
      throw new Error("refused: review settings live on box; it is offline");
    });
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Review before merge" }));
    });
    const row = document.querySelector("[data-setting='reviews.on']") as HTMLElement;
    expect(row.textContent).toContain("Review settings live on box; it is offline");
    expect(screen.getByRole("switch", { name: "Review before merge" }).getAttribute("aria-checked")).toBe("false");
    expect(document.querySelectorAll("[data-slot=page-row]")).toHaveLength(1);
  });

  it("holds the controls while the box that keeps the set is offline", async () => {
    state.get = async () => ({ override: null, global: SETTINGS, settings: SETTINGS, source: "global", home: { name: "The box", online: false } });
    await renderPage();
    expect((screen.getByRole("switch", { name: "Review before merge" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists the projects with their own set, while review is on, each opening its sheet", async () => {
    catalog.projects = [
      { id: "p1", name: "settings-2", environmentId: "local", workspaceId: "w1" },
      { id: "p2", name: "docket", environmentId: "local", workspaceId: "w1" },
    ];
    catalog.own = new Set(["p1"]);
    answer({ ...SETTINGS, beforeMerge: true });
    await renderPage();
    await act(async () => {});
    const row = document.querySelector("[data-setting='reviews.different']") as HTMLElement;
    expect(row.textContent).toContain("Different in 1 project");
    expect(row.textContent).toContain("settings-2 has reviews off");
    expect(row.textContent).toContain("settings-2");
    await act(async () => {
      fireEvent.click(row.querySelector("[data-row-open]")!);
    });
    const list = await screen.findByRole("dialog");
    expect(list.textContent).toContain("Reviews off");
    expect(list.querySelector("[data-slot=open-cue]")).toBeTruthy();
    await act(async () => {
      fireEvent.click(list.querySelector("[data-row-open]")!);
    });
    expect(await screen.findByRole("dialog", { name: "Sheet settings-2" })).toBeTruthy();
  });
});

describe("ReviewFields compact", () => {
  it("hides the other rows while review is off", () => {
    const { rerender } = render(<ReviewFields value={SETTINGS} onChange={() => {}} environmentId="local" compact />);
    expect(screen.queryByRole("combobox", { name: "Stop the merge for" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Wait at most" })).toBeNull();
    rerender(<ReviewFields value={{ ...SETTINGS, beforeMerge: true }} onChange={() => {}} environmentId="local" compact />);
    expect(screen.getByRole("combobox", { name: "Stop the merge for" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Wait at most" })).toBeTruthy();
  });
});
