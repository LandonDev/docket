import { Bar, BarChart, CartesianGrid, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";
import { formatMoney } from "@shared/work/money";
import { AXIS, BAR, BAR_CURSOR, ChartFrame, GRID } from "@aliax/charts/chart";
import { ChartTooltipContent } from "@aliax/charts/tooltip";
import { shortMoney } from "./model";
import { MONTH_BARS_HEIGHT, trueRows, type MonthBar, type TooltipProps } from "./monthBars";

/** The year's chart, in and out by month: the one part of Money that draws with the chart library, so the one part in this chunk. */
export function MonthBars({ data }: { data: MonthBar[] }) {
  return (
    <ChartFrame label="In and out by month" height={MONTH_BARS_HEIGHT}>
      <BarChart data={data} barGap={2} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
        <CartesianGrid {...GRID} />
        <XAxis {...AXIS} dataKey="month" interval={0} />
        <YAxis {...AXIS} width={48} tickFormatter={shortMoney} />
        <ChartTooltip
          cursor={BAR_CURSOR}
          isAnimationActive={false}
          content={(props) => (
            <ChartTooltipContent active={props.active} payload={trueRows(props.payload as TooltipProps["payload"])} label={props.label as TooltipProps["label"]} valueFormatter={formatMoney} />
          )}
        />
        <Bar {...BAR} dataKey="in" name="In" fill="var(--chart-1)" />
        <Bar {...BAR} dataKey="out" name="Out" fill="var(--chart-2)" />
      </BarChart>
    </ChartFrame>
  );
}
