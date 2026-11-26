// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { registry } from "../../lib/connection/registry";
import { IDLE_STATUS, type EnvironmentStatus } from "../../lib/connection/types";
import type { WorkViewProps } from "../views/registry";
import { Head as FormsHead, View as Forms } from "../msforms/FormsView";
import { Head as MoneyHead, View as Money } from "../money/MoneyView";
import { Head as PlaysHead, View as Plays } from "../routines/plays/PlaysView";
import { Head as RoutinesHead, View as Routines } from "../routines/RoutinesView";
import { Head as TemplatesHead, View as Templates } from "../templates/TemplatesView";
import { linkIsDown } from "./hostLinkDown";

const props = {
  env: "box",
  workspace: { id: "job", name: "TempCode proof S1a", environmentId: "box", path: "/proof", sector: "purdue" },
  sector: "purdue",
  lifeos: { environmentId: "box", state: "connected", client: null },
  startThread: () => {},
} as WorkViewProps;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("holds each host header press from the first known failure to the next open link", () => {
  let state: EnvironmentStatus = { ...IDLE_STATUS, transport: "connecting" };
  vi.spyOn(registry, "statusOf").mockImplementation((id) => id === "box" ? state : IDLE_STATUS);
  vi.spyOn(registry, "primary").mockReturnValue({ environmentId: "box" } as never);
  vi.spyOn(registry, "environment").mockReturnValue({ name: "The box" } as never);
  vi.spyOn(registry, "linkOf").mockReturnValue({
    connected: false,
    onOpen: () => () => {},
    onClose: () => () => {},
    onPush: () => () => {},
    request: () => new Promise(() => {}),
  } as never);

  for (const [Head, Body, action] of [
    [RoutinesHead, Routines, "New routine"],
    [PlaysHead, Plays, "New play"],
    [FormsHead, Forms, "New form"],
    [MoneyHead, Money, "Add"],
    [TemplatesHead, Templates, "Add…"],
  ] as const) {
    state = { ...IDLE_STATUS, transport: "connecting" };
    const view = () => <><Head {...props} /><Body {...props} /></>;
    const shown = render(view());
    const disabled = () => screen.getByRole<HTMLButtonElement>("button", { name: action }).disabled;
    expect(disabled(), action).toBe(false);
    expect(screen.queryByText("The box is not connected")).toBeNull();
    for (const transport of ["reconnecting", "offline"] as const) {
      state = { ...state, transport };
      shown.rerender(view());
      expect(disabled(), action).toBe(true);
      expect(screen.getAllByText("The box is not connected")).toHaveLength(1);
    }
    state = { ...state, transport: "open" };
    shown.rerender(view());
    expect(disabled(), action).toBe(false);
    expect(screen.queryByText("The box is not connected")).toBeNull();
    shown.unmount();
  }
});

it("keeps a new connection's loading state distinct from reconnecting a link that was open", () => {
  expect(linkIsDown(IDLE_STATUS)).toBe(false);
  expect(linkIsDown({ ...IDLE_STATUS, transport: "connecting" })).toBe(false);
  expect(linkIsDown({ ...IDLE_STATUS, transport: "connecting", lastHello: {} as never })).toBe(true);
  expect(linkIsDown({ ...IDLE_STATUS, transport: "connecting", attempts: 1 })).toBe(true);
  expect(linkIsDown({ ...IDLE_STATUS, transport: "unauthorized" })).toBe(true);
});
