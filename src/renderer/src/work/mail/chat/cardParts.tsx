import { Bones } from "../../../components/bones";

/** The card's shape while what it shows is on its way: its head's title over two lines of the mail, from sample words. */
export function CardBones() {
  return (
    <Bones label="Loading">
      <div className={CARD}>
        <div className={HEAD}>
          <p className="truncate text-[13px] leading-5 font-medium">Reply to Jordan Ellis</p>
        </div>
        <div className="flex flex-col gap-1 px-3 pt-1 pb-3 text-[13px] leading-5">
          <p className="truncate">Thanks, Saturday works. We will be there by five to set up.</p>
          <p className="truncate">I will bring the casters' desk and the spare cables.</p>
        </div>
      </div>
    </Bones>
  );
}

/** One card in the transcript: 12px radius, a hairline, no card inside it. */
export const CARD = "tc-mail min-w-0 overflow-hidden rounded-xl border border-border bg-background";
/** A card's head: 36px, its title at 13px medium, its state at the end in 12px muted. */
export const HEAD = "flex h-9 items-center gap-2 px-3";
/** A card's foot: its presses, on a hairline. */
export const FOOT = "flex h-11 items-center gap-1.5 border-t border-border px-3";
