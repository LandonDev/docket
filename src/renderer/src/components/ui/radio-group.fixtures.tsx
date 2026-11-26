// Fixtures for `bun run ui:preview src/renderer/src/components/ui/radio-group.fixtures.tsx#RadioGallery`:
// the three single choices Settings → Computers asked for, each choice with its
// line of words, and the same group with a choice held and the whole group off.
// A static page cannot focus; the ring and the keys are DOM-tested (ui.dom.test.tsx).
import { RadioChoice, RadioGroup } from "./radio-group";

function Case({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex w-full max-w-sm flex-col gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

export function RadioGallery() {
  return (
    <div className="flex flex-col gap-6">
      <Case title="It may">
        <RadioGroup aria-label="It may" defaultValue="run">
          <RadioChoice value="look" label="Look" description="Read threads, files and settings" />
          <RadioChoice value="run" label="Run threads" description="Start, steer and stop threads" />
          <RadioChoice value="approve" label="Also approve" description="Answer a thread's requests to run a command" />
          <RadioChoice value="admin" label="Also change settings" description="Add computers, keys and accounts" />
        </RadioGroup>
      </Case>
      <Case title="What the box may do on this Mac">
        <RadioGroup aria-label="What the box may do on this Mac" defaultValue="off">
          <RadioChoice value="off" label="Off" />
          <RadioChoice value="read" label="Read" description="List and read files" />
          <RadioChoice value="run" label="Read and run" description="Also run commands, with a card for each" />
          <RadioChoice value="full" label="Full access" description="Run commands without asking" disabled />
        </RadioGroup>
      </Case>
      <Case title="Disabled">
        <RadioGroup aria-label="Add a computer" defaultValue="link" disabled>
          <RadioChoice value="link" label="With a setup link" disabled />
          <RadioChoice value="key" label="With a key" disabled />
        </RadioGroup>
      </Case>
    </div>
  );
}
