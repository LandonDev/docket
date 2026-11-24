// @vitest-environment jsdom
/**
 * A Work draft's row and field carry nothing of code: no branch picker, no
 * project picker (code projects and a terminal), only Work's thread types,
 * and no "build" in the field's hint. A code draft keeps every one.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./CwdPicker", () => ({ CwdPicker: () => <span data-testid="cwd-picker" /> }));
vi.mock("./DraftHostPicker", () => ({ DraftHostPicker: () => null }));
vi.mock("./BranchPicker", () => ({ BranchPicker: () => <span data-testid="branch-picker" /> }));
vi.mock("./ThreadTypeChip", () => ({ ThreadTypeChip: ({ work }: { work?: boolean }) => <span data-testid="type-chip" data-work={String(!!work)} /> }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

import { Composer, DraftRow } from "./Composer";

afterEach(cleanup);

const row = (work: boolean) =>
  render(
    <DraftRow
      draft
      work={work}
      cwd="/jobs/purdue"
      recents={[]}
      enabled
      busy={false}
      threadType="chat"
      onThreadTypeChange={() => {}}
      onCwdChange={() => {}}
      onClose={() => {}}
    />,
  );

const field = (work: boolean) =>
  render(
    <Composer
      focused={false}
      harness="claude"
      model="claude-opus-5-5"
      runtimeMode={"supervised" as never}
      executionCwd="/jobs/purdue"
      cwd="/jobs/purdue"
      work={work}
      onFocus={() => {}}
      onCwdChange={() => {}}
      onModelChange={() => {}}
      onRuntimeModeChange={() => {}}
      onSubmit={() => {}}
    />,
  ).container.querySelector("[data-composer-input]");

describe("the composer for a Work thread", () => {
  it("a Work draft's row has no branch or project picker, and its type chip offers Work's types", () => {
    const view = row(true);
    expect(view.queryByTestId("branch-picker")).toBeNull();
    expect(view.queryByTestId("cwd-picker")).toBeNull();
    expect(view.getByTestId("type-chip").dataset.work).toBe("true");
  });

  it("a code draft's row keeps its branch and project pickers and every type", () => {
    const view = row(false);
    expect(view.getByTestId("branch-picker")).toBeTruthy();
    expect(view.getByTestId("cwd-picker")).toBeTruthy();
    expect(view.getByTestId("type-chip").dataset.work).toBe("false");
  });

  it("the field's hint says no build for Work, and is as it was for code", () => {
    const work = field(true)!.outerHTML;
    cleanup();
    const code = field(false)!.outerHTML;
    expect(work).toContain("Ask, / for skills, @ for references…");
    expect(work).not.toContain("build");
    expect(code).toContain("Ask, build, / for skills, @ for references…");
  });
});
