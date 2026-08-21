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

const timelineLanes: Array<{ name: string; clips: TimelineClip[] }> = [
  {
    name: "Ray",
    clips: [
      { start: 1, width: 26, text: "state of the room" },
      { start: 61, width: 22, text: "which layer updates" },
      { start: 85, width: 15, text: "processing", ownership: "fast", processing: true },
    ],
  },
  {
    name: "Rob",
    clips: [
      { start: 30, width: 29, text: "the practical test" },
      { start: 67, width: 10, text: "yield" },
    ],
  },
  {
    name: "Mantra",
    clips: [
      { start: 24, width: 6, text: "mm" },
      { start: 43, width: 30, text: "relationships are edges" },
    ],
  },
];

const people: PersonState[] = [
  {
    name: "Ray",
    relationships: [
      { person: "Rob", type: "Peer", intention: "test value · preserve candor" },
      { person: "Mantra", type: "Partner", intention: "co-create · demand completeness" },
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
      { person: "Ray", type: "Peer", intention: "interested · protect leverage" },
      { person: "Mantra", type: "Peer", intention: "assess practical usefulness" },
    ],
    fields: [
      { label: "Now", value: "Waiting for an opening", ownership: "fast" },
      { label: "Realtime", value: "Choose when to enter", ownership: "fast" },
      { label: "Affect", value: "Interested but guarded", ownership: "social" },
      { label: "Session", value: "Test whether SOS creates value", ownership: "social" },
      { label: "Likely next", value: "Challenge scope or usefulness", ownership: "social" },
      { label: "Long-term", value: "Protect value in the collaboration", ownership: "strategic" },
    ],
  },
  {
    name: "Mantra",
    relationships: [
      { person: "Ray", type: "Partner", intention: "co-create · earn trust" },
      { person: "Rob", type: "Peer", intention: "listen · invite challenge" },
    ],
    fields: [
      { label: "Now", value: "Holding silence", ownership: "fast" },
      { label: "Realtime", value: "Listen while Ray finishes", ownership: "fast" },
      { label: "Affect", value: "Focused and curious", ownership: "social" },
      { label: "Session", value: "Unify the model before Spec", ownership: "social" },
      { label: "Long-term", value: "Earn trust through social judgment", ownership: "strategic" },
    ],
  },
];

const loops = [
  { ownership: "fast" as const, icon: Activity, name: "Fast", interval: "<250ms", status: "Running · Ray clip processing" },
  { ownership: "social" as const, icon: Clock3, name: "Social", interval: "2–10s", status: "Waiting · evidence accumulating" },
  { ownership: "strategic" as const, icon: Pause, name: "Strategic", interval: "10s+", status: "Idle · no speak admitted" },
];

function SectionLabel({ children }: { children: string }) {
  return <h2 className="text-[8px] font-semibold uppercase leading-none tracking-[0.14em] text-muted-foreground sm:text-[9px]">{children}</h2>;
}

function Timeline() {
  return (
    <section className="border-b border-border/30 pb-2">
      <div className="grid grid-cols-[34px_1fr] gap-x-1.5">
        <div />
        <div className="grid grid-cols-5 text-[7px] leading-none text-muted-foreground">
          {["0s", "5s", "10s", "15s", "20s"].map((tick) => <span key={tick}>{tick}</span>)}
        </div>
        {timelineLanes.map((lane) => (
          <div key={lane.name} className="contents">
            <span className="self-center text-[9px] font-medium leading-none text-foreground">{lane.name}</span>
            <div className="relative mt-1 h-[22px] border-y border-border/20 bg-muted/10">
              {[25, 50, 75].map((position) => <div key={position} className="absolute inset-y-0 border-l border-border/20" style={{ left: `${position}%` }} />)}
              {lane.clips.map((clip, index) => (
                <div
                  key={`${lane.name}-${index}`}
                  className={cn(
                    "absolute inset-y-[2px] flex min-w-0 items-center overflow-hidden border-l px-1 text-[7px] leading-none",
                    clip.ownership
                      ? [ownershipText[clip.ownership], ownershipBorder[clip.ownership], "bg-active/15"]
                      : "border-muted-foreground/50 bg-muted/40 text-foreground",
                    clip.processing && "animate-pulse",
                  )}
                  style={{ left: `${clip.start}%`, width: `${clip.width}%` }}
                >
                  <span className="truncate">{clip.text}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        <div />
        <div className="relative mt-1 h-3 border-r border-active text-right text-[7px] font-medium leading-none text-active">Ray has the floor&nbsp;</div>
      </div>
    </section>
  );
}

function CurrentAct() {
  return (
    <section className="grid grid-cols-[72px_1fr] items-center border-b border-border/30 py-2">
      <SectionLabel>Current Act</SectionLabel>
      <div className="flex items-baseline gap-2 text-active">
        <span className="text-[11px] font-semibold leading-none">Silence</span>
        <span className="text-[8px] leading-none">Mantra is listening to Ray</span>
      </div>
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
    <section className="grid grid-cols-[72px_1fr] border-b border-border/30 py-2">
      <SectionLabel>Persona Layers</SectionLabel>
      <div className="space-y-0.5">
        {layers.map(([name, intention], index) => (
          <div key={name} className="grid grid-cols-[12px_62px_1fr] gap-1 text-[8px] leading-[10px]">
            <span className="text-muted-foreground">{index + 1}</span>
            <span className="font-medium text-foreground">{name}</span>
            <span className="truncate text-chart-3">{intention}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Person({ person }: { person: PersonState }) {
  return (
    <div className="grid grid-cols-[92px_1fr] gap-2 border-b border-border/25 py-1.5 last:border-b-0">
      <div className="min-w-0">
        <h3 className="mb-1 text-[9px] font-semibold uppercase leading-none tracking-wide text-foreground">{person.name}</h3>
        <div className="space-y-1">
          {person.relationships.map((relationship) => (
            <div key={relationship.person} className="relative border-l border-warning/50 pl-2 text-[7px] leading-[8px] text-warning before:absolute before:left-0 before:top-1 before:w-1.5 before:border-t before:border-warning/50">
              <div className="truncate font-medium">{relationship.person} <span className="font-normal opacity-75">· {relationship.type}</span></div>
              <div className="truncate opacity-75">{relationship.intention}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="min-w-0">
        {person.fields.map((field) => (
          <div key={field.label} className="grid h-[13px] grid-cols-[52px_1fr] items-center text-[7px] leading-none">
            <div className={cn("border-l pl-1.5 font-medium", ownershipText[field.ownership], ownershipBorder[field.ownership])}>{field.label}</div>
            <div className={cn("truncate pl-1.5", ownershipText[field.ownership])}>{field.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function People() {
  return (
    <section className="border-b border-border/30 py-2">
      <SectionLabel>People</SectionLabel>
      <div className="mt-1">{people.map((person) => <Person key={person.name} person={person} />)}</div>
    </section>
  );
}

function BrainLoops() {
  return (
    <section className="py-2">
      <SectionLabel>Brain Loops</SectionLabel>
      <div className="mt-1 grid gap-0.5">
        {loops.map((loop) => {
          const Icon = loop.icon;
          return (
            <div key={loop.name} className="grid h-[16px] grid-cols-[14px_76px_1fr] items-center border-b border-border/20 text-[8px] last:border-b-0">
              <Icon className={cn("h-2.5 w-2.5", ownershipText[loop.ownership], loop.ownership === "fast" && "animate-pulse")} />
              <div className={cn("font-medium uppercase", ownershipText[loop.ownership])}>{loop.name} <span className="font-normal normal-case opacity-70">· {loop.interval}</span></div>
              <div className={cn("truncate", ownershipText[loop.ownership])}>{loop.status}</div>
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
    <div className="h-full min-w-0 overflow-hidden bg-background">
      <div className="w-full px-2 py-1 sm:px-4">
        <Timeline />
        <CurrentAct />
        <PersonaLayers />
        <People />
        <BrainLoops />
      </div>
    </div>
  );
}
