// @vitest-environment jsdom
/** Council round 1 (R1-A3): a view's body said "LifeOS is still connecting on the box" as a title, where every other reader's wait is one muted line. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { registry } from "../../lib/connection/registry";
import { DownEmpty } from "./DownEmpty";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("says a session on its way as a muted wait with its spinner, no title and no press", () => {
  vi.spyOn(registry, "environment").mockReturnValue({ name: "The box" } as never);
  render(<DownEmpty live={{ down: null, waits: true }} environmentId="env_box" onRetry={() => {}} />);
  const wait = document.querySelector("[data-lifeos-waits]")!;
  expect(wait.querySelector('[data-slot="empty-description"]')!.textContent).toBe("LifeOS is still connecting on the box");
  expect(wait.querySelector('[data-slot="empty-title"]')).toBeNull();
  expect(wait.querySelector('[data-slot="spinner"]')).not.toBeNull();
  expect(wait.querySelector("button")).toBeNull();
});
