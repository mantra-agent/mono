// Memory-graph force layout, computed off the main thread.
//
// The main thread owns rendering, interaction, and picking; this worker owns only the
// d3-force-3d simulation. It receives a slim node/link snapshot, ticks the simulation
// manually (no rAF in a worker), and streams back a transferable Float32Array of
// [x, y, z] positions as fast as the solve budget allows. The main thread glides
// between posts on the render clock. Cadence is budgeted, not fixed: a slow solve
// schedules the next step immediately instead of stacking a dead wait on top of it.
//
// Visual admission contract: the first post is delayed until a silent prestabilize
// burst finishes, so the main thread never admits a cold random cloud. Streaming
// posts then continue at ~60 Hz until alpha settles; the final `end` post is the
// rest signal the renderer uses to admit nodes and open labels.

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  forceZ,
  type Simulation,
} from "./d3-force-3d";

interface LayoutNode {
  id: number;
  degree: number;
  radius: number;
  x: number;
  y: number;
  z: number;
}

interface LayoutLinkInput {
  id: number;
  fromId: number;
  toId: number;
  strength: number;
}

interface SimLink extends LayoutLinkInput {
  source: LayoutNode | number;
  target: LayoutNode | number;
  index?: number;
}

interface LayoutSettings {
  linkAttractionFactor: number;
  nodeRepulsionFactor: number;
}

interface InitMessage {
  type: "init";
  revision: number;
  nodes: LayoutNode[];
  links: LayoutLinkInput[];
  settings: LayoutSettings;
}

const ctx = self as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent) => void) | null;
};

// Target one physics frame per display frame. When a solve finishes under budget the
// remainder becomes the delay; when it overruns, delay is 0 so the loop runs as fast
// as the CPU allows instead of adding a fixed post-interval on top of the overrun.
const TARGET_FRAME_MS = 1000 / 60;

// Silent multi-tick burst before the first post. Large graphs need more free ticks to
// leave the random cloud; small graphs settle enough in fewer. Cap wall time so the
// first paint never waits on a pathological solve.
const PRESTABILIZE_TICKS_SMALL = 36;
const PRESTABILIZE_TICKS_MEDIUM = 56;
const PRESTABILIZE_TICKS_LARGE = 80;
const PRESTABILIZE_TICKS_XLARGE = 110;
const PRESTABILIZE_BUDGET_MS = 220;

// Admit only once residual motion is imperceptible. Below this alpha, per-frame
// displacement is sub-pixel at normal zoom, so the graph reads as already-still on
// first paint instead of crawling into place after admission. Graphs too large to
// reach it inside the wall-clock budget degrade gracefully to live streaming.
const VISIBLE_SETTLE_ALPHA = 0.06;
const PRESTABILIZE_MAX_TICKS = 600;

let simulation: Simulation<LayoutNode> | null = null;
let nodes: LayoutNode[] = [];
let tickTimer: ReturnType<typeof setTimeout> | null = null;
let activeRevision = 0;

function stop() {
  if (tickTimer !== null) {
    clearTimeout(tickTimer);
    tickTimer = null;
  }
  simulation?.stop();
  simulation = null;
}

// Barnes-Hut + distance cutoffs scale with N. Large graphs pay O(N log N) per tick;
// coarser theta and a tighter distanceMax buy framerate without changing the forces'
// qualitative structure (local repulsion + short-range structure still dominate).
function chargeParams(nodeCount: number): { theta: number; distanceMax: number } {
  if (nodeCount > 900) return { theta: 1.25, distanceMax: 260 };
  if (nodeCount > 500) return { theta: 1.1, distanceMax: 320 };
  if (nodeCount > 250) return { theta: 0.95, distanceMax: 400 };
  return { theta: 0.85, distanceMax: 480 };
}

function prestabilizeTicks(nodeCount: number): number {
  if (nodeCount > 900) return PRESTABILIZE_TICKS_XLARGE;
  if (nodeCount > 500) return PRESTABILIZE_TICKS_LARGE;
  if (nodeCount > 250) return PRESTABILIZE_TICKS_MEDIUM;
  return PRESTABILIZE_TICKS_SMALL;
}

function postPositions(final: boolean) {
  const positions = new Float32Array(nodes.length * 3);
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    positions[index * 3] = node.x;
    positions[index * 3 + 1] = node.y;
    positions[index * 3 + 2] = node.z;
  }
  ctx.postMessage({ type: final ? "end" : "positions", revision: activeRevision, positions }, [positions.buffer]);
}

function scheduleNext(elapsedMs: number) {
  const delay = Math.max(0, TARGET_FRAME_MS - elapsedMs);
  tickTimer = setTimeout(step, delay);
}

function step() {
  const sim = simulation;
  if (!sim) return;

  const startedAt = performance.now();
  // One integration step per frame after prestabilize. Doubling ticks per post was
  // buying convergence by spending the whole frame budget twice — on large graphs
  // that dropped the post cadence into the teens and produced visible stutter.
  sim.tick(1);

  const settled = sim.alpha() <= sim.alphaMin();
  if (settled) {
    postPositions(true);
    stop();
    return;
  }

  // Post every physics frame. At ~60 Hz the transferable payload is small and the
  // render-side linear segments stay short enough that motion reads continuous.
  postPositions(false);
  scheduleNext(performance.now() - startedAt);
}

function prestabilize(sim: Simulation<LayoutNode>, nodeCount: number) {
  const minTicks = prestabilizeTicks(nodeCount);
  const startedAt = performance.now();
  for (let index = 0; index < PRESTABILIZE_MAX_TICKS; index += 1) {
    if (sim.alpha() <= sim.alphaMin()) break;
    sim.tick(1);
    // Floor first (always leave the random cloud), then keep ticking silently until
    // the graph is visually at rest or the wall-clock budget is spent. This moves
    // convergence off-screen so admission reveals an already-settled graph.
    const settledEnough = index + 1 >= minTicks && sim.alpha() <= VISIBLE_SETTLE_ALPHA;
    if (settledEnough) break;
    if (performance.now() - startedAt >= PRESTABILIZE_BUDGET_MS) break;
  }
}

function start(message: InitMessage) {
  stop();
  activeRevision = message.revision;
  nodes = message.nodes.map((node) => ({ ...node }));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const links: SimLink[] = message.links
    .filter((link) => nodeById.has(link.fromId) && nodeById.has(link.toId))
    .map((link) => ({ ...link, source: link.fromId, target: link.toId }));

  const linkAttraction = message.settings.linkAttractionFactor;
  const nodeRepulsion = message.settings.nodeRepulsionFactor;
  const { theta, distanceMax } = chargeParams(nodes.length);
  const linkForce = forceLink<LayoutNode, SimLink>(links)
    .id((node) => node.id)
    .distance((link) => {
      const from = link.source as LayoutNode;
      const to = link.target as LayoutNode;
      const strength = Math.max(0.1, link.strength || 0.5);
      return from.radius + to.radius + 38 + (1 - strength) * 62;
    })
    .strength((link) => (0.08 + Math.max(0.1, link.strength || 0.5) * 0.12) * linkAttraction)
    .iterations(1);

  simulation = forceSimulation(nodes, 3)
    .force("charge", forceManyBody<LayoutNode>()
      .strength((node) => -(135 + Math.sqrt(node.degree) * 9) * nodeRepulsion)
      .theta(theta)
      .distanceMin(2)
      .distanceMax(distanceMax))
    .force("links", linkForce)
    .force("collision", forceCollide<LayoutNode>((node) => node.radius + 8).strength(0.88).iterations(1))
    .force("x", forceX<LayoutNode>(0).strength(0.0015))
    .force("y", forceY<LayoutNode>(0).strength(0.0015))
    .force("z", forceZ<LayoutNode>(0).strength(0.0015))
    .alphaMin(0.002)
    // ~240 single-tick frames to fully settle (~4s at 60 Hz). Prestabilize now spends
    // the silent budget driving alpha below VISIBLE_SETTLE_ALPHA before admission, so
    // for graphs that fit the budget the remaining on-screen motion is negligible.
    .alphaDecay(1 - Math.pow(0.002, 1 / 240))
    // Damp harder than d3's 0.4 default so residual motion stops undulating instead of
    // springing around equilibrium after the graph is roughly placed.
    .velocityDecay(0.45)
    .stop();

  // Silent burst: leave the random cloud before the main thread ever paints nodes.
  prestabilize(simulation, nodes.length);

  if (simulation.alpha() <= simulation.alphaMin()) {
    postPositions(true);
    stop();
    return;
  }

  postPositions(false);
  scheduleNext(0);
}

ctx.onmessage = (event: MessageEvent) => {
  const data = event.data as { type?: string } | null;
  if (!data) return;
  if (data.type === "init") start(data as InitMessage);
  else if (data.type === "stop") stop();
};
