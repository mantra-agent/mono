import { useEffect, useMemo, useRef, useState } from "react";

export interface ActivityHeatmapDay {
  date: string;
  value: number;
}

interface ActivityHeatmapProps {
  days: ActivityHeatmapDay[];
  onSelectDate?: (date: string) => void;
  valueLabel: string;
}

export function heatmapFillColor(percent: number): string {
  if (percent <= 0) return "hsl(var(--muted) / 0.3)";
  const opacity = 0.15 + (Math.max(0, Math.min(100, percent)) / 100) * 0.85;
  return `hsl(var(--success) / ${opacity.toFixed(2)})`;
}

export function ActivityHeatmap({ days, onSelectDate, valueLabel }: ActivityHeatmapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const labelColumnRef = useRef<HTMLDivElement | null>(null);
  const [weeksToShow, setWeeksToShow] = useState(12);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const compute = () => {
      const weekWidth = 20;
      const columnGap = 2;
      // Measure the rendered weekday-label column instead of assuming its width,
      // so the week count always fits the space that actually remains for cells.
      const labelGutter = (labelColumnRef.current?.offsetWidth ?? 32) + columnGap;
      const available = Math.max(0, element.clientWidth - labelGutter);
      setWeeksToShow(Math.max(6, Math.floor((available + columnGap) / (weekWidth + columnGap))));
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(element);
    if (labelColumnRef.current) observer.observe(labelColumnRef.current);
    return () => observer.disconnect();
  }, []);

  const { weeks, maximum, latestDate } = useMemo(() => {
    const latest = days.at(-1)?.date;
    if (!latest) return { weeks: [], maximum: 0, latestDate: "" };

    const valuesByDate = new Map(days.map((day) => [day.date, day.value]));
    const latestDay = new Date(`${latest}T12:00:00Z`);
    const mondayOffset = (latestDay.getUTCDay() + 6) % 7;
    const firstDay = new Date(latestDay);
    firstDay.setUTCDate(latestDay.getUTCDate() - ((weeksToShow - 1) * 7 + mondayOffset));

    const alignedDays: ActivityHeatmapDay[] = [];
    for (let index = 0; index < weeksToShow * 7; index += 1) {
      const date = new Date(firstDay);
      date.setUTCDate(firstDay.getUTCDate() + index);
      const dateString = date.toISOString().slice(0, 10);
      alignedDays.push({ date: dateString, value: valuesByDate.get(dateString) ?? 0 });
    }

    const grouped: ActivityHeatmapDay[][] = [];
    for (let index = 0; index < alignedDays.length; index += 7) grouped.push(alignedDays.slice(index, index + 7));
    const visibleValues = alignedDays.filter((day) => day.date <= latest);
    return {
      weeks: grouped,
      maximum: Math.max(0, ...visibleValues.map((day) => day.value)),
      latestDate: latest,
    };
  }, [days, weeksToShow]);
  const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const monthDay = (date: string) => {
    if (!date) return "";
    const [, month, day] = date.split("-");
    return `${Number(month)}/${day}`;
  };

  return (
    <div ref={containerRef} className="flex w-full gap-0.5" data-testid="activity-heatmap">
      <div className="min-w-0 overflow-hidden">
        <div className="flex w-max gap-0.5">
        {weeks.map((week, weekIndex) => (
          <div key={`week-${weekIndex}`} className="flex w-5 shrink-0 flex-col gap-0.5">
            <div className="relative h-7 overflow-visible">
              <span className="absolute bottom-2 left-1/2 whitespace-nowrap text-2xs leading-none text-muted-foreground/70" style={{ transform: "translateX(-50%) rotate(-90deg)", transformOrigin: "center center" }}>
                {monthDay(week.find((day) => day.date)?.date ?? "")}
              </span>
            </div>
            {week.map((day) => {
              if (day.date > latestDate) return <div key={day.date} className="h-5 w-5 shrink-0" />;
              const percent = maximum === 0 ? 0 : Math.round((day.value / maximum) * 100);
              return (
                <button
                  key={day.date}
                  type="button"
                  title={`${day.date}: ${day.value} ${valueLabel}`}
                  onClick={() => onSelectDate?.(day.date)}
                  style={{ backgroundColor: heatmapFillColor(percent) }}
                  className={`relative block h-5 w-5 shrink-0 appearance-none rounded-[3px] border-0 p-0 transition-shadow hover:ring-1 hover:ring-foreground/60 ${day.date === latestDate ? "ring-1 ring-foreground/60" : ""}`}
                  data-testid={`heatmap-cell-${day.date}`}
                />
              );
            })}
          </div>
        ))}
        </div>
      </div>
      <div ref={labelColumnRef} className="flex shrink-0 flex-col gap-0.5 pl-1">
        <div className="h-7" />
        {dayLabels.map((label) => <div key={label} className="flex h-5 items-center justify-start"><span className="whitespace-nowrap text-[10px] leading-none text-muted-foreground">{label}</span></div>)}
      </div>
    </div>
  );
}
