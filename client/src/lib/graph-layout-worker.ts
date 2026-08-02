// Memory-graph force layout, computed off the main thread.
//
// The main thread owns rendering, interaction, and picking; this worker owns only the
// d3-force-3d simulation. It receives a slim node/link snapshot, ticks the simulation
// manually (no rAF in a worker), and streams back a transferable Float32Array of
// [x, y, z] positions at a bounded cadence. The main thread copies positions into its
// scene nodes and renders. Bounded posts keep the transport quiet after convergence.

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

const POST_INTERVAL_MS = 33; // ~30 position frames/sec — bounded main-thread updates.

let simulation: Simulation<LayoutNode> | null = null;
let nodes: LayoutNode[] = [];
let tickTimer: ReturnType<typeof setTimeout> | null = null;
let lastPostAt = 0;
let activeRevision = 0;

function stop() {
  if (tickTimer !== null) {
    clearTimeout(tickTimer);
    tickTimer = null;
  }
  simulation?.stop();
  simulation = null;
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

function step() {
  const sim = simulation;
  if (!sim) return;
  // Two integration ticks per frame converge faster while keeping post cadence bounded.
  sim.tick();
  sim.tick();
  const now = Date.now();
  const settled = sim.alpha() <= sim.alphaMin();
  if (settled) {
    postPositions(true);
    stop();
    return;
  }
  if (now - lastPostAt >= POST_INTERVAL_MS) {
    lastPostAt = now;
    postPositions(false);
  }
  tickTimer = setTimeout(step, POST_INTERVAL_MS);
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
      .theta(0.76)
      .distanceMin(2)
      .distanceMax(520))
    .force("links", linkForce)
    .force("collision", forceCollide<LayoutNode>((node) => node.radius + 8).strength(0.88).iterations(1))
    .force("x", forceX<LayoutNode>(0).strength(0.0015))
    .force("y", forceY<LayoutNode>(0).strength(0.0015))
    .force("z", forceZ<LayoutNode>(0).strength(0.0015))
    .alphaMin(0.002)
    .alphaDecay(1 - Math.pow(0.002, 1 / 520))
    .velocityDecay(0.3)
    .stop();

  lastPostAt = 0;
  postPositions(false);
  tickTimer = setTimeout(step, POST_INTERVAL_MS);
}

ctx.onmessage = (event: MessageEvent) => {
  const data = event.data as { type?: string } | null;
  if (!data) return;
  if (data.type === "init") start(data as InitMessage);
  else if (data.type === "stop") stop();
};
