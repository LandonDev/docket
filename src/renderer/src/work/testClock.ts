/** A local fixture clock. Set TC_TEST_LOCAL_TIME to an ISO date and time without an offset. */
export function workTestClock(): number {
  const override = process.env.TC_TEST_LOCAL_TIME;
  return override ? new Date(override).getTime() : new Date(2026, 10, 23, 12).getTime();
}
