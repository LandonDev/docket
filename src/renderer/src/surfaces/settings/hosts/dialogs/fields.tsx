import { useEffect, useState } from "react";

/** "expires in 9:41": a countdown the old sign-in list shows beside a waiting link. */
export function Countdown({ prefix, at }: { prefix: string; at: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const left = Math.max(0, Math.round((at - now) / 1000));
  return (
    <>
      {prefix} {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
    </>
  );
}
