// Memory-graph force layout, computed off the main thread.
//
// The main thread owns rendering, interaction, and picking; this worker owns only the
// d3-force-3d simulation. It receives a slim node/link snapshot, ticks the simulation
// manually (no rAF in a worker), and streams back a transferable Float32Array of
// [x, y, z] positions as fast as the solve budget allows. The main thread glides
// between posts on the render clock. Cadence is budgeted, not fixed: a slow solve
// schedules the next step immediately instead of stacking a dead wait on top of it.

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
  // One integration step per frame. Doubling ticks per post was buying convergence rate
  // by spending the whole frame budget twice — on large graphs that dropped the post
  // cadence into the teens and produced visible stutter-steps between solves.
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
    // ~520 single-tick frames to settle. At a 60 Hz physics clock that is ~8.7s of
    // continuous motion — same wall-clock settle as the old 2-ticks-per-33ms loop.
    .alphaDecay(1 - Math.pow(0.002, 1 / 520))
    .velocityDecay(0.3)
    .stop();

  postPositions(false);
  scheduleNext(0);
}

ctx.onmessage = (event: MessageEvent) => {
  const data = event.data as { type?: string } | null;
  if (!data) return;
  if (data.type === "init") start(data as InitMessage);
  else if (data.type === "stop") stop();
};
