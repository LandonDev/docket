// Fixtures for `bun run ui:preview src/renderer/src/work/pdf/PdfCanvas.preview.tsx#PdfPreview --width 864`,
// and the preview's file: the prototype's ballroom contract laid out as lines on US letter paper.
import type { FakePage } from "./testkit";

export default [
  { name: "Reading", props: { moment: "reading" } },
  { name: "Fill and sign: the agent's values wait, the first outlined", props: { moment: "fill" } },
  { name: "A citation from the thread, its clause marked", props: { moment: "cite" } },
  { name: "Find", props: { moment: "find" } },
  { name: "140 pages: the thumbnail rail", props: { moment: "long" } },
  { name: "Loading", props: { moment: "loading" } },
  { name: "Cannot open: a password", props: { moment: "locked" } },
  { name: "Moved: the copy kept", props: { moment: "moved" } },
];

export type PreviewPage = FakePage;

const PT = 1 / 792;
const LEFT = 0.08;
const RIGHT = 0.92;

/** Lays out paragraphs as lines on a page: what pdf.js would read back as runs. */
class Sheet {
  lines: NonNullable<FakePage["lines"]> = [];
  y = 0.06;
  line(text: string, size = 9.5, bold = false, x = LEFT): this {
    this.lines.push({ text, box: [x, this.y, RIGHT, this.y + size * 1.2 * PT], size, bold });
    this.y += size * 1.45 * PT;
    return this;
  }
  para(text: string, size = 9.5, bold = false): this {
    const words = text.split(" ");
    let line = "";
    for (const word of words) {
      if ((line + " " + word).length > 104) {
        this.line(line, size, bold);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) this.line(line, size, bold);
    this.y += 3 * PT;
    return this;
  }
  gap(points: number): this {
    this.y += points * PT;
    return this;
  }
  page(): FakePage {
    return { lines: this.lines, runs: this.lines.map((l) => ({ str: l.text, box: l.box })) };
  }
}

const CLAUSES: Record<number, Array<[string, string[]]>> = {
  1: [
    ["1. Parties.", ['1.1 This agreement is between The Trustees of Purdue University, acting through Purdue Memorial Union Event Services ("Purdue"), and Purdue Esports, a program of RecWell ("Licensee").']],
    ["2. Event.", ['2.1 Spring LAN, a gaming tournament open to Purdue students and guests, on Saturday, April 10, 2027, in the North and South Ballrooms (the "Space").']],
    ["3. Hours.", ["3.1 Licensee may enter the Space from 7:00 AM for setup.", "3.2 Doors open to guests no earlier than 9:00 AM.", "3.3 The Space must be clear of people and equipment by 12:00 AM."]],
    ["4. Fees.", ["4.1 Licensee shall pay the following: room rental, North and South Ballrooms, $2,400.00; setup and AV crew, $850.00; power distribution, 24 floor drops, $600.00; security, 2 officers for 14 hours, $1,120.00. Total $4,970.00."]],
  ],
  2: [["", ["4.2 A deposit of 50 percent, $2,485.00, is due by December 15, 2026. Purdue holds the date only once the deposit is received.", "4.3 The balance is due within 10 days after the event.", "4.4 Time in the Space after 12:00 AM is billed at $350.00 an hour or part of one."]]],
  6: [
    ["7. Cancellation.", ["7.1 Either party may cancel this agreement by written notice to the other.", "7.2 If Licensee cancels after March 1, 2027, Purdue keeps the deposit.", "7.3 If Licensee cancels within 14 days of the event, Licensee owes the full fee in clause 4.1.", "7.4 Purdue may cancel for a University closing or an emergency and will refund all payments, including the deposit."]],
  ],
  13: [["14. General.", ["14.3 A refund of a deposit goes to the account that paid it, within 30 days.", "14.4 A deposit earns no interest while Purdue holds it."]]],
};

export function contractPages(): FakePage[] {
  return Array.from({ length: 14 }, (_, i) => {
    const n = i + 1;
    const s = new Sheet();
    if (n === 1) {
      s.line("Purdue Memorial Union, Event Services", 7).line("Agreement EV-26-0410, issued November 16, 2026", 7).gap(14);
      s.line("Facility Use Agreement", 14, true, 0.33).line("North and South Ballrooms", 8, false, 0.39).gap(8);
    }
    for (const [head, clauses] of CLAUSES[n] ?? [[`${n + 1}. General terms.`, [`${n + 1}.1 Licensee follows the Union's rules for events in its rooms, as posted at the date of the event.`, `${n + 1}.2 Notices under this agreement go to the addresses on page 14.`]]]) {
      if (head) s.gap(4).line(head, 9.5, true);
      for (const clause of clauses) s.para(clause);
    }
    s.y = 0.955;
    s.line(`Facility Use Agreement EV-26-0410, page ${n} of 14`, 7);
    return s.page();
  });
}

/** The form page: its labels as the file prints them; the fields are drawn by the canvas. */
export function formPage(): FakePage {
  const s = new Sheet();
  s.line("15. Licensee information and signature.", 9.5, true).para("By signing, Licensee accepts this agreement and its Exhibits A and B.");
  s.y = 0.212;
  s.line("ORGANIZATION", 6.5, true, 0.1);
  s.y = 0.282;
  s.line("CONTACT NAME", 6.5, true, 0.1);
  s.lines.push({ text: "EMAIL", box: [0.52, 0.282, 0.9, 0.292], size: 6.5, bold: true });
  s.y = 0.352;
  s.line("PHONE", 6.5, true, 0.1);
  s.lines.push({ text: "EXPECTED ATTENDANCE", box: [0.52, 0.352, 0.9, 0.362], size: 6.5, bold: true });
  s.y = 0.446;
  s.line("SIGNATURE FOR LICENSEE", 6.5, true, 0.1);
  s.lines.push({ text: "DATE", box: [0.6, 0.446, 0.9, 0.456], size: 6.5, bold: true });
  s.y = 0.56;
  s.line("For Purdue: Karen Mills, Event Services Manager, signs on return.", 8);
  return s.page();
}

export function guidePages(count: number): FakePage[] {
  return Array.from({ length: count }, (_, i) => {
    const s = new Sheet();
    s.line("Purdue Memorial Union, Event planning guide 2027", 7).gap(10);
    s.line(`Section ${Math.floor(i / 10) + 1}. Rooms and services.`, 9.5, true);
    s.para("Each ballroom has a 400 A panel. Event Services sets the drops; no one else may open a panel.");
    s.para("The North Ballroom has 12 floor boxes. Each carries two 20 A circuits, and each circuit may serve up to six gaming stations with monitors.");
    s.y = 0.955;
    s.line(String(i + 1), 7, false, 0.49);
    return s.page();
  });
}
