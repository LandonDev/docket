// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeldItem } from "@shared/work";

// The drawn mail is work-kit's frame; here it is enough to see which HTML it was handed.
vi.mock("work-kit/mail", () => ({
  FrameHostProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MailKitProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MailFrame: ({ prepared }: { prepared: { html: string; options: unknown } }) => <div data-frame={JSON.stringify(prepared)} />,
  prepareMail: (html: string, options: unknown) => ({ html, options }),
}));
vi.mock("work-kit/mail/styles.css", () => ({}));
vi.mock("./kit", () => ({ tempcodeMailKit: {} }));

const { View, outgoingMail } = await import("./MailAct");

afterEach(cleanup);

const payload = {
  message: {
    from: { address: "landon@unify.test" },
    to: [{ name: "Marisol Rivera", address: "marisol@riveradental.com" }],
    subject: "Invoice 1042",
    html: '<p onclick="x()">It is <b>attached</b>.</p><script>alert(1)</script>',
    text: "It is attached.",
  },
  quote: "<blockquote>Can you send it again?</blockquote>",
};
const item = { payload } as unknown as HeldItem;

describe("a held mail in the Outbox", () => {
  it("draws exactly the HTML this host sends: the outgoing rules on his words, then the quote", () => {
    expect(outgoingMail(payload)).toBe("<p>It is <b>attached</b>.</p><blockquote>Can you send it again?</blockquote>");
    expect(outgoingMail({ message: { html: "  " } })).toBeNull();
    expect(outgoingMail(null)).toBeNull();
  });

  it("reads as plain text first, and shows the drawn mail only behind the switch", () => {
    const { container } = render(<View item={item} env="box" />);
    // The words as they go are what he is asked to read.
    expect(container.textContent).toContain("It is attached.");
    expect(container.querySelector("[data-mail-quote]")?.textContent).toContain("Can you send it again?");
    expect(container.querySelector("[data-mail-drawn]")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "As it looks" }));
    const frame = container.querySelector("[data-frame]");
    expect(frame).not.toBeNull();
    const drawn = JSON.parse(frame!.getAttribute("data-frame")!) as { html: string; options: { paper: boolean } };
    // On white, as written, with no colour moved: the paper mode.
    expect(drawn.options.paper).toBe(true);
    expect(drawn.html).toBe(outgoingMail(payload));
    // The header rows stay above the drawn mail.
    expect(container.textContent).toContain("marisol@riveradental.com");
  });

  it("seats the switch under the headers, above the body it swaps, and its words switch it", () => {
    const { container } = render(<View item={{ payload } as unknown as HeldItem} env="box" />);
    const looks = container.querySelector<HTMLElement>("[data-mail-looks]")!;
    // After the headers and before the words: it stays under the pointer whichever body shows.
    expect(looks.previousElementSibling!.tagName).toBe("DL");
    expect(looks.nextElementSibling!.textContent).toContain("It is attached.");
    fireEvent.click(within(looks).getByText("As it looks"));
    expect(screen.getByRole("switch", { name: "As it looks" }).getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector("[data-frame]")).not.toBeNull();
    // Still above what it swapped in, and its words switch back.
    expect(looks.nextElementSibling!.hasAttribute("data-mail-drawn")).toBe(true);
    fireEvent.click(within(looks).getByText("As it looks"));
    expect(container.querySelector("[data-frame]")).toBeNull();
  });

  it("offers no drawn view for a mail with no HTML", () => {
    render(<View item={{ payload: { message: { subject: "Plain", text: "Words" } } } as unknown as HeldItem} env="box" />);
    expect(screen.queryByRole("switch", { name: "As it looks" })).toBeNull();
  });
});
