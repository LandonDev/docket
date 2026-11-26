import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn } from "@renderer/lib/cn";

/**
 * One value on a line (Base UI's slider, the core of Kobra's without its
 * wobbling handle): Tab reaches the thumb, the arrows step it, Shift and
 * Page take the large step, Home and End the ends, and a drag follows the
 * pointer with nothing easing behind it. The control is 24px tall however
 * thin its track, so the thumb is easy to take. A caller that draws its own
 * track (a hue strip) passes the parts as children.
 */
function Slider({ className, children, ...props }: SliderPrimitive.Root.Props) {
  return (
    <SliderPrimitive.Root data-slot="slider" className={cn("relative w-full touch-none select-none data-disabled:opacity-50", className)} {...props}>
      <SliderPrimitive.Control data-slot="slider-control" className="flex h-6 w-full items-center">
        {children ?? (
          <SliderTrack>
            <SliderIndicator />
            <SliderThumb />
          </SliderTrack>
        )}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

function SliderTrack({ className, ...props }: SliderPrimitive.Track.Props) {
  return <SliderPrimitive.Track data-slot="slider-track" className={cn("relative h-1 w-full rounded-full bg-muted", className)} {...props} />;
}

function SliderIndicator({ className, ...props }: SliderPrimitive.Indicator.Props) {
  return <SliderPrimitive.Indicator data-slot="slider-indicator" className={cn("rounded-full bg-primary", className)} {...props} />;
}

/** The 14px disc. Its focus ring is the one ring, drawn while the range input inside it holds the keyboard (index.css). */
function SliderThumb({ className, ...props }: SliderPrimitive.Thumb.Props) {
  return <SliderPrimitive.Thumb data-slot="slider-thumb" className={cn("size-3.5 rounded-full border-2 border-foreground bg-background", className)} {...props} />;
}

export { Slider, SliderIndicator, SliderThumb, SliderTrack };
