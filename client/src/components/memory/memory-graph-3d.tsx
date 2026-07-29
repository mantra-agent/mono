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

interface GraphAdjacency {
  neighborsByNodeId: Map<number, Set<number>>;
  simulationLinksByNodeId: Map<number, SceneLink[]>;
  renderedLinkIndicesByNodeId: Map<number, Set<number>>;
}

interface GraphRuntime {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  nodes: SceneNode[];
  requestRender: () => void;
  refreshAppearance: () => void;
  setActivityEnabled: (enabled: boolean) => void;
  setSelectedNodeId: (nodeId: number | null) => void;
}

const CURVE_SEGMENTS = 3;
const MAX_RENDERED_LINKS = 2_500;
const LARGE_GRAPH_THRESHOLD = 1_000;
const LABEL_POSITION_TICKS = 4;
const INITIAL_LAYOUT_SCALE = 20;
const MIN_NODE_HIT_RADIUS_PX = 12;
const ACTIVITY_RECENCY_THRESHOLD = 0.25;
const ACTIVITY_VOLUME_MULTIPLIER = 10;
const ACTIVITY_PACKET_BEADS = 5;
const ACTIVITY_PACKET_DURATION_MS = 1_150;
const ACTIVITY_IMPACT_DURATION_MS = 520;
const ACTIVITY_IMPACT_HOLD_RATIO = 0.18;
const ACTIVITY_MEAN_EMIT_GAP_MS = 170;
const ACTIVITY_MIN_EMIT_GAP_MS = 45;
const ACTIVITY_MAX_EMIT_GAP_MS = 900;
const ACTIVITY_RETRY_GAP_MS = 600;
const ACTIVITY_MIN_NODE_COOLDOWN_MS = 1_800;
const ACTIVITY_MAX_NODE_COOLDOWN_MS = 10_000;
const ACTIVITY_MAX_DESKTOP_PACKETS = 3 * ACTIVITY_VOLUME_MULTIPLIER;
const ACTIVITY_MAX_MOBILE_PACKETS = ACTIVITY_VOLUME_MULTIPLIER;
const ACTIVITY_MOBILE_BREAKPOINT_PX = 768;
const ACTIVITY_BEAD_SPACING = 0.035;
const ACTIVITY_BEAD_RADIUS = 1.1;
// Cold claims never disappear entirely: they hold a faint floor so the field keeps its ghosts.
const RECENCY_OPACITY_FLOOR = 0.08;

function recencyToVisibility(recency: number): number {
  const heat = THREE.MathUtils.clamp(recency, 0, 1);
  return RECENCY_OPACITY_FLOOR + (1 - RECENCY_OPACITY_FLOOR) * Math.pow(heat, 2.2);
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
  varying vec3 vNormal;
  varying vec3 vViewDirection;
  varying vec3 vTint;
  varying float vVisibility;
  varying float vEmphasis;
  varying float vImpact;

  void main() {
    float facing = abs(dot(normalize(vNormal), normalize(vViewDirection)));
    float edge = 1.0 - facing;
    float rim = pow(edge, 1.6);
    float emphasis = 1.0 + vEmphasis * 0.5;
    vec3 baseColor = vTint * rim * emphasis;
    vec3 impactColor = mix(baseColor, vec3(1.0), vImpact);
    float impactAlpha = mix(vVisibility, 1.0, vImpact);
    gl_FragColor = vec4(impactColor, impactAlpha);
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

function buildGraphAdjacency(sceneNodes: SceneNode[], simulationLinks: SceneLink[], renderedLinks: SceneLink[]): GraphAdjacency {
  const neighborsByNodeId = new Map(sceneNodes.map((node) => [node.id, new Set<number>()]));
  const simulationLinksByNodeId = new Map(sceneNodes.map((node) => [node.id, [] as SceneLink[]]));
  const renderedLinkIndicesByNodeId = new Map(sceneNodes.map((node) => [node.id, new Set<number>()]));
  simulationLinks.forEach((link) => {
    neighborsByNodeId.get(link.fromId)?.add(link.toId);
    neighborsByNodeId.get(link.toId)?.add(link.fromId);
    simulationLinksByNodeId.get(link.fromId)?.push(link);
    simulationLinksByNodeId.get(link.toId)?.push(link);
  });
  renderedLinks.forEach((link, index) => {
    renderedLinkIndicesByNodeId.get(link.fromId)?.add(index);
    renderedLinkIndicesByNodeId.get(link.toId)?.add(index);
  });
  return { neighborsByNodeId, simulationLinksByNodeId, renderedLinkIndicesByNodeId };
}

function buildSceneGraph(nodes: MemoryGraph3DNode[], links: MemoryGraph3DLink[]) {
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
      radius: 2 + Math.pow(degreeRatio, 0.6) * 38,
    };
  });
  const nodeIndex = new Map(sceneNodes.map((node, index) => [node.id, index]));
  const simulationLinks = links.flatMap((link): SceneLink[] => {
    const fromIndex = nodeIndex.get(link.fromId);
    const toIndex = nodeIndex.get(link.toId);
    if (fromIndex == null || toIndex == null || fromIndex === toIndex) return [];
    return [{ ...link, source: link.fromId, target: link.toId, fromIndex, toIndex }];
  });
  const renderedLinks = [...simulationLinks]
    .sort((left, right) => right.strength - left.strength || left.id - right.id)
    .slice(0, MAX_RENDERED_LINKS);
  const adjacency = buildGraphAdjacency(sceneNodes, simulationLinks, renderedLinks);
  return { sceneNodes, simulationLinks, renderedLinks, nodeIndex, adjacency };
}

function syncCameraClippingPlanes(camera: THREE.PerspectiveCamera, target: THREE.Vector3) {
  const cameraDistance = camera.position.distanceTo(target);
  camera.near = Math.max(0.1, cameraDistance / 100_000);
  camera.far = Math.max(800, cameraDistance * 4);
  camera.updateProjectionMatrix();
}

function fitCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls, nodes: SceneNode[]) {
  if (nodes.length === 0) return;
  const bounds = new THREE.Box3();
  let maxNodeRadius = 0;
  nodes.forEach((node) => {
    bounds.expandByPoint(new THREE.Vector3(node.x, node.y, node.z));
    maxNodeRadius = Math.max(maxNodeRadius, node.radius);
  });
  bounds.expandByScalar(maxNodeRadius);
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const distance = Math.max(30, sphere.radius / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.16);
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
    (total, destinationPaths) => total + destinationPaths[0].destinationRecency ** 2,
    0,
  );
  if (totalWeight <= 0) return null;
  let roll = Math.random() * totalWeight;
  for (const destinationPaths of destinations) {
    roll -= destinationPaths[0].destinationRecency ** 2;
    if (roll <= 0) {
      return destinationPaths[Math.floor(Math.random() * destinationPaths.length)] ?? null;
    }
  }
  const fallbackPaths = destinations.at(-1);
  return fallbackPaths?.[Math.floor(Math.random() * fallbackPaths.length)] ?? null;
}

// Continuous Poisson emission: hotter fields emit faster, and exponential
// inter-arrival spacing keeps the stream organic rather than metronomic.
function activityEmitGapMs(recency: number) {
  const heat = THREE.MathUtils.smoothstep(recency, ACTIVITY_RECENCY_THRESHOLD, 1);
  const meanGap = THREE.MathUtils.lerp(ACTIVITY_MEAN_EMIT_GAP_MS * 1.8, ACTIVITY_MEAN_EMIT_GAP_MS, heat);
  const poissonGap = -Math.log(1 - Math.random()) * meanGap;
  return THREE.MathUtils.clamp(poissonGap, ACTIVITY_MIN_EMIT_GAP_MS, ACTIVITY_MAX_EMIT_GAP_MS);
}

export const MemoryGraph3D = forwardRef<MemoryGraph3DHandle, MemoryGraph3DProps>(function MemoryGraph3D(
  {
    nodes,
    links,
    selectedNodeId,
    highlightedNodeIds,
    activityEnabled,
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
    return nodes.filter((node) => (
      highlightedNodeIds.has(node.id)
      || focusNeighborhood.has(node.id)
      || selectedNodeId === node.id
    ));
  }, [focusNeighborhoodNodeIds, highlightedNodeIds, nodes, selectedNodeId]);

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
      fitCamera(runtime.camera, runtime.controls, runtime.nodes);
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
    runtimeRef.current?.requestRender();
  }, [nodeDetail, overlayNodes]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || nodes.length === 0) return;

    const { sceneNodes, simulationLinks, renderedLinks, nodeIndex, adjacency } = buildSceneGraph(nodes, links);
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
    const activeColor = colorFromToken("--active");
    const selectedColor = colorFromToken("--foreground");
    const deletionColor = colorFromToken("--destructive");
    // Recency heat ramp, tokens only: recency 1.0 glows the brighter interactive blue
    // (--active); at ~0.5 it cools to the darker CTA blue (--cta); below that the node
    // stays CTA-hued but fades via visibility toward the canvas, floored so it lingers.
    const nodeBaseColors = sceneNodes.map((node) => {
      const heat = THREE.MathUtils.clamp(node.recency, 0, 1);
      const warmth = THREE.MathUtils.smoothstep(heat, 0.45, 1);
      return signalColor.clone().lerp(activeColor, warmth);
    });
    const nodeGeometry = new THREE.IcosahedronGeometry(1, 2);
    const visibility = new Float32Array(sceneNodes.length);
    const emphasis = new Float32Array(sceneNodes.length);
    const impact = new Float32Array(sceneNodes.length);
    const tints = new Float32Array(sceneNodes.length * 3);
    sceneNodes.forEach((node, index) => {
      visibility[index] = recencyToVisibility(node.recency);
      (node.pendingDeletion ? deletionColor : nodeBaseColors[index]).toArray(tints, index * 3);
    });
    nodeGeometry.setAttribute("aVisibility", new THREE.InstancedBufferAttribute(visibility, 1));
    nodeGeometry.setAttribute("aEmphasis", new THREE.InstancedBufferAttribute(emphasis, 1));
    nodeGeometry.setAttribute("aImpact", new THREE.InstancedBufferAttribute(impact, 1));
    nodeGeometry.setAttribute("aTint", new THREE.InstancedBufferAttribute(tints, 3));

    const nodeMaterial = new THREE.ShaderMaterial({
      vertexShader: nodeVertexShader,
      fragmentShader: nodeFragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
    });
    const nodeMesh = new THREE.InstancedMesh(nodeGeometry, nodeMaterial, sceneNodes.length);
    nodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    nodeMesh.frustumCulled = false;
    scene.add(nodeMesh);

    const linkPositions = new Float32Array(renderedLinks.length * CURVE_SEGMENTS * 6);
    const linkColors = new Float32Array(renderedLinks.length * CURVE_SEGMENTS * 6);
    const focusedLinkCapacity = Math.max(
      0,
      ...[...adjacency.simulationLinksByNodeId.values()].map((incidentLinks) => incidentLinks.length),
    );
    const focusedLinkPositions = new Float32Array(focusedLinkCapacity * CURVE_SEGMENTS * 6);
    const focusedLinkColors = new Float32Array(focusedLinkCapacity * CURVE_SEGMENTS * 6);
    const linkBrightness = new Float32Array(renderedLinks.length);
    const nodeLinkVisibility = new Float32Array(sceneNodes.length);
    const linkGeometry = new LineSegmentsGeometry();
    const focusedLinkGeometry = new LineSegmentsGeometry();
    const baseLinkColor = signalColor.clone().multiplyScalar(0.5);
    renderedLinks.forEach((link, linkIndex) => {
      const brightness = (0.15 + Math.pow(Math.max(0, link.strength), 1.6) * 0.85) * 0.18;
      linkBrightness[linkIndex] = brightness;
      for (let segment = 0; segment < CURVE_SEGMENTS; segment += 1) {
        const offset = (linkIndex * CURVE_SEGMENTS + segment) * 6;
        linkColors[offset] = baseLinkColor.r * brightness;
        linkColors[offset + 1] = baseLinkColor.g * brightness;
        linkColors[offset + 2] = baseLinkColor.b * brightness;
        linkColors[offset + 3] = baseLinkColor.r * brightness;
        linkColors[offset + 4] = baseLinkColor.g * brightness;
        linkColors[offset + 5] = baseLinkColor.b * brightness;
      }
    });
    linkGeometry.setPositions(linkPositions);
    linkGeometry.setColors(linkColors);
    focusedLinkGeometry.setPositions(focusedLinkPositions);
    focusedLinkGeometry.setColors(focusedLinkColors);
    const linkMaterial = new LineMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.45,
      linewidth: 1,
      depthWrite: false,
      resolution: new THREE.Vector2(host.clientWidth, host.clientHeight),
    });
    const focusedLinkMaterial = new LineMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      linewidth: 2.5,
      depthWrite: false,
      resolution: new THREE.Vector2(host.clientWidth, host.clientHeight),
    });
    const linkLines = new LineSegments2(linkGeometry, linkMaterial);
    const focusedLinkLines = new LineSegments2(focusedLinkGeometry, focusedLinkMaterial);
    linkLines.frustumCulled = false;
    focusedLinkLines.frustumCulled = false;
    focusedLinkLines.visible = false;
    scene.add(linkLines);
    scene.add(focusedLinkLines);

    const maxActivityPackets = host.clientWidth < ACTIVITY_MOBILE_BREAKPOINT_PX
      ? ACTIVITY_MAX_MOBILE_PACKETS
      : ACTIVITY_MAX_DESKTOP_PACKETS;
    const activityGeometry = new THREE.SphereGeometry(ACTIVITY_BEAD_RADIUS, 8, 8);
    const activityMaterial = new THREE.MeshBasicMaterial({
      color: activeColor,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
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
    scene.add(activityMesh);

    const transform = new THREE.Object3D();
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const projected = new THREE.Vector3();
    const cameraSpace = new THREE.Vector3();
    let selectedIndex = selectedNodeIdRef.current == null ? null : nodeIndex.get(selectedNodeIdRef.current) ?? null;
    let hoveredIndex: number | null = null;
    let focusNeighborIndices = new Set<number>();
    let focusedSimulationLinks: SceneLink[] = [];
    let focusedRenderedLinkIndices = new Set<number>();
    let pointerDown = { x: 0, y: 0 };
    let pendingPointer = { x: 0, y: 0 };
    let renderFrame = 0;
    let pointerFrame = 0;
    let activityFrame = 0;
    let activityTimer: ReturnType<typeof setTimeout> | null = null;
    let activityIsEnabled = activityEnabledRef.current;
    let simulationTick = 0;
    const activePackets: ActivityPacket[] = [];
    const activeImpacts: ActivityImpact[] = [];
    const lastPulseAtByNodeIndex = new Map<number, number>();
    const activityPoint = new THREE.Vector3();
    const renderedLinkPaths: QuadraticLinkPath[] = renderedLinks.map(() => ({
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
    const activityPaths: ActivityPath[] = renderedLinks.flatMap((link, linkIndex) => {
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

    function getNodeScale(index: number) {
      const focusIndex = hoveredIndex ?? selectedIndex;
      if (hoveredIndex === index) return 1.28;
      if (selectedIndex === index) return 1.22;
      if (focusNeighborIndices.has(index)) return 1.14;
      return focusIndex == null ? 1 : 0.94;
    }

    function syncNodeMatrices() {
      sceneNodes.forEach((node, index) => {
        transform.position.set(node.x, node.y, node.z);
        transform.scale.setScalar(node.radius * getNodeScale(index));
        transform.updateMatrix();
        nodeMesh.setMatrixAt(index, transform.matrix);
      });
      nodeMesh.instanceMatrix.needsUpdate = true;
    }

    function writeLinkCurve(positions: Float32Array, link: SceneLink, linkIndex: number, captureActivityPath = false) {
      const from = sceneNodes[link.fromIndex];
      const to = sceneNodes[link.toIndex];
      let dx = to.x - from.x;
      let dy = to.y - from.y;
      let dz = to.z - from.z;
      const distance = Math.max(0.001, Math.sqrt(dx * dx + dy * dy + dz * dz));
      dx /= distance;
      dy /= distance;
      dz /= distance;
      const fromX = from.x + dx * from.radius * 0.94;
      const fromY = from.y + dy * from.radius * 0.94;
      const fromZ = from.z + dz * from.radius * 0.94;
      const toX = to.x - dx * to.radius * 0.94;
      const toY = to.y - dy * to.radius * 0.94;
      const toZ = to.z - dz * to.radius * 0.94;
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
      const arc = Math.min(14, 2 + distance * 0.05) * (0.75 + seededUnit(link.id, 21) * 0.5);
      const controlX = (fromX + toX) * 0.5 + perpendicularX / perpendicularLength * arc;
      const controlY = (fromY + toY) * 0.5 + perpendicularY / perpendicularLength * arc;
      const controlZ = (fromZ + toZ) * 0.5 + perpendicularZ / perpendicularLength * arc;
      if (captureActivityPath) {
        const path = renderedLinkPaths[linkIndex];
        path.fromX = fromX;
        path.fromY = fromY;
        path.fromZ = fromZ;
        path.controlX = controlX;
        path.controlY = controlY;
        path.controlZ = controlZ;
        path.toX = toX;
        path.toY = toY;
        path.toZ = toZ;
      }
      for (let segment = 0; segment < CURVE_SEGMENTS; segment += 1) {
        const offset = (linkIndex * CURVE_SEGMENTS + segment) * 6;
        writeQuadraticPoint(positions, offset, fromX, fromY, fromZ, controlX, controlY, controlZ, toX, toY, toZ, segment / CURVE_SEGMENTS);
        writeQuadraticPoint(positions, offset + 3, fromX, fromY, fromZ, controlX, controlY, controlZ, toX, toY, toZ, (segment + 1) / CURVE_SEGMENTS);
      }
    }

    function syncLinkPositions() {
      renderedLinks.forEach((link, linkIndex) => writeLinkCurve(linkPositions, link, linkIndex, true));
      const instanceStartAttr = linkGeometry.getAttribute("instanceStart");
      if (instanceStartAttr && "data" in instanceStartAttr) (instanceStartAttr as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
    }

    function syncFocusedLinkGeometry() {
      focusedSimulationLinks.forEach((link, focusedLinkIndex) => {
        writeLinkCurve(focusedLinkPositions, link, focusedLinkIndex);
        const normalizedStrength = THREE.MathUtils.clamp(link.strength, 0, 1);
        const brightness = 0.55 + Math.pow(normalizedStrength, 1.25) * 0.45;
        for (let segment = 0; segment < CURVE_SEGMENTS; segment += 1) {
          const focusedOffset = (focusedLinkIndex * CURVE_SEGMENTS + segment) * 6;
          focusedLinkColors[focusedOffset] = activeColor.r * brightness;
          focusedLinkColors[focusedOffset + 1] = activeColor.g * brightness;
          focusedLinkColors[focusedOffset + 2] = activeColor.b * brightness;
          focusedLinkColors[focusedOffset + 3] = activeColor.r * brightness;
          focusedLinkColors[focusedOffset + 4] = activeColor.g * brightness;
          focusedLinkColors[focusedOffset + 5] = activeColor.b * brightness;
        }
      });
      focusedLinkGeometry.instanceCount = focusedSimulationLinks.length * CURVE_SEGMENTS;
      focusedLinkLines.visible = focusedSimulationLinks.length > 0;
      const focusedInstanceStart = focusedLinkGeometry.getAttribute("instanceStart");
      if (focusedInstanceStart && "data" in focusedInstanceStart) {
        (focusedInstanceStart as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
      }
      const focusedInstanceColorStart = focusedLinkGeometry.getAttribute("instanceColorStart");
      if (focusedInstanceColorStart && "data" in focusedInstanceColorStart) {
        (focusedInstanceColorStart as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
      }
    }

    function syncLinkVisibility() {
      camera.updateMatrixWorld();
      const focusIndex = hoveredIndex ?? selectedIndex;
      const viewportHeight = Math.max(1, host.clientHeight);
      const pixelsPerRadian = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
      sceneNodes.forEach((node, index) => {
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
          * recencyToVisibility(node.recency)
          * (unrelated ? 0.62 : 1);
      });

      renderedLinks.forEach((link, linkIndex) => {
        const endpointVisibility = Math.min(nodeLinkVisibility[link.fromIndex], nodeLinkVisibility[link.toIndex]);
        const focusDim = focusIndex != null && !focusedRenderedLinkIndices.has(linkIndex) ? 0.42 : 1;
        const brightness = linkBrightness[linkIndex] * endpointVisibility * focusDim;
        for (let segment = 0; segment < CURVE_SEGMENTS; segment += 1) {
          const offset = (linkIndex * CURVE_SEGMENTS + segment) * 6;
          linkColors[offset] = baseLinkColor.r * brightness;
          linkColors[offset + 1] = baseLinkColor.g * brightness;
          linkColors[offset + 2] = baseLinkColor.b * brightness;
          linkColors[offset + 3] = baseLinkColor.r * brightness;
          linkColors[offset + 4] = baseLinkColor.g * brightness;
          linkColors[offset + 5] = baseLinkColor.b * brightness;
        }
      });
      syncFocusedLinkGeometry();
      const instanceColorStart = linkGeometry.getAttribute("instanceColorStart");
      if (instanceColorStart && "data" in instanceColorStart) {
        (instanceColorStart as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
      }
    }

    function syncNodeAppearance() {
      const focusIndex = hoveredIndex ?? selectedIndex;
      sceneNodes.forEach((node, index) => {
        const isSelected = selectedIndex === index;
        const isFocus = focusIndex === index;
        const neighbor = focusNeighborIndices.has(index);
        const searchMatch = highlightedNodeIdsRef.current.has(node.id);
        const unrelated = focusIndex != null && !isFocus && !neighbor;
        emphasis[index] = isSelected || isFocus ? 1 : neighbor ? 0.58 : searchMatch ? 0.72 : unrelated ? -0.35 : 0;
        const tint = isSelected
          ? selectedColor
          : node.pendingDeletion
            ? deletionColor
            : isFocus || neighbor || searchMatch
              ? activeColor
              : nodeBaseColors[index];
        tint.toArray(tints, index * 3);
        visibility[index] = isSelected
          ? 1
          : recencyToVisibility(node.recency) * (unrelated ? 0.62 : 1);
      });
      syncNodeMatrices();
      (nodeGeometry.getAttribute("aVisibility") as THREE.InstancedBufferAttribute).needsUpdate = true;
      (nodeGeometry.getAttribute("aEmphasis") as THREE.InstancedBufferAttribute).needsUpdate = true;
      (nodeGeometry.getAttribute("aTint") as THREE.InstancedBufferAttribute).needsUpdate = true;
    }

    function neighborIndicesOf(index: number | null): Set<number> {
      if (index == null) return new Set<number>();
      const node = sceneNodes[index];
      const neighborNodeIds = adjacency.neighborsByNodeId.get(node.id) ?? new Set<number>();
      return new Set(
        [...neighborNodeIds].flatMap((nodeId): number[] => {
          const neighborIndex = nodeIndex.get(nodeId);
          return neighborIndex == null ? [] : [neighborIndex];
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
      focusedSimulationLinks = focusNode == null
        ? []
        : adjacency.simulationLinksByNodeId.get(focusNode.id) ?? [];
      focusedRenderedLinkIndices = focusNode == null
        ? new Set<number>()
        : new Set(adjacency.renderedLinkIndicesByNodeId.get(focusNode.id) ?? []);
      const neighborNodeIds = [...focusNeighborIndices].map((index) => sceneNodes[index].id);
      setFocusNeighborhoodNodeIds(focusNode == null ? [] : [focusNode.id, ...neighborNodeIds]);
      syncNodeAppearance();
      syncLinkVisibility();
      syncActivityWithFocus();
    }

    // Frame the selected node together with its one-hop neighborhood (item 2).
    function fitCameraToIndex(index: number) {
      const subset = [sceneNodes[index], ...[...neighborIndicesOf(index)].map((neighborIndex) => sceneNodes[neighborIndex])];
      fitCamera(camera, controls, subset);
    }

    function syncDetail() {
      const element = detailRef.current;
      const detail = nodeDetailRef.current;
      if (!element || !detail) return;
      const node = sceneNodeById.get(detail.nodeId);
      if (!node) {
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
      labelRefs.current.forEach((element, nodeId) => {
        const node = sceneNodeById.get(nodeId);
        if (!node) return;
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

      const focusIndex = hoveredIndex ?? selectedIndex;
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
          element.style.opacity = focused || selected ? "1" : String(THREE.MathUtils.clamp(1.18 - distance / 520, focusIndex == null ? 0.66 : 0.4, 0.94));
          element.style.zIndex = String(focused ? 2_000 : selected ? 1_500 : Math.max(1, Math.round(1_000 - distance)));
        });
      syncDetail();
    }

    function activityCanRun() {
      return activityIsEnabled
        && !document.hidden
        && hoveredIndex == null
        && selectedIndex == null
        && activityPaths.length > 0;
    }

    function clearActivityVisuals() {
      activePackets.length = 0;
      activeImpacts.length = 0;
      impact.fill(0);
      activityMesh.count = 0;
      (nodeGeometry.getAttribute("aImpact") as THREE.InstancedBufferAttribute).needsUpdate = true;
      if (activityFrame !== 0) cancelAnimationFrame(activityFrame);
      activityFrame = 0;
      requestRender();
    }

    function eligibleActivityPaths(now: number, excludedDestinations = new Set<number>()) {
      const activeDestinations = new Set(activePackets.map((packet) => packet.destinationIndex));
      return activityPaths.filter((path) => {
        if (activeDestinations.has(path.destinationIndex) || excludedDestinations.has(path.destinationIndex)) return false;
        const heat = THREE.MathUtils.smoothstep(path.destinationRecency, ACTIVITY_RECENCY_THRESHOLD, 1);
        const cooldown = THREE.MathUtils.lerp(
          ACTIVITY_MAX_NODE_COOLDOWN_MS,
          ACTIVITY_MIN_NODE_COOLDOWN_MS,
          heat,
        );
        return now - (lastPulseAtByNodeIndex.get(path.destinationIndex) ?? Number.NEGATIVE_INFINITY) >= cooldown;
      });
    }

    function launchActivityPacket(now: number): number | null {
      const path = weightedActivityPath(eligibleActivityPaths(now));
      if (!path) return null;
      activePackets.push({ ...path, startedAt: now });
      lastPulseAtByNodeIndex.set(path.destinationIndex, now);
      return path.destinationRecency;
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
        const emittedRecency = launchActivityPacket(now);
        if (emittedRecency == null) {
          scheduleNextActivity(ACTIVITY_RETRY_GAP_MS);
          return;
        }
        if (activityFrame === 0) activityFrame = requestAnimationFrame(animateActivity);
        scheduleNextActivity(activityEmitGapMs(emittedRecency));
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
        const link = renderedLinks[packet.linkIndex];
        const forward = packet.sourceIndex === link.fromIndex;
        const destination = sceneNodes[packet.destinationIndex];
        setQuadraticPoint(
          activityPoint,
          renderedLinkPaths[packet.linkIndex],
          forward ? progress : 1 - progress,
        );
        const arrivalRadius = destination.radius + ACTIVITY_BEAD_RADIUS;
        const hasReachedDestination = progress >= 1
          || activityPoint.distanceToSquared(destination) <= arrivalRadius * arrivalRadius;
        if (hasReachedDestination) {
          activePackets.splice(packetIndex, 1);
          activeImpacts.push({ nodeIndex: packet.destinationIndex, startedAt: now });
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
          transform.scale.setScalar(1 - bead * 0.12);
          transform.updateMatrix();
          activityMesh.setMatrixAt(beadInstance, transform.matrix);
          beadInstance += 1;
        }
      }
      activityMesh.count = beadInstance;
      activityMesh.instanceMatrix.needsUpdate = true;

      impact.fill(0);
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
        impact[currentImpact.nodeIndex] = Math.max(
          impact[currentImpact.nodeIndex],
          flashStrength,
        );
      }
      (nodeGeometry.getAttribute("aImpact") as THREE.InstancedBufferAttribute).needsUpdate = true;
      renderer.render(scene, camera);

      if (activePackets.length > 0 || activeImpacts.length > 0) {
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
      syncActivityWithFocus();
    }

    function syncActivityWithFocus() {
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
      syncLabels();
      syncLinkVisibility();
      renderer.render(scene, camera);
    }

    function requestRender() {
      if (renderFrame !== 0 || document.hidden) return;
      renderFrame = requestAnimationFrame(renderNow);
    }

    function setSelectedNodeId(nextNodeId: number | null) {
      selectedIndex = nextNodeId == null ? null : nodeIndex.get(nextNodeId) ?? null;
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
      const exactIndex = raycaster.intersectObject(nodeMesh, false)[0]?.instanceId ?? null;
      return exactIndex ?? pickProjectedNode(rect);
    }

    function pickNode() {
      pointerFrame = 0;
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
      if (pointerFrame === 0) pointerFrame = requestAnimationFrame(pickNode);
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
        syncActivityWithFocus();
        return;
      }
      requestRender();
      syncActivityWithFocus();
    }

    const linkForce = forceLink<SceneNode, SceneLink>(simulationLinks)
      .id((node) => node.id)
      .distance((link) => {
        const from = sceneNodes[link.fromIndex];
        const to = sceneNodes[link.toIndex];
        const strength = Math.max(0.1, link.strength || 0.5);
        return from.radius + to.radius + 38 + (1 - strength) * 62;
      })
      .strength((link) => 0.08 + Math.max(0.1, link.strength || 0.5) * 0.12)
      .iterations(1);
    const simulation: Simulation<SceneNode> = forceSimulation(sceneNodes, 3)
      .force("charge", forceManyBody<SceneNode>()
        .strength((node) => -(135 + Math.sqrt(node.degree) * 9))
        .theta(0.76)
        .distanceMin(2)
        .distanceMax(520))
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
      syncNodeMatrices();
      syncLinkPositions();
      syncLinkVisibility();
      if (simulationTick % LABEL_POSITION_TICKS === 0) syncLabels();
      renderer.render(scene, camera);
    });
    simulation.on("end", requestRender);

    function handleControlsChange() {
      syncCameraClippingPlanes(camera, controls.target);
      requestRender();
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    controls.addEventListener("change", handleControlsChange);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("pointerleave", handlePointerLeave);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    resize();
    syncNodeMatrices();
    syncLinkPositions();
    fitCamera(camera, controls, sceneNodes);
    syncFocusNeighborhood();
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
    };
    requestRender();
    if (activityIsEnabled) scheduleNextActivity(600);

    return () => {
      simulation.stop();
      simulation.on("tick", null);
      simulation.on("end", null);
      if (renderFrame !== 0) cancelAnimationFrame(renderFrame);
      if (pointerFrame !== 0) cancelAnimationFrame(pointerFrame);
      if (activityFrame !== 0) cancelAnimationFrame(activityFrame);
      if (activityTimer !== null) clearTimeout(activityTimer);
      runtimeRef.current = null;
      resizeObserver.disconnect();
      controls.removeEventListener("change", handleControlsChange);
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
                {node.label}
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
