// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FrameioStatus } from "@shared/contract-work-frameio";
import { FrameioRows, FrameioRowsView } from "./FrameioRow";
import type { Link } from "../../lib/connection/link";

const opened = vi.hoisted(() => [] as string[]);
vi.mock("../../lib/native", () => ({ openUrl: async (url: string) => void opened.push(url) }));

afterEach(cleanup);

const OUT: FrameioStatus = { signedIn: false, redirectUri: "http://127.0.0.1:7697/frameio/callback", pending: false };
const IN: FrameioStatus = { ...OUT, signedIn: true, clientId: "adobe-native-client", user: { id: "u1", name: "Landon", email: "landon@example.test" } };

describe("Frame.io in Settings, Work", () => {
  it("draws its shape while loading, and the refusal with Retry", () => {
    const { container, rerender } = render(<FrameioRowsView status={undefined} error={null} onRetry={() => {}} request={vi.fn()} />);
    expect(container.textContent).not.toContain("Frame.io");
    const retry = vi.fn();
    rerender(<FrameioRowsView status={undefined} error="The host did not answer" onRetry={retry} request={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalled();
  });

  /** Council round 12 (the walk): Retry cleared the refusal at once, so the row dropped to its bones before the answer. */
  it("keeps the refusal with Retry spinning until the host answers, through the page's own read", async () => {
    let answer: (s: FrameioStatus) => void = () => {};
    const request = vi.fn().mockRejectedValueOnce(new Error("The host did not answer")).mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const link = { connected: true, request, onOpen: () => () => {}, onPush: () => () => {} } as unknown as Link;
    render(<FrameioRows link={link} />);
    const retry = (await screen.findByRole("button", { name: "Retry" })) as HTMLButtonElement;
    fireEvent.click(retry);
    await act(async () => new Promise((settle) => setTimeout(settle, 10)));
    expect(request).toHaveBeenCalledTimes(2);
    expect(retry.disabled).toBe(true);
    expect(retry.querySelector("[data-busy]")).not.toBeNull();
    expect(screen.getByText("The host did not answer")).toBeTruthy();
    await act(async () => answer(OUT));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("signs in through Adobe, then takes the pasted address", async () => {
    const asked: Array<[string, unknown]> = [];
    const request = vi.fn(async (method: string, params: unknown) => {
      asked.push([method, params]);
      return method === "work.frameio.signIn" ? { url: "https://ims.example.test/ims/authorize/v2?x" } : IN;
    }) as never;
    render(<FrameioRowsView status={OUT} error={null} onRetry={() => {}} request={request} />);
    expect(screen.getByText("Not signed in")).toBeTruthy();
    expect(screen.queryByText("Frame.io webhooks")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in…" }));
    const confirm = await screen.findByRole("button", { name: "Open Adobe sign-in" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "adobe-native-client" } });
    await act(async () => fireEvent.click(confirm));
    expect(asked[0]).toEqual(["work.frameio.signIn", { clientId: "adobe-native-client", redirectUri: OUT.redirectUri }]);
    expect(opened).toEqual(["https://ims.example.test/ims/authorize/v2?x"]);
    fireEvent.change(screen.getByLabelText("Address the sign-in ended on"), { target: { value: "http://127.0.0.1:7697/frameio/callback?code=c&state=s" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));
    expect(asked[1]).toEqual(["work.frameio.finish", { url: "http://127.0.0.1:7697/frameio/callback?code=c&state=s" }]);
  });

  it("shows who is signed in, and refuses a webhook address that is not https", async () => {
    render(<FrameioRowsView status={IN} error={null} onRetry={() => {}} request={vi.fn() as never} />);
    expect(screen.getByText("landon@example.test")).toBeTruthy();
    expect(screen.getByText("Off")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set address…" }));
    fireEvent.change(await screen.findByLabelText("Address"), { target: { value: "http://box.example.test" } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
