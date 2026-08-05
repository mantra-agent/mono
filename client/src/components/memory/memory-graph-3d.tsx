import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  forceZ,
  type Simulation,
} from "@/lib/d3-force-3d";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { MemorySourceIcon } from "@/components/memory/memory-source-icon";
import { recordBrowserTelemetry } from "@/lib/browser-telemetry";
import {
  MEMORY_GRAPH_SETTING_DEFINITIONS,
  type MemoryGraphSettings,
} from "@shared/memory-graph-settings";

export interface MemoryGraph3DNode {
  id: number;
  source: string;
  label: string;
  degree: number;
  /** Recency heat in (0, 1]: 1 = just created/recalled, approaching 0 = cold. Drives node color + fade. */
  recency: number;
  pendingDeletion: boolean;
}

export interface MemoryGraph3DLink {
  id: number;
  fromId: number;
  toId: number;
  relationship: string;
  strength: number;
}

export interface MemoryGraph3DHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  fitToView: () => void;
}

export interface MemoryGraph3DNodeDetail {
  nodeId: number;
  content: ReactNode;
  interactive: boolean;
}

interface MemoryGraph3DProps {
  nodes: MemoryGraph3DNode[];
  links: MemoryGraph3DLink[];
  selectedNodeId: number | null;
  highlightedNodeIds: ReadonlySet<number>;
  activityEnabled: boolean;
  settings: MemoryGraphSettings;
  visibleNodeIds: ReadonlySet<number>;
  nodeDetail?: MemoryGraph3DNodeDetail | null;
  onNodeSelect: (nodeId: number) => void;
  onNodeHover: (nodeId: number | null) => void;
  onBackgroundSelect?: () => void;
}

interface SceneNode extends MemoryGraph3DNode {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  radius: number;
}

interface SceneLink extends MemoryGraph3DLink {
  source: number | SceneNode;
  target: number | SceneNode;
  fromIndex: number;
  toIndex: number;
  linkIndex: number;
}

interface ProjectedLabel {
  node: SceneNode;
  x: number;
  y: number;
  distance: number;
}

interface ActivityPath {
  linkIndex: number;
  sourceIndex: number;
  destinationIndex: number;
  destinationRecency: number;
}

interface ActivityPacket extends ActivityPath {
  startedAt: number;
}

interface ActivityImpact {
  nodeIndex: number;
  startedAt: number;
}

interface QuadraticLinkPath {
  fromX: number;
  fromY: number;
  fromZ: number;
  controlX: number;
  controlY: number;
  controlZ: number;
  toX: number;
  toY: number;
  toZ: number;
}

interface LinkRenderCandidate {
  linkIndex: number;
  segmentCount: number;
  arcScale: number;
  priority: number;
}

interface GraphAdjacency {
  neighborsByNodeId: Map<number, Set<number>>;
  simulationLinksByNodeId: Map<number, SceneLink[]>;
}

interface GraphRuntime {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  nodes: SceneNode[];
  requestRender: () => void;
  refreshAppearance: () => void;
  setActivityEnabled: (enabled: boolean) => void;
  setSelectedNodeId: (nodeId: number | null) => void;
  updateSettings: (settings: MemoryGraphSettings) => void;
  updateVisibleNodeIds: (nodeIds: ReadonlySet<number>) => void;
}

const MAX_RENDERED_LINKS = 12_000;
const MAX_RENDERED_LINK_SEGMENTS = 30_000;
const LINK_FRUSTUM_MARGIN = 0.12;
const LINK_FULL_DETAIL_RADIUS_PX = 7;
const LINK_MEDIUM_DETAIL_RADIUS_PX = 2;
const MAX_LINK_COMPLEXITY = MEMORY_GRAPH_SETTING_DEFINITIONS.find(
  (definition) => definition.key === "linkComplexity",
)?.max ?? 12;
const LARGE_GRAPH_THRESHOLD = 1_000;
const LABEL_POSITION_TICKS = 4;
const INITIAL_LAYOUT_SCALE = 20;
// Linear inter-post glide while the solver is streaming. The layout worker posts
// full-graph solves on a budgeted ~60 Hz physics clock (slower only when a single
// tick overruns the frame). Snapping every node to each post made motion lurch;
// exponential ease-to-target made it ramp-to-stop-then-jump. Instead, capture each
// post as a segment endpoint and lerp displayed positions at constant velocity
// across the measured inter-post interval so motion reads continuous on the render
// clock even when physics briefly dips. The final `end` segment eases out so the
// graph settles instead of slamming into the last solve.
const LAYOUT_INTERP_DEFAULT_MS = 16;
const LAYOUT_INTERP_MIN_MS = 8;
const LAYOUT_INTERP_MAX_MS = 48;
const LAYOUT_FINAL_SEGMENT_MS = 280;
const MIN_NODE_HIT_RADIUS_PX = 12;
const NODE_RENDER_ORDER = 0;
const RESTING_LINK_RENDER_ORDER = 1;
const FOCUSED_LINK_RENDER_ORDER = 2;
const ACTIVITY_RENDER_ORDER = 3;
const ACTIVITY_RECENCY_THRESHOLD = 0.25;
const ACTIVITY_PACKET_BEADS = 5;
const ACTIVITY_PACKET_DURATION_MS = 1_150;
const ACTIVITY_IMPACT_DURATION_MS = 520;
const ACTIVITY_IMPACT_HOLD_RATIO = 0.18;
// Each traversal/arrival deposits bounded energy into the existing graph visuals.
// Exponential decay keeps the network briefly legible after a pulse passes, while
// additive deposits let genuinely busy paths stay brighter without washing out
// hover/selection or growing unbounded.
const ACTIVITY_AFTERGLOW_HALF_LIFE_MS = 2_600;
const ACTIVITY_AFTERGLOW_EPSILON = 0.004;
const ACTIVITY_LINK_AFTERGLOW_DEPOSIT = 0.18;
const ACTIVITY_LINK_AFTERGLOW_CEILING = 1;
const ACTIVITY_LINK_LUMINANCE_RESPONSE = 1.35;
const ACTIVITY_LINK_MAX_LUMINANCE = 0.88;
const RESTING_LINK_MIN_LUMINANCE = 0.48;
const RESTING_LINK_MAX_LUMINANCE = 0.72;
const FOCUSED_LINK_MIN_LUMINANCE = 0.58;
const FOCUSED_LINK_MAX_LUMINANCE = 0.82;
const ACTIVITY_NODE_AFTERGLOW_DEPOSIT = 0.2;
const ACTIVITY_NODE_AFTERGLOW_CEILING = 0.75;
// Global emission runs ~10x faster than before; a tight max clamp removes the
// dead-air gaps that made the field look intermittently idle.
const ACTIVITY_MEAN_EMIT_GAP_MS = 17;
const ACTIVITY_MIN_EMIT_GAP_MS = 10;
const ACTIVITY_MAX_EMIT_GAP_MS = 160;
const ACTIVITY_RETRY_GAP_MS = 60;
// Pulse Rate is a density control, not absolute throughput. Emission scales with
// visible node count so a small graph keeps the same calm per-node feel as a large
// one. Reference matches a full-size memory graph (~2k nodes); rate 1.0 there is
// the historical baseline cadence.
const ACTIVITY_PULSE_RATE_NODE_REFERENCE = 2_000;
// Hot nodes recycle quickly so traffic concentrates where recency is high; cold
// nodes stay eligible but rarely selected, leaving a faint scattered background.
const ACTIVITY_MIN_NODE_COOLDOWN_MS = 220;
const ACTIVITY_MAX_NODE_COOLDOWN_MS = 4_000;
// Destination selection probability scales with recency to this power, sharpening
// concentration so pulse density visibly tracks node brightness (recency^2.2).
const ACTIVITY_RECENCY_WEIGHT_EXPONENT = 3;
const ACTIVITY_MAX_DESKTOP_PACKETS = 90;
const ACTIVITY_MAX_MOBILE_PACKETS = 24;
const ACTIVITY_MOBILE_BREAKPOINT_PX = 768;
const ACTIVITY_BEAD_SPACING = 0.035;
const ACTIVITY_BEAD_BASE_RADIUS = 1.1;
// Cold claims never disappear entirely: they hold a faint floor so the field keeps its ghosts.
// Recency → opacity is a gentle high-ceiling curve. The most recent nodes/links
// settle near the ceiling (deliberately below 1 so hover/selection still reads as
// brighter), while the oldest keep a clearly visible floor instead of dropping to
// near-invisible. Recency differences stay legible without the field going dark.
const RECENCY_OPACITY_FLOOR = 0.22;

function recencyToVisibility(recency: number, brightnessCeiling: number): number {
  const heat = THREE.MathUtils.clamp(recency, 0, 1);
  const ceiling = THREE.MathUtils.clamp(brightnessCeiling, RECENCY_OPACITY_FLOOR, 1);
  return RECENCY_OPACITY_FLOOR + (ceiling - RECENCY_OPACITY_FLOOR) * Math.pow(heat, 1.4);
}

function recencyToWhiteMix(recency: number, brightnessCeiling: number): number {
  const heat = THREE.MathUtils.smoothstep(THREE.MathUtils.clamp(recency, 0, 1), 0.08, 1);
  const ceiling = THREE.MathUtils.clamp(brightnessCeiling, RECENCY_OPACITY_FLOOR, 1);
  return Math.pow(heat, 1.15) * ceiling;
}

function composeActivityColor(
  target: THREE.Color,
  restingColor: THREE.Color,
  luminanceColor: THREE.Color,
  energy: number,
  brightness = 1,
) {
  target.copy(restingColor).lerp(luminanceColor, THREE.MathUtils.clamp(energy, 0, 1));
  target.multiplyScalar(brightness);
}

const GRAPH_LABEL_MAX_WORDS = 3;

// Keep on-graph labels scannable: Page/Session titles can be long, so the visible
// overlay label is capped at a few words with an ellipsis. The full title stays in
// the hover tooltip and the selected-node detail panel.
function truncateLabelToWords(label: string, maxWords = GRAPH_LABEL_MAX_WORDS): string {
  const words = label.trim().split(/\s+/);
  if (words.length <= maxWords) return label;
  return `${words.slice(0, maxWords).join(" ")}…`;
}

const nodeVertexShader = `
  attribute float aVisibility;
  attribute float aEmphasis;
  attribute float aImpact;
  attribute vec3 aTint;
  varying vec3 vNormal;
  varying vec3 vViewDirection;
  varying vec3 vTint;
  varying float vVisibility;
  varying float vEmphasis;
  varying float vImpact;

  void main() {
    vec4 worldPosition = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vNormal = normalize(mat3(modelMatrix * instanceMatrix) * normal);
    vViewDirection = normalize(cameraPosition - worldPosition.xyz);
    vTint = aTint;
    vVisibility = aVisibility;
    vEmphasis = aEmphasis;
    vImpact = aImpact;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const nodeFragmentShader = `
  uniform float uNodeBrightness;
  uniform float uPulseBrightness;
  varying vec3 vNormal;
  varying vec3 vViewDirection;
  varying vec3 vTint;
  varying float vVisibility;
  varying float vEmphasis;
  varying float vImpact;

  void main() {
    float facing = abs(dot(normalize(vNormal), normalize(vViewDirection)));
    float edge = 1.0 - facing;
    float pulse = clamp(vImpact, 0.0, 1.0);
    float pulseIllumination = pulse * uPulseBrightness;
    // The hovered/selected node carries emphasis 1.0 (neighbors stay below 0.85). Give
    // it the same treatment a pulse gets — flatten the rim ramp, whiten the tint, and
    // force full opacity — so focus reads as a solid white ball, not a bright rim.
    float focus = smoothstep(0.85, 1.0, vEmphasis);
    float illumination = max(pulseIllumination, focus);
    float rampExponent = mix(1.6, 0.0, clamp(illumination, 0.0, 1.0));
    float luminanceRamp = pow(max(edge, 0.0001), rampExponent);
    float emphasis = 1.0 + vEmphasis * 0.5;
    float pulseGain = 1.0 + max(pulseIllumination, focus * 0.85) * 0.85;
    vec3 tintBase = mix(vTint, vec3(1.0), focus);
    vec3 pulseTint = mix(tintBase, vec3(1.0), pulse);
    vec3 nodeColor = pulseTint * luminanceRamp * emphasis * pulseGain;
    float nodeAlpha = mix(vVisibility, 1.0, clamp(illumination, 0.0, 1.0));
    gl_FragColor = vec4(nodeColor * uNodeBrightness, nodeAlpha);
  }
`;

function colorFromToken(token: string): THREE.Color {
  const rootStyles = getComputedStyle(document.documentElement);
  const raw = rootStyles.getPropertyValue(token).trim();
  const fallback = rootStyles.getPropertyValue("--foreground").trim() || getComputedStyle(document.body).color;
  const value = raw || fallback;
  // Tailwind stores HSL as "217 91% 60%" — THREE.Color needs comma-separated "hsl(h, s%, l%)"
  const hslMatch = value.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  if (hslMatch) {
    const c = new THREE.Color();
    c.setHSL(parseFloat(hslMatch[1]) / 360, parseFloat(hslMatch[2]) / 100, parseFloat(hslMatch[3]) / 100);
    return c;
  }
  // Fallback: try direct CSS parse (hex, rgb, named, etc.)
  try { return new THREE.Color(value.startsWith("rgb") ? value : `hsl(${value})`); }
  catch { return new THREE.Color(0x3b82f6); }
}

function seededUnit(id: number, salt: number): number {
  const value = Math.sin(id * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function createInitialPosition(nodeId: number, index: number, count: number): [number, number, number] {
  const radius = INITIAL_LAYOUT_SCALE * Math.cbrt(0.5 + index);
  const roll = index * Math.PI * (3 - Math.sqrt(5));
  const yaw = index * Math.PI * 20 / (9 + Math.sqrt(221));
  const jitter = 0.82 + seededUnit(nodeId, 2) * 0.36;
  return [
    radius * Math.sin(roll) * Math.cos(yaw) * jitter,
    radius * Math.cos(roll) * jitter,
    radius * Math.sin(roll) * Math.sin(yaw) * jitter,
  ];
}

function buildGraphAdjacency(sceneNodes: SceneNode[], simulationLinks: SceneLink[]): GraphAdjacency {
  const neighborsByNodeId = new Map(sceneNodes.map((node) => [node.id, new Set<number>()]));
  const simulationLinksByNodeId = new Map(sceneNodes.map((node) => [node.id, [] as SceneLink[]]));
  simulationLinks.forEach((link) => {
    neighborsByNodeId.get(link.fromId)?.add(link.toId);
    neighborsByNodeId.get(link.toId)?.add(link.fromId);
    simulationLinksByNodeId.get(link.fromId)?.push(link);
    simulationLinksByNodeId.get(link.toId)?.push(link);
  });
  return { neighborsByNodeId, simulationLinksByNodeId };
}

function buildSceneGraph(
  nodes: MemoryGraph3DNode[],
  links: MemoryGraph3DLink[],
  settings: MemoryGraphSettings,
) {
  const degrees = nodes.map((node) => node.degree);
  const minDegree = Math.min(...degrees);
  const maxDegree = Math.max(...degrees);
  const degreeRange = Math.max(1, maxDegree - minDegree);
  const sceneNodes: SceneNode[] = nodes.map((node, index) => {
    const [x, y, z] = createInitialPosition(node.id, index, nodes.length);
    const degreeRatio = (node.degree - minDegree) / degreeRange;
    return {
      ...node,
      x,
      y,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      radius: settings.smallestNode
        + Math.pow(degreeRatio, 0.6) * (settings.largestNode - settings.smallestNode),
    };
  });
  const nodeIndex = new Map(sceneNodes.map((node, index) => [node.id, index]));
  const simulationLinks = links.flatMap((link): SceneLink[] => {
    const fromIndex = nodeIndex.get(link.fromId);
    const toIndex = nodeIndex.get(link.toId);
    if (fromIndex == null || toIndex == null || fromIndex === toIndex) return [];
    return [{
      ...link,
      source: link.fromId,
      target: link.toId,
      fromIndex,
      toIndex,
      linkIndex: 0,
    }];
  });
  simulationLinks.forEach((link, linkIndex) => {
    link.linkIndex = linkIndex;
  });
  const adjacency = buildGraphAdjacency(sceneNodes, simulationLinks);
  return { sceneNodes, simulationLinks, nodeIndex, adjacency };
}

function syncCameraClippingPlanes(camera: THREE.PerspectiveCamera, target: THREE.Vector3) {
  const cameraDistance = camera.position.distanceTo(target);
  camera.near = Math.max(0.1, cameraDistance / 100_000);
  camera.far = Math.max(800, cameraDistance * 4);
  camera.updateProjectionMatrix();
}

function fitCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls, nodes: SceneNode[], paddingFactor = 1.16) {
  if (nodes.length === 0) return;
  const bounds = new THREE.Box3();
  let maxNodeRadius = 0;
  nodes.forEach((node) => {
    bounds.expandByPoint(new THREE.Vector3(node.x, node.y, node.z));
    maxNodeRadius = Math.max(maxNodeRadius, node.radius);
  });
  bounds.expandByScalar(maxNodeRadius);
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const distance = Math.max(30, sphere.radius / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * paddingFactor);
  const direction = camera.position.clone().sub(controls.target).normalize();
  if (direction.lengthSq() === 0) direction.set(0.62, 0.36, 1);
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).add(direction.multiplyScalar(distance));
  syncCameraClippingPlanes(camera, controls.target);
  controls.update();
}

function writeQuadraticPoint(
  positions: Float32Array,
  offset: number,
  fromX: number,
  fromY: number,
  fromZ: number,
  controlX: number,
  controlY: number,
  controlZ: number,
  toX: number,
  toY: number,
  toZ: number,
  progress: number,
) {
  const inverse = 1 - progress;
  positions[offset] = inverse * inverse * fromX + 2 * inverse * progress * controlX + progress * progress * toX;
  positions[offset + 1] = inverse * inverse * fromY + 2 * inverse * progress * controlY + progress * progress * toY;
  positions[offset + 2] = inverse * inverse * fromZ + 2 * inverse * progress * controlZ + progress * progress * toZ;
}

function setQuadraticPoint(target: THREE.Vector3, path: QuadraticLinkPath, progress: number) {
  const clampedProgress = THREE.MathUtils.clamp(progress, 0, 1);
  const inverse = 1 - clampedProgress;
  target.set(
    inverse * inverse * path.fromX + 2 * inverse * clampedProgress * path.controlX + clampedProgress * clampedProgress * path.toX,
    inverse * inverse * path.fromY + 2 * inverse * clampedProgress * path.controlY + clampedProgress * clampedProgress * path.toY,
    inverse * inverse * path.fromZ + 2 * inverse * clampedProgress * path.controlZ + clampedProgress * clampedProgress * path.toZ,
  );
}

function weightedActivityPath(paths: ActivityPath[]): ActivityPath | null {
  const pathsByDestination = new Map<number, ActivityPath[]>();
  paths.forEach((path) => {
    const destinationPaths = pathsByDestination.get(path.destinationIndex) ?? [];
    destinationPaths.push(path);
    pathsByDestination.set(path.destinationIndex, destinationPaths);
  });
  const destinations = [...pathsByDestination.values()];
  const totalWeight = destinations.reduce(
    (total, destinationPaths) => total + destinationPaths[0].destinationRecency ** ACTIVITY_RECENCY_WEIGHT_EXPONENT,
    0,
  );
  if (totalWeight <= 0) return null;
  let roll = Math.random() * totalWeight;
  for (const destinationPaths of destinations) {
    roll -= destinationPaths[0].destinationRecency ** ACTIVITY_RECENCY_WEIGHT_EXPONENT;
    if (roll <= 0) {
      return destinationPaths[Math.floor(Math.random() * destinationPaths.length)] ?? null;
    }
  }
  const fallbackPaths = destinations.at(-1);
  return fallbackPaths?.[Math.floor(Math.random() * fallbackPaths.length)] ?? null;
}

// Continuous Poisson emission scaled by visible graph size: exponential inter-arrival
// spacing keeps the stream organic rather than metronomic. Pulse Rate sets per-node
// density; absolute packet throughput rises and falls with visibleNodeCount so small
// graphs are not flooded. Per-node concentration still comes from weighted selection.
function activityEmitGapMs(pulseRate: number, visibleNodeCount: number) {
  const userRate = Math.max(0.1, pulseRate);
  const densityScale = Math.max(1, visibleNodeCount) / ACTIVITY_PULSE_RATE_NODE_REFERENCE;
  const rate = Math.max(0.01, userRate * densityScale);
  const poissonGap = -Math.log(1 - Math.random()) * ACTIVITY_MEAN_EMIT_GAP_MS / rate;
  return THREE.MathUtils.clamp(
    poissonGap,
    ACTIVITY_MIN_EMIT_GAP_MS / rate,
    ACTIVITY_MAX_EMIT_GAP_MS / rate,
  );
}

export const MemoryGraph3D = forwardRef<MemoryGraph3DHandle, MemoryGraph3DProps>(function MemoryGraph3D(
  {
    nodes,
    links,
    selectedNodeId,
    highlightedNodeIds,
    activityEnabled,
    settings,
    visibleNodeIds,
    nodeDetail,
    onNodeSelect,
    onNodeHover,
    onBackgroundSelect,
  },
  forwardedRef,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRefs = useRef(new Map<number, HTMLDivElement>());
  const detailRef = useRef<HTMLDivElement>(null);
  const nodeDetailRef = useRef(nodeDetail);
  nodeDetailRef.current = nodeDetail;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const visibleNodeIdsRef = useRef(visibleNodeIds);
  visibleNodeIdsRef.current = visibleNodeIds;
  const runtimeRef = useRef<GraphRuntime | null>(null);
  const [focusNeighborhoodNodeIds, setFocusNeighborhoodNodeIds] = useState<number[]>([]);
  const selectedNodeIdRef = useRef(selectedNodeId);
  selectedNodeIdRef.current = selectedNodeId;
  const highlightedNodeIdsRef = useRef(highlightedNodeIds);
  highlightedNodeIdsRef.current = highlightedNodeIds;
  const activityEnabledRef = useRef(activityEnabled);
  activityEnabledRef.current = activityEnabled;
  const onNodeSelectRef = useRef(onNodeSelect);
  onNodeSelectRef.current = onNodeSelect;
  const onNodeHoverRef = useRef(onNodeHover);
  onNodeHoverRef.current = onNodeHover;
  const onBackgroundSelectRef = useRef(onBackgroundSelect);
  onBackgroundSelectRef.current = onBackgroundSelect;

  const overlayNodes = useMemo(() => {
    const focusNeighborhood = new Set(focusNeighborhoodNodeIds);
    return nodes.filter((node) => visibleNodeIds.has(node.id) && (
      highlightedNodeIds.has(node.id)
      || focusNeighborhood.has(node.id)
      || selectedNodeId === node.id
    ));
  }, [focusNeighborhoodNodeIds, highlightedNodeIds, nodes, selectedNodeId, visibleNodeIds]);

  useImperativeHandle(forwardedRef, () => ({
    zoomIn: () => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      runtime.camera.position.lerp(runtime.controls.target, 0.2);
      runtime.controls.update();
      runtime.requestRender();
    },
    zoomOut: () => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      const offset = runtime.camera.position.clone().sub(runtime.controls.target).multiplyScalar(1.25);
      runtime.camera.position.copy(runtime.controls.target).add(offset);
      runtime.controls.update();
      runtime.requestRender();
    },
    fitToView: () => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      fitCamera(
        runtime.camera,
        runtime.controls,
        runtime.nodes.filter((node) => visibleNodeIdsRef.current.has(node.id)),
      );
      runtime.requestRender();
    },
  }), []);

  useEffect(() => {
    runtimeRef.current?.setSelectedNodeId(selectedNodeId);
  }, [selectedNodeId]);

  useEffect(() => {
    runtimeRef.current?.refreshAppearance();
  }, [highlightedNodeIds]);

  useEffect(() => {
    runtimeRef.current?.setActivityEnabled(activityEnabled);
  }, [activityEnabled]);

  useEffect(() => {
    runtimeRef.current?.updateSettings(settings);
  }, [settings]);

  useEffect(() => {
    runtimeRef.current?.updateVisibleNodeIds(visibleNodeIds);
  }, [visibleNodeIds]);

  useEffect(() => {
    runtimeRef.current?.requestRender();
  }, [nodeDetail, overlayNodes]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || nodes.length === 0) return;

    const effectStartedAt = performance.now();
    let activeSettings = settingsRef.current;
    let activeVisibleNodeIds = new Set(visibleNodeIdsRef.current);
    const { sceneNodes, simulationLinks, nodeIndex, adjacency } = buildSceneGraph(nodes, links, activeSettings);
    const sceneNodeById = new Map(sceneNodes.map((node) => [node.id, node]));
    const isLargeGraph = sceneNodes.length >= LARGE_GRAPH_THRESHOLD;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 4_000);
    camera.position.set(30, 20, 45);

    const renderer = new THREE.WebGLRenderer({
      antialias: !isLargeGraph,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isLargeGraph ? 1 : 1.5));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = "absolute inset-0 h-full w-full outline-none";
    renderer.domElement.style.touchAction = "none";
    renderer.domElement.setAttribute("data-testid", "palace-graph");
    renderer.domElement.setAttribute("aria-label", "Interactive 3D memory graph");
    renderer.domElement.tabIndex = 0;
    host.prepend(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.rotateSpeed = 0.58;
    controls.zoomSpeed = 0.9;
    controls.panSpeed = 0.68;
    controls.minDistance = 8;
    controls.maxDistance = Infinity;
    controls.screenSpacePanning = true;

    const signalColor = colorFromToken("--cta");
    const selectedColor = colorFromToken("--foreground");
    const deletionColor = colorFromToken("--destructive");
    // Recency is luminance: cold nodes remain deep CTA blue, while recent nodes
    // approach the foreground white. Visibility remains a separate depth/presence
    // channel so old nodes stay ghosted without recency collapsing into opacity.
    const nodeBaseColors = sceneNodes.map((node) => signalColor.clone().lerp(
      selectedColor,
      recencyToWhiteMix(node.recency, activeSettings.recencyBrightness),
    ));
    const nodeGeometry = new THREE.IcosahedronGeometry(1, 2);
    const nodeVisibility = new Float32Array(sceneNodes.length);
    const nodeEmphasis = new Float32Array(sceneNodes.length);
    const nodeImpact = new Float32Array(sceneNodes.length);
    const nodeTints = new Float32Array(sceneNodes.length * 3);
    const renderedVisibility = new Float32Array(sceneNodes.length);
    const renderedEmphasis = new Float32Array(sceneNodes.length);
    const renderedImpact = new Float32Array(sceneNodes.length);
    const renderedTints = new Float32Array(sceneNodes.length * 3);
    sceneNodes.forEach((node, index) => {
      nodeVisibility[index] = recencyToVisibility(node.recency, activeSettings.recencyBrightness);
      (node.pendingDeletion ? deletionColor : nodeBaseColors[index]).toArray(nodeTints, index * 3);
    });
    nodeGeometry.setAttribute("aVisibility", new THREE.InstancedBufferAttribute(renderedVisibility, 1));
    nodeGeometry.setAttribute("aEmphasis", new THREE.InstancedBufferAttribute(renderedEmphasis, 1));
    nodeGeometry.setAttribute("aImpact", new THREE.InstancedBufferAttribute(renderedImpact, 1));
    nodeGeometry.setAttribute("aTint", new THREE.InstancedBufferAttribute(renderedTints, 3));

    const nodeMaterial = new THREE.ShaderMaterial({
      vertexShader: nodeVertexShader,
      fragmentShader: nodeFragmentShader,
      uniforms: {
        uNodeBrightness: { value: activeSettings.nodeBrightnessFactor },
        uPulseBrightness: { value: activeSettings.pulseBrightness },
      },
      transparent: true,
      depthWrite: true,
      depthTest: true,
      side: THREE.FrontSide,
    });
    const nodeMesh = new THREE.InstancedMesh(nodeGeometry, nodeMaterial, sceneNodes.length);
    nodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    nodeMesh.frustumCulled = false;
    nodeMesh.renderOrder = NODE_RENDER_ORDER;
    scene.add(nodeMesh);

    let curveSegments = activeSettings.linkComplexity;
    let renderedLinkPlan: LinkRenderCandidate[] = [];
    let renderedLinkIndices = new Set<number>();
    const linkPositions = new Float32Array(MAX_RENDERED_LINK_SEGMENTS * 6);
    const linkColors = new Float32Array(MAX_RENDERED_LINK_SEGMENTS * 6);
    const focusedLinkCapacity = Math.max(
      0,
      ...[...adjacency.simulationLinksByNodeId.values()].map((incidentLinks) => incidentLinks.length),
    );
    const focusedLinkPositions = new Float32Array(focusedLinkCapacity * MAX_LINK_COMPLEXITY * 6);
    const focusedLinkColors = new Float32Array(focusedLinkCapacity * MAX_LINK_COMPLEXITY * 6);
    const linkBrightness = new Float32Array(simulationLinks.length);
    const visibleLinkBrightnessFrom = new Float32Array(simulationLinks.length);
    const visibleLinkBrightnessTo = new Float32Array(simulationLinks.length);
    const nodeLinkVisibility = new Float32Array(sceneNodes.length);
    const linkGeometry = new LineSegmentsGeometry();
    const focusedLinkGeometry = new LineSegmentsGeometry();
    const restingLinkColors = simulationLinks.map((link) => ({
      from: nodeBaseColors[link.fromIndex].clone(),
      to: nodeBaseColors[link.toIndex].clone(),
    }));
    simulationLinks.forEach((link, linkIndex) => {
      const normalizedStrength = THREE.MathUtils.clamp(link.strength, 0, 1);
      linkBrightness[linkIndex] = THREE.MathUtils.lerp(
        RESTING_LINK_MIN_LUMINANCE,
        RESTING_LINK_MAX_LUMINANCE,
        Math.pow(normalizedStrength, 1.6),
      );
    });
    linkGeometry.setPositions(linkPositions);
    linkGeometry.setColors(linkColors);
    focusedLinkGeometry.setPositions(focusedLinkPositions);
    focusedLinkGeometry.setColors(focusedLinkColors);
    const linkMaterial = new LineMaterial({
      vertexColors: true,
      transparent: true,
      // +50% opacity over the prior 0.45: resting (non-hovered) links were too
      // dark against the canvas. Hover still reads brighter via focusedLinkMaterial.
      opacity: 0.68,
      linewidth: 1,
      depthTest: true,
      depthWrite: false,
      resolution: new THREE.Vector2(host.clientWidth, host.clientHeight),
    });
    const focusedLinkMaterial = new LineMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      linewidth: 2.5,
      depthTest: true,
      depthWrite: false,
      resolution: new THREE.Vector2(host.clientWidth, host.clientHeight),
    });
    linkGeometry.instanceCount = 0;
    focusedLinkGeometry.instanceCount = 0;
    const linkLines = new LineSegments2(linkGeometry, linkMaterial);
    const focusedLinkLines = new LineSegments2(focusedLinkGeometry, focusedLinkMaterial);
    linkLines.frustumCulled = false;
    focusedLinkLines.frustumCulled = false;
    linkLines.renderOrder = RESTING_LINK_RENDER_ORDER;
    focusedLinkLines.renderOrder = FOCUSED_LINK_RENDER_ORDER;
    focusedLinkLines.visible = false;
    scene.add(linkLines);
    scene.add(focusedLinkLines);

    const maxActivityPackets = host.clientWidth < ACTIVITY_MOBILE_BREAKPOINT_PX
      ? ACTIVITY_MAX_MOBILE_PACKETS
      : ACTIVITY_MAX_DESKTOP_PACKETS;
    const activityGeometry = new THREE.SphereGeometry(ACTIVITY_BEAD_BASE_RADIUS, 8, 8);
    const activityMaterial = new THREE.MeshBasicMaterial({
      color: selectedColor,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
    });
    const activityMesh = new THREE.InstancedMesh(
      activityGeometry,
      activityMaterial,
      maxActivityPackets * ACTIVITY_PACKET_BEADS,
    );
    activityMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    activityMesh.count = 0;
    activityMesh.frustumCulled = false;
    activityMesh.renderOrder = ACTIVITY_RENDER_ORDER;
    scene.add(activityMesh);

    const transform = new THREE.Object3D();
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const projected = new THREE.Vector3();
    const cameraSpace = new THREE.Vector3();
    const nodeInstanceOrder = sceneNodes.map((_, index) => index);
    const nodeDepths = new Float32Array(sceneNodes.length);
    let selectedIndex = selectedNodeIdRef.current == null || !activeVisibleNodeIds.has(selectedNodeIdRef.current)
      ? null
      : nodeIndex.get(selectedNodeIdRef.current) ?? null;
    let hoveredIndex: number | null = null;
    let focusNeighborIndices = new Set<number>();
    let focusedSimulationLinks: SceneLink[] = [];
    let focusedLinkIndices = new Set<number>();
    let pointerDown = { x: 0, y: 0 };
    let pendingPointer = { x: 0, y: 0 };
    let cameraInteractionActive = false;
    let nodeDepthOrderDirty = true;
    let renderFrame = 0;
    let pointerFrame = 0;
    let activityFrame = 0;
    let layoutFrame = 0;
    let layoutFrom: Float32Array | null = null;
    let layoutTo: Float32Array | null = null;
    let layoutInterpolating = false;
    let layoutFinalSegment = false;
    // Visual admission: nodes stay invisible until the worker's first post after the
    // silent prestabilize burst. Labels stay closed until the layout rests (`end`).
    let layoutAdmitted = false;
    let layoutRested = false;
    // Once the user grabs the camera we never auto-frame again — no yank mid-interaction.
    let userHasAdjustedCamera = false;
    let layoutSegmentStart = 0;
    let layoutSegmentDuration = LAYOUT_INTERP_DEFAULT_MS;
    let lastLayoutPostAt = 0;
    let activityTimer: ReturnType<typeof setTimeout> | null = null;
    let activityIsEnabled = activityEnabledRef.current;
    let simulationTick = 0;
    let layoutRevision = 0;
    const activePackets: ActivityPacket[] = [];
    const activeImpacts: ActivityImpact[] = [];
    const nodeAfterglow = new Float32Array(sceneNodes.length);
    const linkAfterglow = new Float32Array(simulationLinks.length);
    const lastPulseAtByNodeIndex = new Map<number, number>();
    let afterglowUpdatedAt = 0;
    const activityPoint = new THREE.Vector3();
    const restingLinkColor = new THREE.Color();
    const activityColor = new THREE.Color();
    const renderedLinkPaths: QuadraticLinkPath[] = simulationLinks.map(() => ({
      fromX: 0,
      fromY: 0,
      fromZ: 0,
      controlX: 0,
      controlY: 0,
      controlZ: 0,
      toX: 0,
      toY: 0,
      toZ: 0,
    }));
    const activityPaths: ActivityPath[] = simulationLinks.flatMap((link, linkIndex) => {
      const fromRecency = sceneNodes[link.fromIndex].recency;
      const toRecency = sceneNodes[link.toIndex].recency;
      const paths: ActivityPath[] = [];
      if (toRecency >= ACTIVITY_RECENCY_THRESHOLD) {
        paths.push({ linkIndex, sourceIndex: link.fromIndex, destinationIndex: link.toIndex, destinationRecency: toRecency });
      }
      if (fromRecency >= ACTIVITY_RECENCY_THRESHOLD) {
        paths.push({ linkIndex, sourceIndex: link.toIndex, destinationIndex: link.fromIndex, destinationRecency: fromRecency });
      }
      return paths;
    });

    function isNodeVisible(index: number): boolean {
      // Hide the cold random cloud until the worker's first prestabilized post arrives.
      if (!layoutAdmitted) return false;
      return activeVisibleNodeIds.has(sceneNodes[index].id);
    }

    function isLinkVisible(link: SceneLink): boolean {
      return isNodeVisible(link.fromIndex) && isNodeVisible(link.toIndex);
    }

    function getNodeScale(index: number) {
      if (!isNodeVisible(index)) return 0;
      const focusIndex = hoveredIndex ?? selectedIndex;
      if (hoveredIndex === index) return 1.28;
      if (selectedIndex === index) return 1.22;
      if (focusNeighborIndices.has(index)) return 1.14;
      return focusIndex == null ? 1 : 0.94;
    }

    function syncNodeTransforms() {
      nodeInstanceOrder.forEach((nodeIndex, renderSlot) => {
        const node = sceneNodes[nodeIndex];
        transform.position.set(node.x, node.y, node.z);
        transform.scale.setScalar(node.radius * getNodeScale(nodeIndex));
        transform.updateMatrix();
        nodeMesh.setMatrixAt(renderSlot, transform.matrix);
      });
      nodeMesh.instanceMatrix.needsUpdate = true;
    }

    function syncNodeAppearanceAttributes() {
      nodeInstanceOrder.forEach((nodeIndex, renderSlot) => {
        renderedVisibility[renderSlot] = nodeVisibility[nodeIndex];
        renderedEmphasis[renderSlot] = nodeEmphasis[nodeIndex];
        renderedTints.set(nodeTints.subarray(nodeIndex * 3, nodeIndex * 3 + 3), renderSlot * 3);
      });
      (nodeGeometry.getAttribute("aVisibility") as THREE.InstancedBufferAttribute).needsUpdate = true;
      (nodeGeometry.getAttribute("aEmphasis") as THREE.InstancedBufferAttribute).needsUpdate = true;
      (nodeGeometry.getAttribute("aTint") as THREE.InstancedBufferAttribute).needsUpdate = true;
    }

    function syncNodeImpactAttribute() {
      nodeInstanceOrder.forEach((nodeIndex, renderSlot) => {
        renderedImpact[renderSlot] = nodeImpact[nodeIndex];
      });
      (nodeGeometry.getAttribute("aImpact") as THREE.InstancedBufferAttribute).needsUpdate = true;
    }

    function sortNodeInstancesByDepth() {
      camera.updateMatrixWorld();
      sceneNodes.forEach((node, index) => {
        if (!isNodeVisible(index)) {
          nodeDepths[index] = Number.POSITIVE_INFINITY;
          return;
        }
        cameraSpace.set(node.x, node.y, node.z).applyMatrix4(camera.matrixWorldInverse);
        nodeDepths[index] = -cameraSpace.z;
      });
      nodeInstanceOrder.sort((leftIndex, rightIndex) => (
        nodeDepths[rightIndex] - nodeDepths[leftIndex]
        || sceneNodes[leftIndex].id - sceneNodes[rightIndex].id
      ));
      syncNodeTransforms();
      syncNodeAppearanceAttributes();
      syncNodeImpactAttribute();
      nodeDepthOrderDirty = false;
    }

    function syncNodeDepthOrderIfNeeded(): boolean {
      if (!nodeDepthOrderDirty) return false;
      sortNodeInstancesByDepth();
      return true;
    }

    const projectedLinkNode = new THREE.Vector3();
    const cameraLinkNode = new THREE.Vector3();
    const projectedNodeX = new Float32Array(sceneNodes.length);
    const projectedNodeY = new Float32Array(sceneNodes.length);
    const projectedNodeRadius = new Float32Array(sceneNodes.length);
    const cameraNodeDepth = new Float32Array(sceneNodes.length);

    function setLinkPath(link: SceneLink, path: QuadraticLinkPath, arcScale: number) {
      const from = sceneNodes[link.fromIndex];
      const to = sceneNodes[link.toIndex];
      let dx = to.x - from.x;
      let dy = to.y - from.y;
      let dz = to.z - from.z;
      const distance = Math.max(0.001, Math.sqrt(dx * dx + dy * dy + dz * dz));
      dx /= distance;
      dy /= distance;
      dz /= distance;
      path.fromX = from.x + dx * from.radius * 0.94;
      path.fromY = from.y + dy * from.radius * 0.94;
      path.fromZ = from.z + dz * from.radius * 0.94;
      path.toX = to.x - dx * to.radius * 0.94;
      path.toY = to.y - dy * to.radius * 0.94;
      path.toZ = to.z - dz * to.radius * 0.94;
      let perpendicularX: number;
      let perpendicularY: number;
      let perpendicularZ: number;
      if (Math.abs(dy) < 0.85) {
        perpendicularX = -dz;
        perpendicularY = 0;
        perpendicularZ = dx;
      } else {
        perpendicularX = 0;
        perpendicularY = dz;
        perpendicularZ = -dy;
      }
      const perpendicularLength = Math.max(0.001, Math.sqrt(
        perpendicularX * perpendicularX + perpendicularY * perpendicularY + perpendicularZ * perpendicularZ,
      ));
      const arc = Math.min(14, 2 + distance * 0.05) * (0.75 + seededUnit(link.id, 21) * 0.5) * arcScale;
      path.controlX = (path.fromX + path.toX) * 0.5 + perpendicularX / perpendicularLength * arc;
      path.controlY = (path.fromY + path.toY) * 0.5 + perpendicularY / perpendicularLength * arc;
      path.controlZ = (path.fromZ + path.toZ) * 0.5 + perpendicularZ / perpendicularLength * arc;
    }

    function writeLinkCurve(
      positions: Float32Array,
      link: SceneLink,
      segmentOffset: number,
      segmentCount: number,
      arcScale: number,
      activityPath = renderedLinkPaths[link.linkIndex],
    ) {
      setLinkPath(link, activityPath, arcScale);
      for (let segment = 0; segment < segmentCount; segment += 1) {
        const offset = (segmentOffset + segment) * 6;
        writeQuadraticPoint(
          positions,
          offset,
          activityPath.fromX,
          activityPath.fromY,
          activityPath.fromZ,
          activityPath.controlX,
          activityPath.controlY,
          activityPath.controlZ,
          activityPath.toX,
          activityPath.toY,
          activityPath.toZ,
          segment / segmentCount,
        );
        writeQuadraticPoint(
          positions,
          offset + 3,
          activityPath.fromX,
          activityPath.fromY,
          activityPath.fromZ,
          activityPath.controlX,
          activityPath.controlY,
          activityPath.controlZ,
          activityPath.toX,
          activityPath.toY,
          activityPath.toZ,
          (segment + 1) / segmentCount,
        );
      }
    }

    function buildLinkRenderPlan(): LinkRenderCandidate[] {
      camera.updateMatrixWorld();
      const viewportHeight = Math.max(1, host.clientHeight);
      const pixelsPerRadian = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
      const candidates: LinkRenderCandidate[] = [];
      sceneNodes.forEach((node, nodeIndex) => {
        cameraLinkNode.set(node.x, node.y, node.z).applyMatrix4(camera.matrixWorldInverse);
        cameraNodeDepth[nodeIndex] = -cameraLinkNode.z;
        projectedLinkNode.set(node.x, node.y, node.z).project(camera);
        projectedNodeX[nodeIndex] = projectedLinkNode.x;
        projectedNodeY[nodeIndex] = projectedLinkNode.y;
        projectedNodeRadius[nodeIndex] = cameraNodeDepth[nodeIndex] > 0
          ? node.radius * pixelsPerRadian / cameraNodeDepth[nodeIndex]
          : 0;
      });
      simulationLinks.forEach((link, linkIndex) => {
        if (!isLinkVisible(link)) return;
        const fromDepth = cameraNodeDepth[link.fromIndex];
        const toDepth = cameraNodeDepth[link.toIndex];
        if (
          (fromDepth <= camera.near && toDepth <= camera.near)
          || (fromDepth >= camera.far && toDepth >= camera.far)
        ) return;
        const fromX = projectedNodeX[link.fromIndex];
        const fromY = projectedNodeY[link.fromIndex];
        const toX = projectedNodeX[link.toIndex];
        const toY = projectedNodeY[link.toIndex];
        const minX = Math.min(fromX, toX);
        const maxX = Math.max(fromX, toX);
        const minY = Math.min(fromY, toY);
        const maxY = Math.max(fromY, toY);
        if (
          maxX < -1 - LINK_FRUSTUM_MARGIN
          || minX > 1 + LINK_FRUSTUM_MARGIN
          || maxY < -1 - LINK_FRUSTUM_MARGIN
          || minY > 1 + LINK_FRUSTUM_MARGIN
        ) return;
        const projectedRadius = Math.max(
          projectedNodeRadius[link.fromIndex],
          projectedNodeRadius[link.toIndex],
        );
        const segmentCount = projectedRadius >= LINK_FULL_DETAIL_RADIUS_PX
          ? curveSegments
          : projectedRadius >= LINK_MEDIUM_DETAIL_RADIUS_PX
            ? Math.max(2, Math.ceil(curveSegments / 2))
            : 1;
        const arcScale = segmentCount === 1 ? 0 : segmentCount === curveSegments ? 1 : 0.68;
        const centered = 1 - Math.min(1, Math.hypot(
          (fromX + toX) * 0.5,
          (fromY + toY) * 0.5,
        ) / Math.SQRT2);
        candidates.push({
          linkIndex,
          segmentCount,
          arcScale,
          priority: (focusedLinkIndices.has(linkIndex) ? 1_000_000 : 0)
            + projectedRadius * 4
            + centered * 2
            + THREE.MathUtils.clamp(link.strength, 0, 1),
        });
      });
      candidates.sort((left, right) => right.priority - left.priority || left.linkIndex - right.linkIndex);
      const renderPlan: LinkRenderCandidate[] = [];
      let segmentCount = 0;
      for (const candidate of candidates) {
        if (renderPlan.length >= MAX_RENDERED_LINKS) break;
        if (segmentCount + candidate.segmentCount > MAX_RENDERED_LINK_SEGMENTS) continue;
        renderPlan.push(candidate);
        segmentCount += candidate.segmentCount;
      }
      return renderPlan;
    }

    function syncLinkPositions() {
      renderedLinkPlan = buildLinkRenderPlan();
      renderedLinkIndices = new Set(renderedLinkPlan.map((candidate) => candidate.linkIndex));
      for (let packetIndex = activePackets.length - 1; packetIndex >= 0; packetIndex -= 1) {
        if (!renderedLinkIndices.has(activePackets[packetIndex].linkIndex)) activePackets.splice(packetIndex, 1);
      }
      let segmentOffset = 0;
      renderedLinkPlan.forEach((candidate) => {
        const link = simulationLinks[candidate.linkIndex];
        writeLinkCurve(
          linkPositions,
          link,
          segmentOffset,
          candidate.segmentCount,
          activeSettings.linkBendFactor * candidate.arcScale,
        );
        segmentOffset += candidate.segmentCount;
      });
      linkGeometry.instanceCount = segmentOffset;
      const instanceStartAttr = linkGeometry.getAttribute("instanceStart");
      if (instanceStartAttr && "data" in instanceStartAttr) (instanceStartAttr as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
      const instanceEndAttr = linkGeometry.getAttribute("instanceEnd");
      if (instanceEndAttr && "data" in instanceEndAttr) (instanceEndAttr as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
    }

    function syncFocusedLinkGeometry() {
      focusedSimulationLinks.forEach((link, focusedLinkIndex) => {
        writeLinkCurve(
          focusedLinkPositions,
          link,
          focusedLinkIndex * curveSegments,
          curveSegments,
          activeSettings.linkBendFactor,
        );
        const normalizedStrength = THREE.MathUtils.clamp(link.strength, 0, 1);
        const focusedBrightness = THREE.MathUtils.lerp(
          FOCUSED_LINK_MIN_LUMINANCE,
          FOCUSED_LINK_MAX_LUMINANCE,
          Math.pow(normalizedStrength, 1.25),
        ) * activeSettings.linkBrightnessFactor;
        const fromVisibility = nodeLinkVisibility[link.fromIndex];
        const toVisibility = nodeLinkVisibility[link.toIndex];
        const fromColor = nodeBaseColors[link.fromIndex];
        const toColor = nodeBaseColors[link.toIndex];
        for (let segment = 0; segment < curveSegments; segment += 1) {
          const focusedOffset = (focusedLinkIndex * curveSegments + segment) * 6;
          const fromProgress = segment / curveSegments;
          const toProgress = (segment + 1) / curveSegments;
          restingLinkColor.copy(fromColor).lerp(toColor, fromProgress);
          restingLinkColor.multiplyScalar(
            focusedBrightness * THREE.MathUtils.lerp(fromVisibility, toVisibility, fromProgress),
          );
          restingLinkColor.toArray(focusedLinkColors, focusedOffset);
          restingLinkColor.copy(fromColor).lerp(toColor, toProgress);
          restingLinkColor.multiplyScalar(
            focusedBrightness * THREE.MathUtils.lerp(fromVisibility, toVisibility, toProgress),
          );
          restingLinkColor.toArray(focusedLinkColors, focusedOffset + 3);
        }
      });
      focusedLinkGeometry.instanceCount = focusedSimulationLinks.length * curveSegments;
      focusedLinkLines.visible = focusedSimulationLinks.length > 0;
      const focusedInstanceStart = focusedLinkGeometry.getAttribute("instanceStart");
      if (focusedInstanceStart && "data" in focusedInstanceStart) {
        (focusedInstanceStart as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
      }
      const focusedInstanceEnd = focusedLinkGeometry.getAttribute("instanceEnd");
      if (focusedInstanceEnd && "data" in focusedInstanceEnd) {
        (focusedInstanceEnd as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
      }
      const focusedInstanceColorStart = focusedLinkGeometry.getAttribute("instanceColorStart");
      if (focusedInstanceColorStart && "data" in focusedInstanceColorStart) {
        (focusedInstanceColorStart as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
      }
      const focusedInstanceColorEnd = focusedLinkGeometry.getAttribute("instanceColorEnd");
      if (focusedInstanceColorEnd && "data" in focusedInstanceColorEnd) {
        (focusedInstanceColorEnd as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
      }
    }

    function syncLinkColors() {
      let segmentOffset = 0;
      renderedLinkPlan.forEach((candidate) => {
        const linkIndex = candidate.linkIndex;
        const energy = linkAfterglow[linkIndex];
        const activityMultiplier = 1 + energy * ACTIVITY_LINK_LUMINANCE_RESPONSE;
        const restingColors = restingLinkColors[linkIndex];
        for (let segment = 0; segment < candidate.segmentCount; segment += 1) {
          const offset = (segmentOffset + segment) * 6;
          const fromProgress = segment / candidate.segmentCount;
          const toProgress = (segment + 1) / candidate.segmentCount;
          const fromBrightness = Math.min(
            ACTIVITY_LINK_MAX_LUMINANCE * activeSettings.linkBrightnessFactor,
            THREE.MathUtils.lerp(
              visibleLinkBrightnessFrom[linkIndex],
              visibleLinkBrightnessTo[linkIndex],
              fromProgress,
            ) * activityMultiplier * activeSettings.linkBrightnessFactor,
          );
          const toBrightness = Math.min(
            ACTIVITY_LINK_MAX_LUMINANCE * activeSettings.linkBrightnessFactor,
            THREE.MathUtils.lerp(
              visibleLinkBrightnessFrom[linkIndex],
              visibleLinkBrightnessTo[linkIndex],
              toProgress,
            ) * activityMultiplier * activeSettings.linkBrightnessFactor,
          );
          restingLinkColor.copy(restingColors.from).lerp(restingColors.to, fromProgress);
          composeActivityColor(activityColor, restingLinkColor, selectedColor, energy, fromBrightness);
          activityColor.toArray(linkColors, offset);
          restingLinkColor.copy(restingColors.from).lerp(restingColors.to, toProgress);
          composeActivityColor(activityColor, restingLinkColor, selectedColor, energy, toBrightness);
          activityColor.toArray(linkColors, offset + 3);
        }
        segmentOffset += candidate.segmentCount;
      });
      const instanceColorStart = linkGeometry.getAttribute("instanceColorStart");
      if (instanceColorStart && "data" in instanceColorStart) {
        (instanceColorStart as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
      }
      const instanceColorEnd = linkGeometry.getAttribute("instanceColorEnd");
      if (instanceColorEnd && "data" in instanceColorEnd) {
        (instanceColorEnd as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
      }
    }

    function syncLinkVisibility() {
      camera.updateMatrixWorld();
      const focusIndex = hoveredIndex ?? selectedIndex;
      const viewportHeight = Math.max(1, host.clientHeight);
      const pixelsPerRadian = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
      sceneNodes.forEach((node, index) => {
        if (!isNodeVisible(index)) {
          nodeLinkVisibility[index] = 0;
          return;
        }
        cameraSpace.set(node.x, node.y, node.z).applyMatrix4(camera.matrixWorldInverse);
        const depth = -cameraSpace.z;
        const projectedRadius = depth > 0 ? node.radius * pixelsPerRadian / depth : 0;
        // Distance fade at half strength: distant edges dim toward a 0.5 floor
        // instead of vanishing, so the field keeps depth cues without going hollow.
        const distanceFade = THREE.MathUtils.smoothstep(projectedRadius, 0.75, 3.5);
        const distanceVisibility = 0.5 + 0.5 * distanceFade;
        const unrelated = focusIndex != null
          && focusIndex !== index
          && !focusNeighborIndices.has(index);
        nodeLinkVisibility[index] = distanceVisibility
          * recencyToVisibility(node.recency, activeSettings.recencyBrightness)
          * (unrelated ? 0.62 : 1);
      });

      renderedLinkPlan.forEach((candidate) => {
        const linkIndex = candidate.linkIndex;
        const link = simulationLinks[linkIndex];
        const layerVisible = isLinkVisible(link);
        const focused = layerVisible && focusIndex != null && focusedLinkIndices.has(linkIndex);
        const focusDim = focusIndex != null && !focused ? 0.42 : 1;
        // The focused overlay owns incident edges. Suppress their base pass so two
        // translucent curves never add into a bright seam at either node.
        const basePassVisibility = focused ? 0 : 1;
        const edgeBrightness = layerVisible
          ? linkBrightness[linkIndex] * focusDim * basePassVisibility
          : 0;
        visibleLinkBrightnessFrom[linkIndex] = edgeBrightness * nodeLinkVisibility[link.fromIndex];
        visibleLinkBrightnessTo[linkIndex] = edgeBrightness * nodeLinkVisibility[link.toIndex];
      });
      syncLinkColors();
      syncFocusedLinkGeometry();
    }

    function syncNodeBaseColors() {
      sceneNodes.forEach((node, index) => {
        nodeBaseColors[index].copy(signalColor).lerp(
          selectedColor,
          recencyToWhiteMix(node.recency, activeSettings.recencyBrightness),
        );
      });
      simulationLinks.forEach((link, linkIndex) => {
        restingLinkColors[linkIndex].from.copy(nodeBaseColors[link.fromIndex]);
        restingLinkColors[linkIndex].to.copy(nodeBaseColors[link.toIndex]);
      });
    }

    function syncNodeAppearance() {
      const focusIndex = hoveredIndex ?? selectedIndex;
      sceneNodes.forEach((node, index) => {
        if (!isNodeVisible(index)) {
          nodeEmphasis[index] = 0;
          nodeVisibility[index] = 0;
          nodeBaseColors[index].toArray(nodeTints, index * 3);
          return;
        }
        const isSelected = selectedIndex === index;
        const isFocus = focusIndex === index;
        const neighbor = focusNeighborIndices.has(index);
        const searchMatch = highlightedNodeIdsRef.current.has(node.id);
        const unrelated = focusIndex != null && !isFocus && !neighbor;
        nodeEmphasis[index] = isSelected || isFocus ? 1 : neighbor ? 0.58 : searchMatch ? 0.72 : unrelated ? -0.35 : 0;
        const tint = isSelected
          ? selectedColor
          : node.pendingDeletion
            ? deletionColor
            : isFocus || neighbor || searchMatch
              ? selectedColor
              : nodeBaseColors[index];
        tint.toArray(nodeTints, index * 3);
        nodeVisibility[index] = isSelected
          ? 1
          : recencyToVisibility(node.recency, activeSettings.recencyBrightness) * (unrelated ? 0.62 : 1);
      });
      syncNodeTransforms();
      syncNodeAppearanceAttributes();
    }

    function neighborIndicesOf(index: number | null): Set<number> {
      if (index == null) return new Set<number>();
      const node = sceneNodes[index];
      const neighborNodeIds = adjacency.neighborsByNodeId.get(node.id) ?? new Set<number>();
      return new Set(
        [...neighborNodeIds].flatMap((nodeId): number[] => {
          const neighborIndex = nodeIndex.get(nodeId);
          return neighborIndex == null || !isNodeVisible(neighborIndex) ? [] : [neighborIndex];
        }),
      );
    }

    // Hover and selection are one "focus" concept: an active hover takes
    // precedence, and when the pointer leaves, the persistent selection keeps
    // its neighborhood highlighted. Both drive the same node emphasis, link
    // focus, and overlay labels.
    function syncFocusNeighborhood() {
      const focusIndex = hoveredIndex ?? selectedIndex;
      const focusNode = focusIndex == null ? null : sceneNodes[focusIndex];
      focusNeighborIndices = neighborIndicesOf(focusIndex);
      focusedSimulationLinks = focusNode == null || focusIndex == null || !isNodeVisible(focusIndex)
        ? []
        : (adjacency.simulationLinksByNodeId.get(focusNode.id) ?? []).filter(isLinkVisible);
      focusedLinkIndices = new Set(focusedSimulationLinks.map((link) => link.linkIndex));
      const neighborNodeIds = [...focusNeighborIndices].map((index) => sceneNodes[index].id);
      setFocusNeighborhoodNodeIds(focusNode == null ? [] : [focusNode.id, ...neighborNodeIds]);
      syncNodeAppearance();
      syncLinkPositions();
      syncLinkVisibility();
    }

    // Frame the selected node together with its one-hop neighborhood (item 2).
    function fitCameraToIndex(index: number) {
      if (!isNodeVisible(index)) return;
      const subset = [sceneNodes[index], ...[...neighborIndicesOf(index)].map((neighborIndex) => sceneNodes[neighborIndex])];
      fitCamera(camera, controls, subset);
    }

    function syncDetail() {
      const element = detailRef.current;
      const detail = nodeDetailRef.current;
      if (!element || !detail) return;
      const node = sceneNodeById.get(detail.nodeId);
      if (!node || !activeVisibleNodeIds.has(node.id)) {
        element.style.display = "none";
        return;
      }
      projected.set(node.x, node.y, node.z).project(camera);
      const visible = projected.z > -1 && projected.z < 1 && Math.abs(projected.x) < 1.02 && Math.abs(projected.y) < 1.02;
      if (!visible) {
        element.style.display = "none";
        return;
      }
      const width = host.clientWidth;
      const height = host.clientHeight;
      const projectedX = (projected.x * 0.5 + 0.5) * width;
      const projectedY = (-projected.y * 0.5 + 0.5) * height;
      cameraSpace.set(node.x, node.y, node.z).applyMatrix4(camera.matrixWorldInverse);
      const depth = Math.max(0.001, -cameraSpace.z);
      const pixelsPerRadian = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
      const nodeRadius = node.radius * getNodeScale(nodeIndex.get(node.id) ?? 0) * pixelsPerRadian / depth;
      element.style.display = "block";
      const halfWidth = element.offsetWidth / 2;
      const x = THREE.MathUtils.clamp(projectedX, halfWidth + 8, Math.max(halfWidth + 8, width - halfWidth - 8));
      element.style.transform = `translate3d(${x}px, ${projectedY + Math.max(18, nodeRadius + 10)}px, 0) translateX(-50%)`;
    }

    function syncLabels() {
      const width = host.clientWidth;
      const height = host.clientHeight;
      const projectedLabels: ProjectedLabel[] = [];
      // Labels stay closed until the layout rests, then only the focused neighborhood
      // (hover/selection + neighbors) and the persistent selection may open. Ambient
      // labels on every node fight the rest-gate and dominate large graphs.
      const focusIndex = hoveredIndex ?? selectedIndex;
      const labelsOpen = layoutRested && layoutAdmitted;
      labelRefs.current.forEach((element, nodeId) => {
        const node = sceneNodeById.get(nodeId);
        if (!labelsOpen || !node || !activeVisibleNodeIds.has(node.id)) {
          if (element) element.style.display = "none";
          return;
        }
        const sceneIndex = nodeIndex.get(node.id);
        const focused = sceneIndex != null && (focusIndex === sceneIndex || focusNeighborIndices.has(sceneIndex));
        const selected = selectedNodeIdRef.current === node.id;
        if (!focused && !selected) {
          element.style.display = "none";
          return;
        }
        projected.set(node.x, node.y, node.z).project(camera);
        const visible = projected.z > -1 && projected.z < 1 && Math.abs(projected.x) < 1.02 && Math.abs(projected.y) < 1.02;
        if (!visible) {
          element.style.display = "none";
          return;
        }
        const x = (projected.x * 0.5 + 0.5) * width;
        const y = (-projected.y * 0.5 + 0.5) * height;
        const dx = camera.position.x - node.x;
        const dy = camera.position.y - node.y;
        const dz = camera.position.z - node.z;
        projectedLabels.push({ node, x, y, distance: Math.sqrt(dx * dx + dy * dy + dz * dz) });
      });

      projectedLabels
        .sort((left, right) => {
          const leftIndex = nodeIndex.get(left.node.id);
          const rightIndex = nodeIndex.get(right.node.id);
          const leftFocused = leftIndex != null && (focusIndex === leftIndex || focusNeighborIndices.has(leftIndex));
          const rightFocused = rightIndex != null && (focusIndex === rightIndex || focusNeighborIndices.has(rightIndex));
          if (leftFocused !== rightFocused) return leftFocused ? -1 : 1;
          return left.node.id - right.node.id;
        })
        .forEach(({ node, x, y, distance }) => {
          const element = labelRefs.current.get(node.id);
          if (!element) return;
          const sceneIndex = nodeIndex.get(node.id);
          const focused = sceneIndex != null && (focusIndex === sceneIndex || focusNeighborIndices.has(sceneIndex));
          const selected = selectedNodeIdRef.current === node.id;
          element.style.display = "flex";
          element.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -12px)`;
          element.style.opacity = focused || selected ? "1" : "0.85";
          element.style.zIndex = String(focused ? 2_000 : selected ? 1_500 : Math.max(1, Math.round(1_000 - distance)));
        });
      syncDetail();
    }

    function activityCanRun() {
      // Focus (hover/selection) intentionally does not gate the pulse stream:
      // activity keeps flowing while a node is hovered or selected.
      return activityIsEnabled
        && !document.hidden
        && activityPaths.some((path) => (
          renderedLinkIndices.has(path.linkIndex)
          && isNodeVisible(path.sourceIndex)
          && isNodeVisible(path.destinationIndex)
        ));
    }

    function clearActivityVisuals() {
      activePackets.length = 0;
      activeImpacts.length = 0;
      nodeImpact.fill(0);
      nodeAfterglow.fill(0);
      linkAfterglow.fill(0);
      afterglowUpdatedAt = 0;
      activityMesh.count = 0;
      syncLinkColors();
      syncNodeImpactAttribute();
      if (activityFrame !== 0) cancelAnimationFrame(activityFrame);
      activityFrame = 0;
      requestRender();
    }

    function eligibleActivityPaths(now: number) {
      // No active-destination exclusion: a hot node may carry several concurrent
      // beads at once, which is what makes busy regions read as concentrated.
      // Its short cooldown still spaces re-selection so it never floods every tick.
      return activityPaths.filter((path) => {
        if (
          !renderedLinkIndices.has(path.linkIndex)
          || !isNodeVisible(path.sourceIndex)
          || !isNodeVisible(path.destinationIndex)
        ) return false;
        const heat = THREE.MathUtils.smoothstep(path.destinationRecency, ACTIVITY_RECENCY_THRESHOLD, 1);
        const cooldown = THREE.MathUtils.lerp(
          ACTIVITY_MAX_NODE_COOLDOWN_MS,
          ACTIVITY_MIN_NODE_COOLDOWN_MS,
          heat,
        ) / Math.max(0.1, activeSettings.pulseRate);
        return now - (lastPulseAtByNodeIndex.get(path.destinationIndex) ?? Number.NEGATIVE_INFINITY) >= cooldown;
      });
    }

    function launchActivityPacket(now: number): boolean {
      const path = weightedActivityPath(eligibleActivityPaths(now));
      if (!path) return false;
      activePackets.push({ ...path, startedAt: now });
      linkAfterglow[path.linkIndex] = Math.min(
        ACTIVITY_LINK_AFTERGLOW_CEILING,
        linkAfterglow[path.linkIndex] + ACTIVITY_LINK_AFTERGLOW_DEPOSIT,
      );
      nodeAfterglow[path.sourceIndex] = Math.min(
        ACTIVITY_NODE_AFTERGLOW_CEILING,
        nodeAfterglow[path.sourceIndex] + ACTIVITY_NODE_AFTERGLOW_DEPOSIT,
      );
      if (afterglowUpdatedAt === 0) afterglowUpdatedAt = now;
      lastPulseAtByNodeIndex.set(path.destinationIndex, now);
      return true;
    }

    function scheduleNextActivity(delayMs: number) {
      if (activityTimer !== null) clearTimeout(activityTimer);
      activityTimer = setTimeout(() => {
        activityTimer = null;
        if (!activityCanRun()) {
          clearActivityVisuals();
          return;
        }
        if (activePackets.length >= maxActivityPackets) {
          scheduleNextActivity(ACTIVITY_RETRY_GAP_MS);
          return;
        }
        const now = performance.now();
        if (!launchActivityPacket(now)) {
          scheduleNextActivity(ACTIVITY_RETRY_GAP_MS);
          return;
        }
        if (activityFrame === 0) activityFrame = requestAnimationFrame(animateActivity);
        scheduleNextActivity(activityEmitGapMs(activeSettings.pulseRate, activeVisibleNodeIds.size));
      }, delayMs);
    }

    function animateActivity(now: number) {
      activityFrame = 0;
      if (!activityCanRun()) {
        clearActivityVisuals();
        return;
      }

      let beadInstance = 0;
      for (let packetIndex = activePackets.length - 1; packetIndex >= 0; packetIndex -= 1) {
        const packet = activePackets[packetIndex];
        const progress = (now - packet.startedAt) / ACTIVITY_PACKET_DURATION_MS;
        const link = simulationLinks[packet.linkIndex];
        const forward = packet.sourceIndex === link.fromIndex;
        const destination = sceneNodes[packet.destinationIndex];
        setQuadraticPoint(
          activityPoint,
          renderedLinkPaths[packet.linkIndex],
          forward ? progress : 1 - progress,
        );
        const arrivalRadius = destination.radius + ACTIVITY_BEAD_BASE_RADIUS * activeSettings.pulseSize;
        const hasReachedDestination = progress >= 1
          || activityPoint.distanceToSquared(destination) <= arrivalRadius * arrivalRadius;
        if (hasReachedDestination) {
          activePackets.splice(packetIndex, 1);
          activeImpacts.push({ nodeIndex: packet.destinationIndex, startedAt: now });
          nodeAfterglow[packet.destinationIndex] = Math.min(
            ACTIVITY_NODE_AFTERGLOW_CEILING,
            nodeAfterglow[packet.destinationIndex] + ACTIVITY_NODE_AFTERGLOW_DEPOSIT,
          );
          continue;
        }
        for (let bead = 0; bead < ACTIVITY_PACKET_BEADS; bead += 1) {
          const beadProgress = progress - bead * ACTIVITY_BEAD_SPACING;
          if (beadProgress < 0) continue;
          setQuadraticPoint(
            activityPoint,
            renderedLinkPaths[packet.linkIndex],
            forward ? beadProgress : 1 - beadProgress,
          );
          transform.position.copy(activityPoint);
          transform.scale.setScalar(activeSettings.pulseSize * (1 - bead * 0.12));
          transform.updateMatrix();
          activityMesh.setMatrixAt(beadInstance, transform.matrix);
          beadInstance += 1;
        }
      }
      activityMesh.count = beadInstance;
      activityMesh.instanceMatrix.needsUpdate = true;

      const elapsedAfterglowMs = afterglowUpdatedAt === 0 ? 0 : Math.max(0, now - afterglowUpdatedAt);
      const afterglowDecay = Math.pow(0.5, elapsedAfterglowMs / ACTIVITY_AFTERGLOW_HALF_LIFE_MS);
      let hasAfterglow = false;
      nodeAfterglow.forEach((energy, nodeIndex) => {
        const decayedEnergy = energy * afterglowDecay;
        nodeAfterglow[nodeIndex] = decayedEnergy < ACTIVITY_AFTERGLOW_EPSILON ? 0 : decayedEnergy;
        if (nodeAfterglow[nodeIndex] > 0) hasAfterglow = true;
      });
      linkAfterglow.forEach((energy, linkIndex) => {
        const decayedEnergy = energy * afterglowDecay;
        linkAfterglow[linkIndex] = decayedEnergy < ACTIVITY_AFTERGLOW_EPSILON ? 0 : decayedEnergy;
        if (linkAfterglow[linkIndex] > 0) hasAfterglow = true;
      });
      afterglowUpdatedAt = hasAfterglow ? now : 0;
      syncLinkColors();

      nodeImpact.set(nodeAfterglow);
      for (let impactIndex = activeImpacts.length - 1; impactIndex >= 0; impactIndex -= 1) {
        const currentImpact = activeImpacts[impactIndex];
        const progress = (now - currentImpact.startedAt) / ACTIVITY_IMPACT_DURATION_MS;
        if (progress >= 1) {
          activeImpacts.splice(impactIndex, 1);
          continue;
        }
        const flashStrength = 1 - THREE.MathUtils.smoothstep(
          progress,
          ACTIVITY_IMPACT_HOLD_RATIO,
          1,
        );
        nodeImpact[currentImpact.nodeIndex] = Math.min(
          1,
          nodeImpact[currentImpact.nodeIndex] + flashStrength,
        );
      }
      if (!syncNodeDepthOrderIfNeeded()) syncNodeImpactAttribute();
      renderer.render(scene, camera);

      if (activePackets.length > 0 || activeImpacts.length > 0 || hasAfterglow) {
        activityFrame = requestAnimationFrame(animateActivity);
      }
    }

    function setActivityEnabled(enabled: boolean) {
      activityIsEnabled = enabled;
      if (!enabled) {
        if (activityTimer !== null) clearTimeout(activityTimer);
        activityTimer = null;
        clearActivityVisuals();
        return;
      }
      syncActivityRunState();
    }

    function syncActivityRunState() {
      if (!activityCanRun()) {
        if (activityTimer !== null) clearTimeout(activityTimer);
        activityTimer = null;
        clearActivityVisuals();
      } else if (activityTimer === null) {
        scheduleNextActivity(500);
      }
    }

    function renderNow() {
      renderFrame = 0;
      syncNodeDepthOrderIfNeeded();
      syncLabels();
      syncLinkPositions();
      syncLinkVisibility();
      syncActivityRunState();
      renderer.render(scene, camera);
    }

    function requestRender() {
      if (renderFrame !== 0 || document.hidden) return;
      renderFrame = requestAnimationFrame(renderNow);
    }

    function setSelectedNodeId(nextNodeId: number | null) {
      const nextIndex = nextNodeId == null ? null : nodeIndex.get(nextNodeId) ?? null;
      selectedIndex = nextIndex != null && isNodeVisible(nextIndex) ? nextIndex : null;
      syncFocusNeighborhood();
      if (selectedIndex != null) fitCameraToIndex(selectedIndex);
      requestRender();
    }

    function resize() {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      linkMaterial.resolution.set(width, height);
      focusedLinkMaterial.resolution.set(width, height);
      requestRender();
    }

    function pickProjectedNode(rect: DOMRect): number | null {
      camera.updateMatrixWorld();
      const pointerX = pendingPointer.x - rect.left;
      const pointerY = pendingPointer.y - rect.top;
      const pixelsPerRadian = rect.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
      let nearestIndex: number | null = null;
      let nearestDepth = Number.POSITIVE_INFINITY;

      sceneNodes.forEach((node, index) => {
        if (!isNodeVisible(index)) return;
        cameraSpace.set(node.x, node.y, node.z).applyMatrix4(camera.matrixWorldInverse);
        const depth = -cameraSpace.z;
        if (depth <= 0) return;

        projected.set(node.x, node.y, node.z).project(camera);
        if (projected.z <= -1 || projected.z >= 1 || Math.abs(projected.x) > 1.02 || Math.abs(projected.y) > 1.02) return;
        const centerX = (projected.x * 0.5 + 0.5) * rect.width;
        const centerY = (-projected.y * 0.5 + 0.5) * rect.height;
        const projectedRadius = node.radius * pixelsPerRadian / depth;
        const hitRadius = Math.max(MIN_NODE_HIT_RADIUS_PX, projectedRadius);
        if (Math.hypot(pointerX - centerX, pointerY - centerY) > hitRadius || depth >= nearestDepth) return;
        nearestIndex = index;
        nearestDepth = depth;
      });

      return nearestIndex;
    }

    function resolvePickedIndex(rect: DOMRect): number | null {
      pointer.x = ((pendingPointer.x - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((pendingPointer.y - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const renderSlot = raycaster.intersectObject(nodeMesh, false)[0]?.instanceId ?? null;
      const candidateIndex = renderSlot == null ? null : nodeInstanceOrder[renderSlot] ?? null;
      const exactIndex = candidateIndex != null && isNodeVisible(candidateIndex) ? candidateIndex : null;
      return exactIndex ?? pickProjectedNode(rect);
    }

    function pickNode() {
      pointerFrame = 0;
      if (cameraInteractionActive) return;
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const nextHoveredIndex = resolvePickedIndex(rect);
      if (nextHoveredIndex === hoveredIndex) return;
      hoveredIndex = nextHoveredIndex;
      syncFocusNeighborhood();
      renderer.domElement.style.cursor = hoveredIndex == null ? "grab" : "pointer";
      onNodeHoverRef.current(hoveredIndex == null ? null : sceneNodes[hoveredIndex].id);
      requestRender();
    }

    function handlePointerMove(event: PointerEvent) {
      pendingPointer = { x: event.clientX, y: event.clientY };
      if (!cameraInteractionActive && pointerFrame === 0) pointerFrame = requestAnimationFrame(pickNode);
    }

    function handlePointerDown(event: PointerEvent) {
      pointerDown = { x: event.clientX, y: event.clientY };
      renderer.domElement.style.cursor = hoveredIndex == null ? "grabbing" : "pointer";
    }

    function handlePointerUp(event: PointerEvent) {
      const moved = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
      if (moved < 6) {
        // Touch has no hover phase, so resolve the node under the release point
        // directly rather than relying on a hoveredIndex a pointermove never set.
        pendingPointer = { x: event.clientX, y: event.clientY };
        const rect = renderer.domElement.getBoundingClientRect();
        const tappedIndex = rect.width > 0 && rect.height > 0 ? resolvePickedIndex(rect) : hoveredIndex;
        if (tappedIndex != null) {
          hoveredIndex = tappedIndex;
          onNodeSelectRef.current(sceneNodes[tappedIndex].id);
        } else {
          onBackgroundSelectRef.current?.();
        }
      }
      renderer.domElement.style.cursor = hoveredIndex == null ? "grab" : "pointer";
    }

    function handlePointerLeave() {
      if (pointerFrame !== 0) cancelAnimationFrame(pointerFrame);
      pointerFrame = 0;
      hoveredIndex = null;
      syncFocusNeighborhood();
      renderer.domElement.style.cursor = "grab";
      onNodeHoverRef.current(null);
      requestRender();
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        syncActivityRunState();
        return;
      }
      requestRender();
      syncActivityRunState();
    }

    let simulation: Simulation<SceneNode> | null = null;
    let layoutWorker: Worker | null = null;
    let layoutRestartTimer: ReturnType<typeof setTimeout> | null = null;

    // The layout worker streams each full-graph solve as a *segment endpoint*, not a
    // final display position. Capture current displayed positions as the segment start,
    // the new solve as the end, and let the render clock walk the segment at constant
    // velocity so motion stays continuous between sparse worker posts.
    function setLayoutTargets(positions: Float32Array) {
      const count = Math.min(sceneNodes.length, Math.floor(positions.length / 3));
      if (count === 0) return;
      const now = performance.now();
      if (!layoutFrom || layoutFrom.length < count * 3) {
        layoutFrom = new Float32Array(count * 3);
      }
      if (!layoutTo || layoutTo.length < count * 3) {
        layoutTo = new Float32Array(count * 3);
      }
      for (let index = 0; index < count; index += 1) {
        const node = sceneNodes[index];
        layoutFrom[index * 3] = node.x;
        layoutFrom[index * 3 + 1] = node.y;
        layoutFrom[index * 3 + 2] = node.z;
      }
      layoutTo.set(positions.subarray(0, count * 3));
      // First post after the silent prestabilize burst admits the graph. Nodes stay
      // hidden until this call so the cold random cloud never paints.
      if (!layoutAdmitted) {
        layoutAdmitted = true;
        nodeDepthOrderDirty = true;
        syncFocusNeighborhood();
        sortNodeInstancesByDepth();
        syncLinkVisibility();
        syncActivityRunState();
        // The mount-time fit ran on an empty set — admission hides every node until the
        // prestabilized cloud arrives here. Frame the graph now, on first paint, with
        // extra padding so the remaining settle expansion never crops it. This is the
        // only automatic camera move: nothing re-fits at rest, so there is no late
        // camera motion after launch. Skip if the user already grabbed the camera.
        if (!userHasAdjustedCamera) {
          fitCamera(
            camera,
            controls,
            sceneNodes.filter((_node, index) => isNodeVisible(index)),
            1.4,
          );
        }
      }
      // Streaming posts track the real inter-post gap. The final `end` segment uses a
      // longer ease-out so the graph settles instead of slamming into the last solve.
      if (layoutFinalSegment) {
        layoutSegmentDuration = LAYOUT_FINAL_SEGMENT_MS;
      } else if (lastLayoutPostAt > 0) {
        const measured = now - lastLayoutPostAt;
        layoutSegmentDuration = Math.min(
          LAYOUT_INTERP_MAX_MS,
          Math.max(LAYOUT_INTERP_MIN_MS, measured),
        );
      } else {
        layoutSegmentDuration = LAYOUT_INTERP_DEFAULT_MS;
      }
      lastLayoutPostAt = now;
      layoutSegmentStart = now;
      layoutInterpolating = true;
      if (layoutFrame === 0) layoutFrame = requestAnimationFrame(animateLayout);
    }

    // Constant-velocity lerp from the previous displayed state to the latest worker solve.
    // t runs 0→1 over the measured inter-post interval, then holds at the endpoint until
    // the next post opens a new segment. Off-screen nodes snap; nobody watches them settle.
    // Returns the clamped t so the animate loop can stop after a final segment.
    function advanceLayoutInterpolation(now: number): number | null {
      const from = layoutFrom;
      const to = layoutTo;
      if (!from || !to || !layoutInterpolating) return null;
      const elapsed = now - layoutSegmentStart;
      const linearT = Math.min(1, Math.max(0, elapsed / layoutSegmentDuration));
      // Streaming segments stay linear so motion matches the worker cadence. The final
      // settle eases out (smoothstep) so the graph arrives rather than slamming home.
      const t = layoutFinalSegment
        ? linearT * linearT * (3 - 2 * linearT)
        : linearT;
      const count = Math.min(sceneNodes.length, Math.floor(to.length / 3));
      for (let index = 0; index < count; index += 1) {
        const node = sceneNodes[index];
        const toX = to[index * 3];
        const toY = to[index * 3 + 1];
        const toZ = to[index * 3 + 2];
        if (!isNodeVisible(index) || linearT >= 1) {
          node.x = toX;
          node.y = toY;
          node.z = toZ;
          continue;
        }
        const fromX = from[index * 3];
        const fromY = from[index * 3 + 1];
        const fromZ = from[index * 3 + 2];
        node.x = fromX + (toX - fromX) * t;
        node.y = fromY + (toY - fromY) * t;
        node.z = fromZ + (toZ - fromZ) * t;
      }
      // Hold at the endpoint (t=1) until the next worker post opens a new segment.
      // Do not clear layoutInterpolating here — that would drop the rAF loop between posts
      // and reintroduce the discrete jump. The end message (or cleanup) stops the loop.
      return linearT;
    }

    // Continuous render-clock loop that drives physics interpolation for as long as the
    // worker is posting. Runs the same per-post sync the snapped path used, so downstream
    // depth ordering, link geometry, activity eligibility, and labels stay consistent.
    function animateLayout(now: number) {
      layoutFrame = 0;
      const t = advanceLayoutInterpolation(now);
      if (t !== null) {
        simulationTick += 1;
        sortNodeInstancesByDepth();
        syncLinkPositions();
        syncLinkVisibility();
        syncActivityRunState();
        if (simulationTick % LABEL_POSITION_TICKS === 0) syncLabels();
        renderer.render(scene, camera);
        if (layoutFinalSegment && t >= 1) {
          stopLayoutInterpolation();
          return;
        }
      }
      if (layoutInterpolating) {
        layoutFrame = requestAnimationFrame(animateLayout);
      }
    }

    function stopLayoutInterpolation() {
      layoutInterpolating = false;
      layoutFinalSegment = false;
      lastLayoutPostAt = 0;
      if (layoutFrame !== 0) {
        cancelAnimationFrame(layoutFrame);
        layoutFrame = 0;
      }
    }

    // Fail-open fallback: same force profile as the worker, on the main thread.
    // Adaptive Barnes-Hut params match graph-layout-worker so both paths share cost.
    function startMainThreadSimulation() {
      if (simulation) {
        simulation.stop();
        simulation.on("tick", null);
        simulation.on("end", null);
      }
      const nodeCount = sceneNodes.length;
      const chargeTheta = nodeCount > 900 ? 1.25
        : nodeCount > 500 ? 1.1
        : nodeCount > 250 ? 0.95
        : 0.85;
      const chargeDistanceMax = nodeCount > 900 ? 260
        : nodeCount > 500 ? 320
        : nodeCount > 250 ? 400
        : 480;
      const linkForce = forceLink<SceneNode, SceneLink>(simulationLinks)
        .id((node) => node.id)
        .distance((link) => {
          const from = sceneNodes[link.fromIndex];
          const to = sceneNodes[link.toIndex];
          const strength = Math.max(0.1, link.strength || 0.5);
          return from.radius + to.radius + 38 + (1 - strength) * 62;
        })
        .strength((link) => (
          0.08 + Math.max(0.1, link.strength || 0.5) * 0.12
        ) * activeSettings.linkAttractionFactor)
        .iterations(1);
      simulation = forceSimulation(sceneNodes, 3)
        .force("charge", forceManyBody<SceneNode>()
          .strength((node) => -(135 + Math.sqrt(node.degree) * 9) * activeSettings.nodeRepulsionFactor)
          .theta(chargeTheta)
          .distanceMin(2)
          .distanceMax(chargeDistanceMax))
        .force("links", linkForce)
        .force("collision", forceCollide<SceneNode>((node) => node.radius + 8).strength(0.88).iterations(1))
        .force("x", forceX<SceneNode>(0).strength(0.0015))
        .force("y", forceY<SceneNode>(0).strength(0.0015))
        .force("z", forceZ<SceneNode>(0).strength(0.0015))
        .alphaMin(0.002)
        .alphaDecay(1 - Math.pow(0.002, 1 / 520))
        .velocityDecay(0.3);
      simulation.on("tick", () => {
        simulationTick += 1;
        sortNodeInstancesByDepth();
        syncLinkPositions();
        syncLinkVisibility();
        syncActivityRunState();
        if (simulationTick % LABEL_POSITION_TICKS === 0) syncLabels();
        renderer.render(scene, camera);
      });
      simulation.on("end", requestRender);
    }

    function restartLayoutFromCurrentPositions() {
      layoutRestartTimer = null;
      layoutRevision += 1;
      // Drop any in-flight segment and forget the prior post clock so the first post of
      // the new solve opens a fresh DEFAULT_MS segment instead of stretching across the gap.
      // Hide the graph again until the worker finishes its silent prestabilize burst and
      // posts the first admitted positions; labels stay closed until the layout rests.
      stopLayoutInterpolation();
      layoutAdmitted = false;
      layoutRested = false;
      layoutFinalSegment = false;
      if (layoutWorker) {
        if (simulation) {
          simulation.stop();
          simulation.on("tick", null);
          simulation.on("end", null);
          simulation = null;
        }
        layoutWorker.postMessage({
          type: "init",
          revision: layoutRevision,
          nodes: sceneNodes.map((node) => ({
            id: node.id,
            degree: node.degree,
            radius: node.radius,
            x: node.x,
            y: node.y,
            z: node.z,
          })),
          links: simulationLinks.map((link) => ({
            id: link.id,
            fromId: link.fromId,
            toId: link.toId,
            strength: link.strength,
          })),
          settings: {
            linkAttractionFactor: activeSettings.linkAttractionFactor,
            nodeRepulsionFactor: activeSettings.nodeRepulsionFactor,
          },
        });
      } else {
        startMainThreadSimulation();
      }
    }

    function scheduleLayoutRestart() {
      if (layoutRestartTimer !== null) clearTimeout(layoutRestartTimer);
      layoutRestartTimer = setTimeout(restartLayoutFromCurrentPositions, 80);
    }

    // Compute layout off the main thread so the interactive init task stays bounded.
    try {
      layoutWorker = new Worker(new URL("../../lib/graph-layout-worker.ts", import.meta.url), { type: "module" });
    } catch {
      layoutWorker = null;
    }
    if (layoutWorker) {
      layoutWorker.onmessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; revision?: number; positions?: Float32Array };
        if (data.revision !== layoutRevision) return;
        if (data.type === "positions" && data.positions) {
          layoutFinalSegment = false;
          setLayoutTargets(data.positions);
        } else if (data.type === "end") {
          // Rest signal: open focus-only labels after the final ease-to-stop segment.
          layoutRested = true;
          if (data.positions) {
            layoutFinalSegment = true;
            setLayoutTargets(data.positions);
          } else {
            stopLayoutInterpolation();
          }
          syncLabels();
          recordBrowserTelemetry({
            kind: "graph",
            name: "layout_settled",
            value: Math.max(0, performance.now() - effectStartedAt),
            unit: "ms",
            metadata: { nodes: sceneNodes.length, links: simulationLinks.length, worker: true },
          });
          requestRender();
        }
      };
      layoutWorker.onerror = () => {
        layoutWorker?.terminate();
        layoutWorker = null;
        startMainThreadSimulation();
      };
    }
    restartLayoutFromCurrentPositions();

    function updateVisibleNodeIds(nextVisibleNodeIds: ReadonlySet<number>) {
      activeVisibleNodeIds = new Set(nextVisibleNodeIds);

      if (hoveredIndex != null && !isNodeVisible(hoveredIndex)) {
        hoveredIndex = null;
        onNodeHoverRef.current(null);
      }
      if (selectedIndex != null && !isNodeVisible(selectedIndex)) selectedIndex = null;

      for (let packetIndex = activePackets.length - 1; packetIndex >= 0; packetIndex -= 1) {
        const packet = activePackets[packetIndex];
        if (!isNodeVisible(packet.sourceIndex) || !isNodeVisible(packet.destinationIndex)) {
          activePackets.splice(packetIndex, 1);
        }
      }
      for (let impactIndex = activeImpacts.length - 1; impactIndex >= 0; impactIndex -= 1) {
        if (!isNodeVisible(activeImpacts[impactIndex].nodeIndex)) activeImpacts.splice(impactIndex, 1);
      }
      sceneNodes.forEach((_node, index) => {
        if (isNodeVisible(index)) return;
        nodeAfterglow[index] = 0;
        nodeImpact[index] = 0;
        lastPulseAtByNodeIndex.delete(index);
      });
      simulationLinks.forEach((link, linkIndex) => {
        if (!isLinkVisible(link)) linkAfterglow[linkIndex] = 0;
      });
      activityMesh.count = 0;

      nodeDepthOrderDirty = true;
      syncFocusNeighborhood();
      sortNodeInstancesByDepth();
      syncLinkVisibility();
      syncLabels();
      syncNodeImpactAttribute();
      syncActivityRunState();
      requestRender();
    }

    function updateSettings(nextSettings: MemoryGraphSettings) {
      const previousSettings = activeSettings;
      activeSettings = nextSettings;
      const radiiChanged = previousSettings.smallestNode !== nextSettings.smallestNode
        || previousSettings.largestNode !== nextSettings.largestNode;
      const forcesChanged = previousSettings.linkAttractionFactor !== nextSettings.linkAttractionFactor
        || previousSettings.nodeRepulsionFactor !== nextSettings.nodeRepulsionFactor;
      const recencyChanged = previousSettings.recencyBrightness !== nextSettings.recencyBrightness;
      const complexityChanged = previousSettings.linkComplexity !== nextSettings.linkComplexity;

      nodeMaterial.uniforms.uNodeBrightness.value = nextSettings.nodeBrightnessFactor;
      nodeMaterial.uniforms.uPulseBrightness.value = nextSettings.pulseBrightness;
      nodeMaterial.uniformsNeedUpdate = true;

      if (radiiChanged) {
        const degrees = sceneNodes.map((node) => node.degree);
        const minDegree = Math.min(...degrees);
        const maxDegree = Math.max(...degrees);
        const degreeRange = Math.max(1, maxDegree - minDegree);
        sceneNodes.forEach((node) => {
          const degreeRatio = (node.degree - minDegree) / degreeRange;
          node.radius = nextSettings.smallestNode
            + Math.pow(degreeRatio, 0.6) * (nextSettings.largestNode - nextSettings.smallestNode);
        });
      }
      if (recencyChanged) syncNodeBaseColors();
      if (complexityChanged) curveSegments = nextSettings.linkComplexity;

      syncNodeAppearance();
      syncLinkPositions();
      syncLinkVisibility();
      syncLabels();
      nodeDepthOrderDirty = true;
      if (radiiChanged || forcesChanged) scheduleLayoutRestart();
      if (activityTimer !== null && previousSettings.pulseRate !== nextSettings.pulseRate) {
        scheduleNextActivity(activityEmitGapMs(nextSettings.pulseRate, activeVisibleNodeIds.size));
      }
      requestRender();
    }

    function handleControlsStart() {
      cameraInteractionActive = true;
      userHasAdjustedCamera = true;
      if (pointerFrame !== 0) cancelAnimationFrame(pointerFrame);
      pointerFrame = 0;
      if (hoveredIndex !== null) {
        hoveredIndex = null;
        syncFocusNeighborhood();
        onNodeHoverRef.current(null);
      }
      renderer.domElement.style.cursor = "grabbing";
    }

    function handleControlsChange() {
      nodeDepthOrderDirty = true;
      syncCameraClippingPlanes(camera, controls.target);
      requestRender();
    }

    function handleControlsEnd() {
      cameraInteractionActive = false;
      renderer.domElement.style.cursor = "grab";
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    controls.addEventListener("start", handleControlsStart);
    controls.addEventListener("change", handleControlsChange);
    controls.addEventListener("end", handleControlsEnd);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("pointerleave", handlePointerLeave);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    resize();
    fitCamera(
      camera,
      controls,
      sceneNodes.filter((_node, index) => isNodeVisible(index)),
    );
    sortNodeInstancesByDepth();
    syncLinkPositions();
    syncFocusNeighborhood();
    // Durable performance instrumentation for the named budgets. The heavy force layout
    // now runs in the worker, so this synchronous init task should stay under budget.
    recordBrowserTelemetry({
      kind: "graph",
      name: "init_task",
      value: Math.max(0, performance.now() - effectStartedAt),
      unit: "ms",
      metadata: { nodes: sceneNodes.length, links: simulationLinks.length },
    });
    recordBrowserTelemetry({
      kind: "graph",
      name: "first_interactive",
      value: Math.max(0, performance.now() - effectStartedAt),
      unit: "ms",
      bucket: host.clientWidth < ACTIVITY_MOBILE_BREAKPOINT_PX ? "mobile" : "desktop",
    });
    runtimeRef.current = {
      camera,
      controls,
      nodes: sceneNodes,
      requestRender,
      refreshAppearance: () => {
        syncNodeAppearance();
        requestRender();
      },
      setActivityEnabled,
      setSelectedNodeId,
      updateSettings,
      updateVisibleNodeIds,
    };
    updateSettings(settingsRef.current);
    updateVisibleNodeIds(visibleNodeIdsRef.current);
    requestRender();
    if (activityIsEnabled && activityTimer === null) scheduleNextActivity(600);

    return () => {
      if (layoutWorker) {
        layoutWorker.terminate();
        layoutWorker = null;
      }
      if (simulation) {
        simulation.stop();
        simulation.on("tick", null);
        simulation.on("end", null);
      }
      if (renderFrame !== 0) cancelAnimationFrame(renderFrame);
      if (pointerFrame !== 0) cancelAnimationFrame(pointerFrame);
      if (activityFrame !== 0) cancelAnimationFrame(activityFrame);
      stopLayoutInterpolation();
      layoutFrom = null;
      layoutTo = null;
      if (activityTimer !== null) clearTimeout(activityTimer);
      if (layoutRestartTimer !== null) clearTimeout(layoutRestartTimer);
      runtimeRef.current = null;
      resizeObserver.disconnect();
      controls.removeEventListener("start", handleControlsStart);
      controls.removeEventListener("change", handleControlsChange);
      controls.removeEventListener("end", handleControlsEnd);
      controls.dispose();
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      nodeGeometry.dispose();
      nodeMaterial.dispose();
      linkGeometry.dispose();
      linkMaterial.dispose();
      focusedLinkGeometry.dispose();
      focusedLinkMaterial.dispose();
      activityGeometry.dispose();
      activityMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [links, nodes]);

  return (
    <div ref={hostRef} className="relative h-full w-full overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,hsl(var(--cta)/0.06),transparent_60%)]" />
      <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-hidden="true">
        {overlayNodes.map((node) => (
          <div
            key={node.id}
            ref={(element) => {
              if (element) labelRefs.current.set(node.id, element);
              else labelRefs.current.delete(node.id);
            }}
            className="absolute left-0 top-0 flex flex-col items-center will-change-transform"
            title={node.label}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center text-active drop-shadow-md">
              <MemorySourceIcon source={node.source} className="h-4 w-4" />
            </span>
            {nodeDetail?.nodeId !== node.id && (
              <span className="mt-0.5 max-w-[180px] truncate whitespace-nowrap rounded-md bg-card/80 px-1.5 py-0.5 text-[10px] font-medium text-foreground/90 shadow-sm backdrop-blur-sm">
                {truncateLabelToWords(node.label)}
              </span>
            )}
          </div>
        ))}
      </div>
      {nodeDetail && (
        <div
          ref={detailRef}
          className={nodeDetail.interactive ? "absolute left-0 top-0 z-30 will-change-transform" : "pointer-events-none absolute left-0 top-0 z-30 will-change-transform"}
          data-testid={`memory-graph-node-detail-${nodeDetail.nodeId}`}
        >
          {nodeDetail.content}
        </div>
      )}
    </div>
  );
});
