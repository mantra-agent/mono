import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Loader2 } from "lucide-react";
import type {
  RecipientRecapProjectionResponse,
  RecipientRecapTaskProjection,
} from "@shared/meeting-recipient-recap";
import { SimpleCheckCircle } from "@/components/home/home-check-circle";
import { getQueryFn } from "@/lib/queryClient";

function formatMeetingDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDeadline(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function RecapList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      <ul className="space-y-2">
        {items.map((item, index) => (
          <li key={`${title}-${index}`} className="flex gap-2 text-sm leading-6 text-foreground">
            <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RecipientTaskRow({ task }: { task: RecipientRecapTaskProjection }) {
  const completed = task.status === "done";
  const deadline = formatDeadline(task.deadline);
  return (
    <li className="flex min-w-0 gap-3 border-b border-border/30 py-3 last:border-b-0">
      <SimpleCheckCircle checked={completed} interactive={false} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className={completed ? "text-sm text-muted-foreground line-through" : "text-sm font-medium text-foreground"}>
          {task.title}
        </div>
        {task.description ? <p className="mt-1 text-sm leading-6 text-muted-foreground">{task.description}</p> : null}
      </div>
      {deadline ? <span className="shrink-0 text-xs text-muted-foreground">{deadline}</span> : null}
    </li>
  );
}

export default function RecipientRecapPage({ token }: { token: string }) {
  const endpoint = `/api/public/meeting-recaps/${encodeURIComponent(token)}`;
  const query = useQuery<RecipientRecapProjectionResponse>({
    queryKey: [endpoint],
    queryFn: getQueryFn({ on401: "throw" }),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  if (query.isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading recap" />
      </main>
    );
  }
  if (query.isError || !query.data) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <p className="text-sm text-muted-foreground">This recap is unavailable.</p>
      </main>
    );
  }

  const { projection } = query.data;
  const meetingDate = formatMeetingDate(projection.startedAt);
  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-8">
      <article className="mx-auto w-full max-w-3xl space-y-8">
        <header className="space-y-2 border-b border-border/30 pb-6">
          <p className="text-sm font-medium text-muted-foreground">Mantra meeting recap</p>
          <h1 className="text-xl font-semibold text-foreground">{projection.meetingTitle}</h1>
          {meetingDate ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <CalendarDays className="h-3.5 w-3.5" />
              <span>{meetingDate}</span>
            </div>
          ) : null}
        </header>

        {projection.recap.summary ? (
          <section>
            <p className="whitespace-pre-wrap text-sm leading-7 text-foreground">{projection.recap.summary}</p>
          </section>
        ) : null}

        <RecapList title="Key decisions" items={projection.recap.decisions} />
        <RecapList title="Open questions" items={projection.recap.openQuestions} />
        <RecapList title="Action items" items={projection.recap.actionItems} />

        {projection.tasks.length > 0 ? (
          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">Assigned to you</h2>
            <ul>{projection.tasks.map((task, index) => <RecipientTaskRow key={`${task.title}-${index}`} task={task} />)}</ul>
          </section>
        ) : null}
      </article>
    </main>
  );
}
