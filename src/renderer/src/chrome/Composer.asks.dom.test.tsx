// @vitest-environment jsdom
/**
 * D5: the composer offers nothing its host could only refuse. A key that may only read gets no live Send and the
 * field says who can (composer-03); the permission select is not drawn where the key may not change the mode, and
 * offers a new thread only the modes the key may give (composer-04); a host that answered it has no CLI for the
 * harness holds Send (composer-16); a harness that takes no files has no Attach files row (composer-26).
 */
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ probed: false, available: true }));
vi.mock("./CwdPicker", () => ({ CwdPicker: () => null }));
vi.mock("./DraftHostPicker", () => ({ DraftHostPicker: () => null }));
vi.mock("./BranchPicker", () => ({ BranchPicker: () => null }));
vi.mock("./ThreadTypeChip", () => ({ ThreadTypeChip: () => null }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("../lib/harness/registry", async (original) => ({ ...(await original<typeof import("../lib/harness/registry")>()), isLiveHarness: () => true }));
vi.mock("../lib/harness/availability", async (original) => ({
  ...(await original<typeof import("../lib/harness/availability")>()),
  hasProbedHarnessAvailability: () => h.probed,
  isHarnessAvailable: () => h.available,
}));

import type { ComponentProps } from "react";
import type { Capability } from "@shared/capabilities";
import { registry } from "../lib/connection";
import { sessionStore } from "../lib/tcserver/store";
import { menuChunk } from "../surfaces/chunks";
import { warmMenus } from "./menuRows";
import { Composer } from "./Composer";
import { AddMenu } from "./ComposerBar";
import { useComposerAsks } from "./composerAsks";

const keyed = (caps: Capability[]) => ({ transport: "open", lastHello: { environmentId: "env_box", contract: 3, caps, key: { id: "k", name: "A paired laptop" } } }) as never;

beforeEach(() => {
  h.probed = false;
  h.available = true;
  vi.spyOn(registry, "environment").mockImplementation((id) => ({ id, name: "The box", routes: [], credentialRef: null }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(props: Partial<ComponentProps<typeof Composer>> = {}) {
  const view = render(
    <Composer
      focused={false}
      harness="claude"
      model="claude-opus-5-5"
      runtimeMode={"supervised" as never}
      executionCwd="/jobs/site"
      cwd="/jobs/site"
      sessionId="thread-1"
      onFocus={() => {}}
      onCwdChange={() => {}}
      onModelChange={() => {}}
      onRuntimeModeChange={() => {}}
      onSubmit={() => {}}
      {...props}
    />,
  );
  const field = view.container.querySelector<HTMLElement>("[data-composer-input]")!;
  act(() => {
    field.append(document.createTextNode("run the tests"));
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return { ...view, field };
}

const send = () => screen.getByRole("button", { name: /^Send/ }) as HTMLButtonElement;
const placeholder = (field: HTMLElement) => field.getAttribute("data-placeholder") ?? field.getAttribute("aria-placeholder") ?? "";

describe("the composer for a key that may only read", () => {
  it("holds Send, says who can in the field and draws no permission select", () => {
    vi.spyOn(registry, "statusOf").mockReturnValue(keyed(["read"]));
    const onSubmit = vi.fn();
    const view = mount({ onSubmit });
    expect(send().disabled).toBe(true);
    expect(placeholder(view.field)).toBe("Send from a computer that manages the box");
    fireEvent.keyDown(view.field, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox", { name: /^Permission mode/ })).toBeNull();
    expect(screen.queryByLabelText(/^Permission mode/)).toBeNull();
  });

  it("says who can on Send itself, so the reason stands when typed words hide the field's", () => {
    vi.spyOn(registry, "statusOf").mockReturnValue(keyed(["read"]));
    mount();
    expect(send().closest("[data-held]")).not.toBeNull();
  });

  it("keeps Send and the select live for the window's own socket and a full key", () => {
    vi.spyOn(registry, "statusOf").mockReturnValue(keyed(["read", "operate", "approve"]));
    const view = mount();
    expect(send().disabled).toBe(false);
    expect(placeholder(view.field)).not.toContain("computer that manages");
    expect(screen.getByLabelText(/^Permission mode/)).toBeTruthy();
  });
});

// Round 2: a thread's mode change goes to its host, so the select is held while the host is away; a draft's is the window's own.
describe("the permission select while the host is away", () => {
  it("is held on a thread, the link's words its tooltip, and live on a draft", () => {
    vi.spyOn(registry, "statusOf").mockReturnValue(keyed(["read", "operate", "approve"]));
    const isDraft = vi.spyOn(sessionStore, "isDraft").mockReturnValue(false);
    const view = mount({ blocked: "The box is offline", blockedSaid: true });
    const select = screen.getByLabelText(/^Permission mode/) as HTMLButtonElement;
    expect(select.disabled).toBe(true);
    expect(select.closest("[data-held]")).not.toBeNull();
    view.unmount();
    isDraft.mockReturnValue(true);
    mount({ blocked: "The box is offline", blockedSaid: true });
    const draft = screen.getByLabelText(/^Permission mode/) as HTMLButtonElement;
    expect(draft.disabled).toBe(false);
    expect(draft.closest("[data-held]")).toBeNull();
  });
});

describe("the composer's asks", () => {
  it("drops the select on a thread for an operate-only key and offers a draft only the modes it may give", () => {
    vi.spyOn(registry, "statusOf").mockReturnValue(keyed(["read", "operate"]));
    expect(renderHook(() => useComposerAsks("env_box", "claude", false)).result.current).toEqual({ refusal: null, accessModes: null, mayCompact: true });
    expect(renderHook(() => useComposerAsks("env_box", "claude", true)).result.current.accessModes).toEqual(["supervised", "auto-accept-edits"]);
  });

  it("offers no Compact and no Send to a read key", () => {
    vi.spyOn(registry, "statusOf").mockReturnValue(keyed(["read"]));
    expect(renderHook(() => useComposerAsks("env_box", "claude", false)).result.current).toEqual({ refusal: "Send from a computer that manages the box", accessModes: null, mayCompact: false });
  });

  it("holds Send once the host has answered it has no CLI for the harness, never on a guess", () => {
    vi.spyOn(registry, "statusOf").mockReturnValue({ transport: "open", lastHello: null } as never);
    h.available = false;
    expect(renderHook(() => useComposerAsks("env_box", "claude", false)).result.current.refusal).toBeNull();
    h.probed = true;
    expect(renderHook(() => useComposerAsks("env_box", "claude", false)).result.current.refusal).toBe("Not installed on the box");
  });
});

describe("the + menu", () => {
  it("has no Attach files row where the harness takes no files", async () => {
    await menuChunk.load();
    warmMenus();
    const { rerender } = render(<AddMenu attachable={false} onAttach={() => {}} onInsert={() => {}} fieldOf={() => null} />);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(screen.queryByRole("menuitem", { name: "Attach files" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /Mention a file or thread/ })).toBeTruthy();
    rerender(<AddMenu attachable onAttach={() => {}} onInsert={() => {}} fieldOf={() => null} />);
    expect(screen.getByRole("menuitem", { name: "Attach files" })).toBeTruthy();
  });
});
