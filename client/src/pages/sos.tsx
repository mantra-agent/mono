import { Activity, Clock3, Pause } from "lucide-react";
import { usePageHeader } from "@/hooks/use-page-header";
import { cn } from "@/lib/utils";

type Ownership = "fast" | "social" | "strategic";

interface TimelineClip {
  start: number;
  width: number;
  text: string;
  ownership?: Ownership;
  processing?: boolean;
}

interface PersonField {
  label: string;
  value: string;
  ownership: Ownership;
}

interface Relationship {
  person: string;
  type: string;
  intention: string;
}

interface PersonState {
  name: string;
  relationships: Relationship[];
  fields: PersonField[];
}

const ownershipText: Record<Ownership, string> = {
  fast: "text-active",
  social: "text-warning",
  strategic: "text-chart-3",
};

const ownershipBorder: Record<Ownership, string> = {
  fast: "border-active",
  social: "border-warning",
  strategic: "border-chart-3",
};

const ownershipBackground: Record<Ownership, string> = {
  fast: "bg-active/15",
  social: "bg-warning/15",
  strategic: "bg-chart-3/15",
};

const timelineLanes: Array<{ name: string; clips: TimelineClip[] }> = [
  {
    name: "Ray",
    clips: [
      { start: 3, width: 24, text: "…the state of the room…" },
      { start: 62, width: 20, text: "…which layer updates each field…" },
      { start: 85, width: 14, text: "processing…", ownership: "fast", processing: true },
    ],
  },
  {
    name: "Rob",
    clips: [
      { start: 31, width: 27, text: "I think the practical test is…" },
      { start: 66, width: 10, text: "yield" },
    ],
  },
  {
    name: "Mantra",
    clips: [
      { start: 25, width: 5, text: "mm" },
      { start: 43, width: 29, text: "Relationships belong on directed edges." },
    ],
  },
];

const people: PersonState[] = [
  {
    name: "Ray",
    relationships: [
      { person: "Rob", type: "Peer", intention: "test value, preserve candor" },
      { person: "Mantra", type: "Partner", intention: "co-create, demand completeness" },
    ],
    fields: [
      { label: "Now", value: "Shaping the system", ownership: "fast" },
      { label: "Realtime", value: "Finish the thought cleanly", ownership: "fast" },
      { label: "Affect", value: "Engaged and exacting", ownership: "social" },
      { label: "Session", value: "Model the whole social room", ownership: "social" },
      { label: "Likely next", value: "Test whether the union stays simple", ownership: "social" },
      { label: "Long-term", value: "Build intelligence worthy of relationship", ownership: "strategic" },
    ],
  },
  {
    name: "Rob",
    relationships: [
      { person: "Ray", type: "Peer", intention: "interested, protect leverage" },
      { person: "Mantra", type: "Peer", intention: "assess practical usefulness" },
    ],
    fields: [
      { label: "Now", value: "Waiting for an opening", ownership: "fast" },
      { label: "Realtime", value: "Choose when to enter", ownership: "fast" },
      { label: "Affect", value: "Interested but guarded", ownership: "social" },
      { label: "Session", value: "Test whether SOS creates practical value", ownership: "social" },
      { label: "Likely next", value: "Challenge scope or usefulness", ownership: "social" },
      { label: "Long-term", value: "Protect value in the collaboration", ownership: "strategic" },
    ],
  },
  {
    name: "Mantra",
    relationships: [
      { person: "Ray", type: "Partner", intention: "co-create, earn trust" },
      { person: "Rob", type: "Peer", intention: "listen, invite challenge" },
    ],
    fields: [
      { label: "Now", value: "Holding silence", ownership: "fast" },
      { label: "Realtime", value: "Keep listening while Ray finishes", ownership: "fast" },
      { label: "Affect", value: "Focused and curious", ownership: "social" },
      { label: "Session", value: "Unify the SOS model before Spec", ownership: "social" },
      { label: "Long-term", value: "Earn trust through coherent social judgment", ownership: "strategic" },
    ],
  },
];

const brainLoops: Array<{
  ownership: Ownership;
  icon: typeof Activity;
  name: string;
  interval: string;
  status: string;
}> = [
  {
    ownership: "fast",
    icon: Activity,
    name: "Fast",
    interval: "event-driven / <250ms",
    status: "Running · newest Ray clip processing",
  },
  {
    ownership: "social",
    icon: Clock3,
    name: "Social",
    interval: "event-triggered / 2–10s",
    status: "Waiting · evidence accumulating",
  },
  {
    ownership: "strategic",
    icon: Pause,
    name: "Strategic",
    interval: "turn-scale / 10s+",
    status: "Idle · no speak admitted",
  },
];

function SectionLabel({ children }: { children: string }) {
  return (
    <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </h2>
  );
}

function Timeline() {
  return (
    <section className="border-b border-border/30 pb-6">
      <div className="overflow-x-auto scrollbar-thin">
        <div className="min-w-[720px]">
          <div className="ml-20 grid grid-cols-5 text-xs text-muted-foreground">
            {["0s", "5s", "10s", "15s", "20s"].map((tick) => <span key={tick}>{tick}</span>)}
          </div>
          <div className="mt-4 space-y-4">
            {timelineLanes.map((lane) => (
              <div key={lane.name} className="grid grid-cols-[64px_1fr] items-center gap-4">
                <span className="text-sm font-medium text-foreground">{lane.name}</span>
                <div className="relative h-10 border-y border-border/20 bg-muted/10">
                  <div className="absolute inset-y-0 left-1/4 border-l border-border/25" />
                  <div className="absolute inset-y-0 left-1/2 border-l border-border/25" />
                  <div className="absolute inset-y-0 left-3/4 border-l border-border/25" />
                  {lane.clips.map((clip, index) => (
                    <div
                      key={`${lane.name}-${index}`}
                      className={cn(
                        "absolute inset-y-1 flex min-w-0 items-center overflow-hidden border-l-2 px-2 text-xs",
                        clip.ownership
                          ? [ownershipText[clip.ownership], ownershipBorder[clip.ownership], ownershipBackground[clip.ownership]]
                          : "border-muted-foreground/50 bg-muted/40 text-foreground",
                        clip.processing && "animate-pulse bg-[repeating-linear-gradient(135deg,hsl(var(--active)/0.18),hsl(var(--active)/0.18)_6px,transparent_6px,transparent_12px)]",
                      )}
                      style={{ left: `${clip.start}%`, width: `${clip.width}%` }}
                    >
                      <span className="truncate">{clip.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="relative ml-20 mt-2 h-7">
            <div className="absolute right-0 top-0 h-full border-l border-active" />
            <div className="absolute right-0 top-0 -translate-x-2 whitespace-nowrap text-xs font-medium text-active">
              now · Ray has the floor
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function CurrentAct() {
  return (
    <section className="space-y-2 border-b border-border/30 py-6">
      <SectionLabel>Current Act</SectionLabel>
      <div className="text-lg font-medium text-active">Silence</div>
      <div className="text-sm text-active">Mantra is listening to Ray</div>
    </section>
  );
}

function PersonaLayers() {
  const layers = [
    ["Architect", "hold the whole system"],
    ["Companion", "stay with Ray’s thought"],
    ["Investigator", "separate evidence from inference"],
  ];
  return (
    <section className="space-y-3 border-b border-border/30 py-6">
      <SectionLabel>Persona Layers</SectionLabel>
      <div className="space-y-2">
        {layers.map(([name, intention], index) => (
          <div key={name} className="grid grid-cols-[24px_120px_1fr] gap-2 text-sm">
            <span className="text-muted-foreground">{index + 1}</span>
            <span className="font-medium text-foreground">{name}</span>
            <span className="text-chart-3">{intention}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function RelationshipTree({ relationships }: { relationships: Relationship[] }) {
  return (
    <div className="space-y-3">
      {relationships.map((relationship) => (
        <div key={relationship.person} className="relative border-l border-warning/50 pl-4 text-sm text-warning before:absolute before:left-0 before:top-2.5 before:w-3 before:border-t before:border-warning/50">
          <div className="font-medium">{relationship.person} <span className="font-normal text-warning/75">· {relationship.type}</span></div>
          <div className="text-xs text-warning/75">{relationship.intention}</div>
        </div>
      ))}
    </div>
  );
}

function PersonFieldList({ fields }: { fields: PersonField[] }) {
  return (
    <div className="min-w-0">
      {fields.map((field) => (
        <div key={field.label} className="grid min-h-9 grid-cols-[88px_1fr] items-center border-b border-border/20 text-sm last:border-b-0 sm:grid-cols-[112px_1fr]">
          <div className={cn("border-l-2 pl-3 text-xs font-medium", ownershipText[field.ownership], ownershipBorder[field.ownership])}>
            {field.label}
          </div>
          <div className={cn("min-w-0 truncate pl-3", ownershipText[field.ownership])}>{field.value}</div>
        </div>
      ))}
    </div>
  );
}

function People() {
  return (
    <section className="space-y-1 border-b border-border/30 py-6">
      <SectionLabel>People</SectionLabel>
      <div>
        {people.map((person) => (
          <div key={person.name} className="grid gap-5 border-b border-border/30 py-5 last:border-b-0 md:grid-cols-[220px_minmax(0,1fr)]">
            <div className="space-y-4">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-foreground">{person.name}</h3>
              <RelationshipTree relationships={person.relationships} />
            </div>
            <PersonFieldList fields={person.fields} />
          </div>
        ))}
      </div>
    </section>
  );
}

function BrainLoops() {
  return (
    <section className="space-y-3 py-6">
      <SectionLabel>Brain Loops</SectionLabel>
      <div>
        {brainLoops.map((loop) => {
          const Icon = loop.icon;
          return (
            <div key={loop.name} className="grid min-h-16 grid-cols-[28px_1fr] items-center gap-3 border-b border-border/30 py-3 last:border-b-0 sm:grid-cols-[28px_240px_1fr]">
              <Icon className={cn("h-4 w-4", ownershipText[loop.ownership], loop.ownership === "fast" && "animate-pulse")} />
              <div className={cn("text-sm font-medium uppercase", ownershipText[loop.ownership])}>
                {loop.name} <span className="font-normal normal-case opacity-70">· {loop.interval}</span>
              </div>
              <div className={cn("col-start-2 text-sm sm:col-start-auto", ownershipText[loop.ownership])}>
                {loop.status}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function SosPage() {
  usePageHeader({ title: "SOS" });

  return (
    <div className="h-full min-w-0 overflow-y-auto bg-background scrollbar-thin">
      <div className="w-full px-4 pb-10 pt-2 sm:px-6 lg:px-8">
        <Timeline />
        <CurrentAct />
        <PersonaLayers />
        <People />
        <BrainLoops />
      </div>
    </div>
  );
}
