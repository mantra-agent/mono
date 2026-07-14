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
  const [weeksToShow, setWeeksToShow] = useState(12);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const compute = () => {
      const available = Math.max(0, element.clientWidth - 34);
      setWeeksToShow(Math.max(6, Math.floor(available / 22) - 3));
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { weeks, maximum } = useMemo(() => {
    const visible = days.slice(-weeksToShow * 7);
    const padded = [...visible];
    while (padded.length % 7 !== 0) padded.unshift({ date: "", value: 0 });
    const grouped: ActivityHeatmapDay[][] = [];
    for (let index = 0; index < padded.length; index += 7) grouped.push(padded.slice(index, index + 7));
    return { weeks: grouped, maximum: Math.max(0, ...visible.map((day) => day.value)) };
  }, [days, weeksToShow]);

  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const monthDay = (date: string) => {
    if (!date) return "";
    const [, month, day] = date.split("-");
    return `${Number(month)}/${day}`;
  };

  return (
    <div ref={containerRef} className="w-full overflow-hidden" data-testid="activity-heatmap">
      <div className="flex w-max gap-0.5">
        {weeks.map((week, weekIndex) => (
          <div key={`week-${weekIndex}`} className="flex w-5 shrink-0 flex-col gap-0.5">
            <div className="relative h-7 overflow-visible">
              <span className="absolute bottom-2 left-1/2 whitespace-nowrap text-2xs leading-none text-muted-foreground/70" style={{ transform: "translateX(-50%) rotate(-90deg)", transformOrigin: "center center" }}>
                {monthDay(week.find((day) => day.date)?.date ?? "")}
              </span>
            </div>
            {week.map((day, dayIndex) => {
              if (!day.date) return <div key={`blank-${dayIndex}`} className="h-5 w-5 shrink-0" />;
              const percent = maximum === 0 ? 0 : Math.round((day.value / maximum) * 100);
              return (
                <button
                  key={day.date}
                  type="button"
                  title={`${day.date}: ${day.value} ${valueLabel}`}
                  onClick={() => onSelectDate?.(day.date)}
                  style={{ backgroundColor: heatmapFillColor(percent) }}
                  className={`relative block h-5 w-5 shrink-0 appearance-none rounded-[3px] border-0 p-0 transition-shadow hover:ring-1 hover:ring-foreground/60 ${day.date === today ? "ring-1 ring-foreground/60" : ""}`}
                  data-testid={`heatmap-cell-${day.date}`}
                />
              );
            })}
          </div>
        ))}
        <div className="flex w-7 shrink-0 flex-col gap-0.5 pl-1">
          <div className="h-7" />
          {dayLabels.map((label) => <div key={label} className="flex h-5 items-center justify-start"><span className="text-[10px] leading-none text-muted-foreground">{label}</span></div>)}
        </div>
      </div>
    </div>
  );
}
