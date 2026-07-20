import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
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
  decayScore: number;
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

interface MemoryGraph3DProps {
  nodes: MemoryGraph3DNode[];
  links: MemoryGraph3DLink[];
  selectedNodeId: number | null;
  onNodeSelect: (nodeId: number) => void;
  onNodeHover: (nodeId: number | null, position?: { x: number; y: number }) => void;
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

interface GraphRuntime {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  nodes: SceneNode[];
  requestRender: (refreshLabels?: boolean) => void;
  setSelectedNodeId: (nodeId: number | null) => void;
}

const CURVE_SEGMENTS = 3;
const MAX_RENDERED_LINKS = 2_500;
const LARGE_GRAPH_THRESHOLD = 1_000;
const LABEL_PERCENTILE = 0.1;
const LABEL_POSITION_TICKS = 4;
const LABEL_REFRESH_TICKS = 12;
const INITIAL_LAYOUT_SCALE = 20;

const nodeVertexShader = `
  attribute float aVisibility;
  attribute float aEmphasis;
  attribute vec3 aTint;
  varying vec3 vNormal;
  varying vec3 vViewDirection;
  varying vec3 vTint;
  varying float vVisibility;
  varying float vEmphasis;

  void main() {
    vec4 worldPosition = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vNormal = normalize(mat3(modelMatrix * instanceMatrix) * normal);
    vViewDirection = normalize(cameraPosition - worldPosition.xyz);
    vTint = aTint;
    vVisibility = aVisibility;
    vEmphasis = aEmphasis;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const nodeFragmentShader = `
  varying vec3 vNormal;
  varying vec3 vViewDirection;
  varying vec3 vTint;
  varying float vVisibility;
  varying float vEmphasis;

  void main() {
    float facing = abs(dot(normalize(vNormal), normalize(vViewDirection)));
    float edge = 1.0 - facing;
    float rim = pow(edge, 1.6);
    float emphasis = 1.0 + vEmphasis * 0.5;
    vec3 color = vTint * (0.72 + rim * 0.45) * emphasis;
    float alpha = (0.5 + rim * 0.32) * vVisibility;
    gl_FragColor = vec4(color, clamp(alpha, 0.3, 0.92));
  }
`;

function colorFromToken(token: string): THREE.Color {
  const rootStyles = getComputedStyle(document.documentElement);
  const value = rootStyles.getPropertyValue(token).trim();
  const fallback = rootStyles.getPropertyValue("--foreground").trim() || getComputedStyle(document.body).color;
  return new THREE.Color(value ? `hsl(${value})` : fallback.startsWith("rgb") ? fallback : `hsl(${fallback})`);
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
      radius: 1 + Math.pow(degreeRatio, 0.6) * 39,
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
  return { sceneNodes, simulationLinks, renderedLinks, nodeIndex };
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

function labelsOverlap(rect: DOMRect, occupied: DOMRect[]) {
  return occupied.some((other) => !(
    rect.right + 8 < other.left
    || rect.left - 8 > other.right
    || rect.bottom + 6 < other.top
    || rect.top - 6 > other.bottom
  ));
}

export const MemoryGraph3D = forwardRef<MemoryGraph3DHandle, MemoryGraph3DProps>(function MemoryGraph3D(
  { nodes, links, selectedNodeId, onNodeSelect, onNodeHover },
  forwardedRef,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRefs = useRef(new Map<number, HTMLDivElement>());
  const runtimeRef = useRef<GraphRuntime | null>(null);
  const [visibleLabelNodeIds, setVisibleLabelNodeIds] = useState<number[]>([]);
  const selectedNodeIdRef = useRef(selectedNodeId);
  selectedNodeIdRef.current = selectedNodeId;
  const onNodeSelectRef = useRef(onNodeSelect);
  onNodeSelectRef.current = onNodeSelect;
  const onNodeHoverRef = useRef(onNodeHover);
  onNodeHoverRef.current = onNodeHover;

  const overlayNodes = useMemo(() => {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const candidates = visibleLabelNodeIds.flatMap((nodeId): MemoryGraph3DNode[] => {
      const node = nodeById.get(nodeId);
      return node == null ? [] : [node];
    });
    const selectedNode = selectedNodeId == null ? null : nodeById.get(selectedNodeId);
    if (selectedNode && !candidates.some((node) => node.id === selectedNode.id)) candidates.push(selectedNode);
    return candidates;
  }, [nodes, selectedNodeId, visibleLabelNodeIds]);

  useImperativeHandle(forwardedRef, () => ({
    zoomIn: () => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      runtime.camera.position.lerp(runtime.controls.target, 0.2);
      runtime.controls.update();
      runtime.requestRender(true);
    },
    zoomOut: () => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      const offset = runtime.camera.position.clone().sub(runtime.controls.target).multiplyScalar(1.25);
      runtime.camera.position.copy(runtime.controls.target).add(offset);
      runtime.controls.update();
      runtime.requestRender(true);
    },
    fitToView: () => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      fitCamera(runtime.camera, runtime.controls, runtime.nodes);
      runtime.requestRender(true);
    },
  }), []);

  useEffect(() => {
    runtimeRef.current?.setSelectedNodeId(selectedNodeId);
  }, [selectedNodeId]);

  useEffect(() => {
    runtimeRef.current?.requestRender();
  }, [overlayNodes]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || nodes.length === 0) return;

    const { sceneNodes, simulationLinks, renderedLinks, nodeIndex } = buildSceneGraph(nodes, links);
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
    const deletionColor = colorFromToken("--destructive");
    const nodeGeometry = new THREE.IcosahedronGeometry(1, 2);
    const visibility = new Float32Array(sceneNodes.length);
    const emphasis = new Float32Array(sceneNodes.length);
    const tints = new Float32Array(sceneNodes.length * 3);
    sceneNodes.forEach((node, index) => {
      visibility[index] = Math.max(0.62, node.decayScore || 1);
      (node.pendingDeletion ? deletionColor : signalColor).toArray(tints, index * 3);
    });
    nodeGeometry.setAttribute("aVisibility", new THREE.InstancedBufferAttribute(visibility, 1));
    nodeGeometry.setAttribute("aEmphasis", new THREE.InstancedBufferAttribute(emphasis, 1));
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
    const linkGeometry = new LineSegmentsGeometry();
    const baseLinkColor = signalColor.clone().multiplyScalar(0.65);
    renderedLinks.forEach((link, linkIndex) => {
      const brightness = 0.15 + Math.pow(Math.max(0, link.strength), 1.6) * 0.85;
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
    const linkMaterial = new LineMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.62,
      linewidth: 2,
      depthWrite: false,
      resolution: new THREE.Vector2(host.clientWidth, host.clientHeight),
    });
    const linkLines = new LineSegments2(linkGeometry, linkMaterial);
    linkLines.frustumCulled = false;
    scene.add(linkLines);

    const transform = new THREE.Object3D();
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const projected = new THREE.Vector3();
    const frustum = new THREE.Frustum();
    const viewProjection = new THREE.Matrix4();
    const nodeSphere = new THREE.Sphere();
    let previousVisibleLabelNodeIds: number[] = [];
    let selectedIndex = selectedNodeIdRef.current == null ? null : nodeIndex.get(selectedNodeIdRef.current) ?? null;
    let hoveredIndex: number | null = null;
    let pointerDown = { x: 0, y: 0 };
    let pendingPointer = { x: 0, y: 0 };
    let renderFrame = 0;
    let pointerFrame = 0;
    let refreshLabelsOnRender = false;
    let simulationTick = 0;

    function syncNodeMatrices() {
      sceneNodes.forEach((node, index) => {
        const selected = selectedIndex === index;
        const hovered = hoveredIndex === index;
        transform.position.set(node.x, node.y, node.z);
        transform.scale.setScalar(node.radius * (selected ? 1.22 : hovered ? 1.12 : 1));
        transform.updateMatrix();
        nodeMesh.setMatrixAt(index, transform.matrix);
      });
      nodeMesh.instanceMatrix.needsUpdate = true;
    }

    function syncLinkPositions() {
      renderedLinks.forEach((link, linkIndex) => {
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
        const arc = 0.9 + seededUnit(link.id, 21) * 2.1;
        const controlX = (fromX + toX) * 0.5 + perpendicularX / perpendicularLength * arc;
        const controlY = (fromY + toY) * 0.5 + perpendicularY / perpendicularLength * arc;
        const controlZ = (fromZ + toZ) * 0.5 + perpendicularZ / perpendicularLength * arc;
        for (let segment = 0; segment < CURVE_SEGMENTS; segment += 1) {
          const offset = (linkIndex * CURVE_SEGMENTS + segment) * 6;
          writeQuadraticPoint(linkPositions, offset, fromX, fromY, fromZ, controlX, controlY, controlZ, toX, toY, toZ, segment / CURVE_SEGMENTS);
          writeQuadraticPoint(linkPositions, offset + 3, fromX, fromY, fromZ, controlX, controlY, controlZ, toX, toY, toZ, (segment + 1) / CURVE_SEGMENTS);
        }
      });
      const instanceStartAttr = linkGeometry.getAttribute("instanceStart");
      if (instanceStartAttr && "data" in instanceStartAttr) (instanceStartAttr as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
    }

    function syncNodeAppearance(indices: Array<number | null>) {
      const uniqueIndices = new Set(indices.filter((index): index is number => index != null));
      uniqueIndices.forEach((index) => {
        const node = sceneNodes[index];
        const selected = selectedIndex === index;
        const hovered = hoveredIndex === index;
        emphasis[index] = selected ? 1 : hovered ? 0.7 : 0;
        (node.pendingDeletion ? deletionColor : selected || hovered ? activeColor : signalColor).toArray(tints, index * 3);
        transform.position.set(node.x, node.y, node.z);
        transform.scale.setScalar(node.radius * (selected ? 1.22 : hovered ? 1.12 : 1));
        transform.updateMatrix();
        nodeMesh.setMatrixAt(index, transform.matrix);
      });
      if (uniqueIndices.size === 0) return;
      nodeMesh.instanceMatrix.needsUpdate = true;
      (nodeGeometry.getAttribute("aEmphasis") as THREE.InstancedBufferAttribute).needsUpdate = true;
      (nodeGeometry.getAttribute("aTint") as THREE.InstancedBufferAttribute).needsUpdate = true;
    }

    function refreshVisibleLabels() {
      camera.updateMatrixWorld();
      viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(viewProjection);
      const visibleNodes = sceneNodes.filter((node) => {
        nodeSphere.center.set(node.x, node.y, node.z);
        nodeSphere.radius = node.radius;
        return frustum.intersectsSphere(nodeSphere);
      });
      const titleCount = Math.ceil(visibleNodes.length * LABEL_PERCENTILE);
      const nextNodeIds = visibleNodes
        .sort((left, right) => right.degree - left.degree || right.radius - left.radius || left.id - right.id)
        .slice(0, titleCount)
        .map((node) => node.id);
      const unchanged = nextNodeIds.length === previousVisibleLabelNodeIds.length
        && nextNodeIds.every((nodeId, index) => nodeId === previousVisibleLabelNodeIds[index]);
      if (unchanged) return;
      previousVisibleLabelNodeIds = nextNodeIds;
      setVisibleLabelNodeIds(nextNodeIds);
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
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        element.style.display = "flex";
        element.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -12px)`;
        element.style.opacity = selectedNodeIdRef.current === node.id ? "1" : String(THREE.MathUtils.clamp(1.18 - distance / 520, 0.66, 0.94));
        element.style.zIndex = String(Math.max(1, Math.round(1_000 - distance)));
        projectedLabels.push({ node, x, y, distance });
      });

      const occupied: DOMRect[] = [];
      projectedLabels
        .sort((left, right) => {
          const leftPriority = selectedNodeIdRef.current === left.node.id ? 10_000 : left.node.degree * 10 - left.distance;
          const rightPriority = selectedNodeIdRef.current === right.node.id ? 10_000 : right.node.degree * 10 - right.distance;
          return rightPriority - leftPriority;
        })
        .forEach(({ node, x, y }) => {
          const element = labelRefs.current.get(node.id);
          if (!element) return;
          const forced = selectedNodeIdRef.current === node.id;
          const labelWidth = Math.min(200, 44 + Math.min(node.label.length, 26) * 6.2);
          const rect = new DOMRect(x - labelWidth / 2, y + 8, labelWidth, 24);
          const show = forced || !labelsOverlap(rect, occupied);
          element.style.display = show ? "flex" : "none";
          if (show) occupied.push(rect);
        });
    }

    function renderNow() {
      renderFrame = 0;
      if (refreshLabelsOnRender) {
        refreshLabelsOnRender = false;
        refreshVisibleLabels();
      }
      syncLabels();
      renderer.render(scene, camera);
    }

    function requestRender(refreshLabels = false) {
      refreshLabelsOnRender ||= refreshLabels;
      if (renderFrame !== 0 || document.hidden) return;
      renderFrame = requestAnimationFrame(renderNow);
    }

    function setSelectedNodeId(nextNodeId: number | null) {
      const previousIndex = selectedIndex;
      selectedIndex = nextNodeId == null ? null : nodeIndex.get(nextNodeId) ?? null;
      syncNodeAppearance([previousIndex, selectedIndex]);
      requestRender(true);
    }

    function resize() {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      linkMaterial.resolution.set(width, height);
      requestRender(true);
    }

    function pickNode() {
      pointerFrame = 0;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((pendingPointer.x - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((pendingPointer.y - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const nextHoveredIndex = raycaster.intersectObject(nodeMesh, false)[0]?.instanceId ?? null;
      if (nextHoveredIndex === hoveredIndex) return;
      const previousHoveredIndex = hoveredIndex;
      hoveredIndex = nextHoveredIndex;
      syncNodeAppearance([previousHoveredIndex, hoveredIndex]);
      renderer.domElement.style.cursor = hoveredIndex == null ? "grab" : "pointer";
      if (hoveredIndex == null) {
        onNodeHoverRef.current(null);
      } else {
        onNodeHoverRef.current(sceneNodes[hoveredIndex].id, {
          x: pendingPointer.x - rect.left + 16,
          y: pendingPointer.y - rect.top,
        });
      }
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
      if (moved < 6 && hoveredIndex != null) onNodeSelectRef.current(sceneNodes[hoveredIndex].id);
      renderer.domElement.style.cursor = hoveredIndex == null ? "grab" : "pointer";
    }

    function handlePointerLeave() {
      if (pointerFrame !== 0) cancelAnimationFrame(pointerFrame);
      pointerFrame = 0;
      const previousHoveredIndex = hoveredIndex;
      hoveredIndex = null;
      syncNodeAppearance([previousHoveredIndex]);
      renderer.domElement.style.cursor = "grab";
      onNodeHoverRef.current(null);
      requestRender();
    }

    function handleVisibilityChange() {
      if (!document.hidden) requestRender(true);
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
        .strength((node) => -(120 + Math.sqrt(node.degree) * 8))
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
      if (simulationTick % LABEL_REFRESH_TICKS === 0) refreshVisibleLabels();
      if (simulationTick % LABEL_POSITION_TICKS === 0) syncLabels();
      renderer.render(scene, camera);
    });
    simulation.on("end", () => {
      refreshVisibleLabels();
      requestRender();
    });

    function handleControlsChange() {
      syncCameraClippingPlanes(camera, controls.target);
      requestRender(true);
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
    syncNodeAppearance([selectedIndex]);
    runtimeRef.current = { camera, controls, nodes: sceneNodes, requestRender, setSelectedNodeId };
    refreshVisibleLabels();
    requestRender();

    return () => {
      simulation.stop();
      simulation.on("tick", null);
      simulation.on("end", null);
      if (renderFrame !== 0) cancelAnimationFrame(renderFrame);
      if (pointerFrame !== 0) cancelAnimationFrame(pointerFrame);
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
            <span className="mt-0.5 max-w-[180px] truncate whitespace-nowrap rounded-md bg-card/80 px-1.5 py-0.5 text-[10px] font-medium text-foreground/90 shadow-sm backdrop-blur-sm">
              {node.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});
