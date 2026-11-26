// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_NAME_MAX } from "@shared/domain";

vi.mock("../lib/tcserver/projects", () => ({ renameWorkspace: vi.fn(async () => undefined) }));

import { renameWorkspace } from "../lib/tcserver/projects";
import { RenameWorkspaceDialog } from "./RenameWorkspaceDialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const field = () => screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
const rename = () =>
  act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  });

describe("RenameWorkspaceDialog", () => {
  it("an unchanged name closes without a call; an empty one cannot be saved; the field stops at the host's cap", async () => {
    const onClose = vi.fn();
    render(<RenameWorkspaceDialog workspaceId="w1" name="temp-code" onClose={onClose} />);
    expect(field().maxLength).toBe(WORKSPACE_NAME_MAX);
    await rename();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(renameWorkspace).not.toHaveBeenCalled();
    cleanup();
    render(<RenameWorkspaceDialog workspaceId="w1" name="temp-code" onClose={onClose} />);
    fireEvent.change(field(), { target: { value: "  " } });
    expect((screen.getByRole("button", { name: "Rename" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps a refusal in the dialog, in the host's words", async () => {
    vi.mocked(renameWorkspace).mockRejectedValueOnce(new Error("refused: settings of temp-code live on box; it is offline"));
    const onClose = vi.fn();
    const onRenamed = vi.fn();
    render(<RenameWorkspaceDialog workspaceId="w1" name="temp-code" onClose={onClose} onRenamed={onRenamed} />);
    fireEvent.change(field(), { target: { value: "Docket" } });
    await rename();
    expect(renameWorkspace).toHaveBeenCalledWith("w1", "Docket");
    expect(screen.getByRole("dialog").textContent).toContain("it is offline");
    expect(onClose).not.toHaveBeenCalled();
    expect(onRenamed).not.toHaveBeenCalled();
  });
});
