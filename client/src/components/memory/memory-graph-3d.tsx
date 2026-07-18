import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
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
  position: THREE.Vector3;
  radius: number;
}

interface SceneLink extends MemoryGraph3DLink {
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
  requestRender: () => void;
  setSelectedNodeId: (nodeId: number | null) => void;
}

const CURVE_SEGMENTS = 3;
const MAX_OVERLAY_NODES = 40;
const MAX_RENDERED_LINKS = 8_000;
const LARGE_GRAPH_THRESHOLD = 1_000;

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
    float fresnel = 1.0 - facing;
    float rim = smoothstep(0.02, 0.92, pow(fresnel, 0.72));
    float core = smoothstep(0.12, 0.92, facing);
    float highlight = pow(max(dot(normalize(vNormal), normalize(vec3(-0.42, 0.66, 0.61))), 0.0), 10.0);
    float emphasis = 1.0 + vEmphasis * 0.45;
    vec3 color = vTint * (0.42 + core * 0.38 + rim * 0.68 + highlight * 0.55) * emphasis;
    float alpha = (0.34 + core * 0.34 + rim * 0.28 + highlight * 0.16) * vVisibility;
    gl_FragColor = vec4(color, clamp(alpha, 0.3, 1.0));
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

function createNodePosition(node: MemoryGraph3DNode, index: number, count: number, maxDegree: number): THREE.Vector3 {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const normalizedY = 1 - ((index + 0.5) / Math.max(1, count)) * 2;
  const radial = Math.sqrt(Math.max(0, 1 - normalizedY * normalizedY));
  const theta = goldenAngle * index + seededUnit(node.id, 1) * 0.6;
  const graphRadius = Math.max(16, Math.cbrt(Math.max(1, count)) * 7);
  const degreePull = Math.pow(node.degree / Math.max(1, maxDegree), 0.35);
  const depth = 0.72 + seededUnit(node.id, 2) * 0.34 - degreePull * 0.18;
  return new THREE.Vector3(
    Math.cos(theta) * radial * graphRadius * depth,
    normalizedY * graphRadius * depth,
    Math.sin(theta) * radial * graphRadius * depth,
  );
}

function buildSceneGraph(nodes: MemoryGraph3DNode[], links: MemoryGraph3DLink[]) {
  const maxDegree = Math.max(1, ...nodes.map((node) => node.degree));
  const sceneNodes: SceneNode[] = nodes.map((node, index) => ({
    ...node,
    position: createNodePosition(node, index, nodes.length, maxDegree),
    radius: 1.55 + Math.pow(node.degree / maxDegree, 0.48) * 3.1,
  }));
  const nodeIndex = new Map(sceneNodes.map((node, index) => [node.id, index]));
  const sceneLinks = links
    .flatMap((link): SceneLink[] => {
      const fromIndex = nodeIndex.get(link.fromId);
      const toIndex = nodeIndex.get(link.toId);
      return fromIndex == null || toIndex == null ? [] : [{ ...link, fromIndex, toIndex }];
    })
    .sort((left, right) => right.strength - left.strength)
    .slice(0, MAX_RENDERED_LINKS);
  return { sceneNodes, sceneLinks, nodeIndex };
}

function fitCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls, nodes: SceneNode[]) {
  if (nodes.length === 0) return;
  const bounds = new THREE.Box3();
  nodes.forEach((node) => bounds.expandBySphere(new THREE.Sphere(node.position, node.radius)));
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const distance = Math.max(24, sphere.radius / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.18);
  const direction = camera.position.clone().sub(controls.target).normalize();
  if (direction.lengthSq() === 0) direction.set(0.62, 0.36, 1);
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).add(direction.multiplyScalar(distance));
  camera.near = Math.max(0.1, distance / 220);
  camera.far = Math.max(500, distance * 16);
  camera.updateProjectionMatrix();
  controls.update();
}

function createCurveControlPoint(from: SceneNode, to: SceneNode, linkId: number) {
  const direction = to.position.clone().sub(from.position).normalize();
  const axis = Math.abs(direction.y) < 0.85 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const perpendicular = direction.clone().cross(axis).normalize();
  return from.position
    .clone()
    .add(to.position)
    .multiplyScalar(0.5)
    .addScaledVector(perpendicular, 0.9 + seededUnit(linkId, 21) * 2.1);
}

function writeQuadraticCurvePoint(
  from: THREE.Vector3,
  control: THREE.Vector3,
  to: THREE.Vector3,
  progress: number,
  target: THREE.Vector3,
) {
  const inverse = 1 - progress;
  target.copy(from)
    .multiplyScalar(inverse * inverse)
    .addScaledVector(control, 2 * inverse * progress)
    .addScaledVector(to, progress * progress);
}

function labelsOverlap(rect: DOMRect, occupied: DOMRect[]) {
  return occupied.some((other) => !(
    rect.right + 6 < other.left
    || rect.left - 6 > other.right
    || rect.bottom + 4 < other.top
    || rect.top - 4 > other.bottom
  ));
}

export const MemoryGraph3D = forwardRef<MemoryGraph3DHandle, MemoryGraph3DProps>(function MemoryGraph3D(
  { nodes, links, selectedNodeId, onNodeSelect, onNodeHover },
  forwardedRef,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRefs = useRef(new Map<number, HTMLDivElement>());
  const runtimeRef = useRef<GraphRuntime | null>(null);
  const selectedNodeIdRef = useRef(selectedNodeId);
  selectedNodeIdRef.current = selectedNodeId;
  const onNodeSelectRef = useRef(onNodeSelect);
  onNodeSelectRef.current = onNodeSelect;
  const onNodeHoverRef = useRef(onNodeHover);
  onNodeHoverRef.current = onNodeHover;

  const overlayNodes = useMemo(() => {
    const highestInformationNodes = [...nodes]
      .sort((left, right) => right.degree - left.degree || left.id - right.id)
      .slice(0, MAX_OVERLAY_NODES);
    const selectedNode = selectedNodeId == null ? null : nodes.find((node) => node.id === selectedNodeId);
    if (selectedNode && !highestInformationNodes.some((node) => node.id === selectedNode.id)) {
      highestInformationNodes.push(selectedNode);
    }
    return highestInformationNodes;
  }, [nodes, selectedNodeId]);

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
    const host = hostRef.current;
    if (!host || nodes.length === 0) return;

    const { sceneNodes, sceneLinks, nodeIndex } = buildSceneGraph(nodes, links);
    const sceneNodeById = new Map(sceneNodes.map((node) => [node.id, node]));
    const isLargeGraph = sceneNodes.length >= LARGE_GRAPH_THRESHOLD;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 2_000);
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
    controls.minDistance = 6;
    controls.maxDistance = 500;
    controls.screenSpacePanning = true;

    const signalColor = colorFromToken("--cta");
    const activeColor = colorFromToken("--active");
    const deletionColor = colorFromToken("--destructive");
    const nodeGeometry = new THREE.IcosahedronGeometry(1, 0);
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
    nodeMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const transform = new THREE.Object3D();
    sceneNodes.forEach((node, index) => {
      transform.position.copy(node.position);
      transform.scale.setScalar(node.radius);
      transform.updateMatrix();
      nodeMesh.setMatrixAt(index, transform.matrix);
    });
    nodeMesh.instanceMatrix.needsUpdate = true;
    nodeMesh.computeBoundingSphere();
    scene.add(nodeMesh);

    const linkPositions = new Float32Array(sceneLinks.length * CURVE_SEGMENTS * 6);
    const linkGeometry = new THREE.BufferGeometry();
    const curvePoint = new THREE.Vector3();
    sceneLinks.forEach((link, linkIndex) => {
      const fromNode = sceneNodes[link.fromIndex];
      const toNode = sceneNodes[link.toIndex];
      const direction = toNode.position.clone().sub(fromNode.position).normalize();
      const from = fromNode.position.clone().addScaledVector(direction, fromNode.radius * 0.94);
      const to = toNode.position.clone().addScaledVector(direction, -toNode.radius * 0.94);
      const control = createCurveControlPoint(fromNode, toNode, link.id);
      for (let segment = 0; segment < CURVE_SEGMENTS; segment += 1) {
        const offset = (linkIndex * CURVE_SEGMENTS + segment) * 6;
        writeQuadraticCurvePoint(from, control, to, segment / CURVE_SEGMENTS, curvePoint);
        curvePoint.toArray(linkPositions, offset);
        writeQuadraticCurvePoint(from, control, to, (segment + 1) / CURVE_SEGMENTS, curvePoint);
        curvePoint.toArray(linkPositions, offset + 3);
      }
    });
    linkGeometry.setAttribute("position", new THREE.BufferAttribute(linkPositions, 3));
    linkGeometry.computeBoundingSphere();
    const linkMaterial = new THREE.LineBasicMaterial({
      color: signalColor.clone().multiplyScalar(0.52),
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    scene.add(new THREE.LineSegments(linkGeometry, linkMaterial));

    const dustCount = isLargeGraph ? 80 : 140;
    const dustPositions = new Float32Array(dustCount * 3);
    const bounds = new THREE.Box3();
    sceneNodes.forEach((node) => bounds.expandByPoint(node.position));
    const boundingSphere = bounds.getBoundingSphere(new THREE.Sphere());
    for (let index = 0; index < dustCount; index += 1) {
      const theta = seededUnit(index, 10) * Math.PI * 2;
      const phi = Math.acos(2 * seededUnit(index, 11) - 1);
      const radius = boundingSphere.radius * (0.32 + Math.pow(seededUnit(index, 12), 0.62) * 1.06);
      dustPositions[index * 3] = boundingSphere.center.x + Math.sin(phi) * Math.cos(theta) * radius;
      dustPositions[index * 3 + 1] = boundingSphere.center.y + Math.cos(phi) * radius * 0.72;
      dustPositions[index * 3 + 2] = boundingSphere.center.z + Math.sin(phi) * Math.sin(theta) * radius;
    }
    const dustGeometry = new THREE.BufferGeometry();
    dustGeometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
    const dustMaterial = new THREE.PointsMaterial({
      color: signalColor.clone().multiplyScalar(0.62),
      size: isLargeGraph ? 0.42 : 0.58,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
    });
    scene.add(new THREE.Points(dustGeometry, dustMaterial));

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const projected = new THREE.Vector3();
    let selectedIndex = selectedNodeIdRef.current == null ? null : nodeIndex.get(selectedNodeIdRef.current) ?? null;
    let hoveredIndex: number | null = null;
    let pointerDown = { x: 0, y: 0 };
    let pendingPointer = { x: 0, y: 0 };
    let renderFrame = 0;
    let pointerFrame = 0;

    function syncNodeAppearance(index: number | null) {
      if (index == null) return;
      const node = sceneNodes[index];
      const selected = selectedIndex === index;
      const hovered = hoveredIndex === index;
      transform.position.copy(node.position);
      transform.scale.setScalar(node.radius * (selected ? 1.22 : hovered ? 1.12 : 1));
      transform.updateMatrix();
      nodeMesh.setMatrixAt(index, transform.matrix);
      emphasis[index] = selected ? 1 : hovered ? 0.7 : 0;
      (node.pendingDeletion ? deletionColor : selected || hovered ? activeColor : signalColor).toArray(tints, index * 3);
    }

    function commitNodeAppearance(indices: Array<number | null>) {
      const uniqueIndices = new Set(indices.filter((index): index is number => index != null));
      uniqueIndices.forEach(syncNodeAppearance);
      if (uniqueIndices.size === 0) return;
      nodeMesh.instanceMatrix.needsUpdate = true;
      (nodeGeometry.getAttribute("aEmphasis") as THREE.InstancedBufferAttribute).needsUpdate = true;
      (nodeGeometry.getAttribute("aTint") as THREE.InstancedBufferAttribute).needsUpdate = true;
    }

    function syncLabels() {
      const width = host.clientWidth;
      const height = host.clientHeight;
      const projectedLabels: ProjectedLabel[] = [];
      labelRefs.current.forEach((element, nodeId) => {
        const node = sceneNodeById.get(nodeId);
        if (!node) return;
        projected.copy(node.position).project(camera);
        const visible = projected.z > -1 && projected.z < 1 && Math.abs(projected.x) < 1.08 && Math.abs(projected.y) < 1.08;
        if (!visible) {
          element.style.visibility = "hidden";
          return;
        }
        const x = (projected.x * 0.5 + 0.5) * width;
        const y = (-projected.y * 0.5 + 0.5) * height;
        const distance = camera.position.distanceTo(node.position);
        element.style.visibility = "visible";
        element.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
        element.style.opacity = selectedNodeIdRef.current === node.id ? "1" : String(THREE.MathUtils.clamp(1.16 - distance / 190, 0.5, 0.88));
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
          const label = labelRefs.current.get(node.id)?.querySelector<HTMLElement>("[data-node-label]");
          if (!label) return;
          const forced = selectedNodeIdRef.current === node.id;
          const labelWidth = Math.min(200, 44 + Math.min(node.label.length, 26) * 6.2);
          const rect = new DOMRect(x + 14, y - 14, labelWidth, 28);
          const show = forced || !labelsOverlap(rect, occupied);
          label.style.display = show ? "block" : "none";
          if (show) occupied.push(rect);
        });
    }

    function renderNow() {
      renderFrame = 0;
      syncLabels();
      renderer.render(scene, camera);
    }

    function requestRender() {
      if (renderFrame !== 0 || document.hidden) return;
      renderFrame = requestAnimationFrame(renderNow);
    }

    function setSelectedNodeId(nextNodeId: number | null) {
      const previousIndex = selectedIndex;
      selectedIndex = nextNodeId == null ? null : nodeIndex.get(nextNodeId) ?? null;
      commitNodeAppearance([previousIndex, selectedIndex]);
      requestRender();
    }

    function resize() {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      requestRender();
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
      commitNodeAppearance([previousHoveredIndex, hoveredIndex]);
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
      commitNodeAppearance([previousHoveredIndex]);
      renderer.domElement.style.cursor = "grab";
      onNodeHoverRef.current(null);
      requestRender();
    }

    function handleVisibilityChange() {
      if (!document.hidden) requestRender();
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    controls.addEventListener("change", requestRender);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("pointerleave", handlePointerLeave);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    resize();
    fitCamera(camera, controls, sceneNodes);
    commitNodeAppearance([selectedIndex]);
    runtimeRef.current = { camera, controls, nodes: sceneNodes, requestRender, setSelectedNodeId };
    requestRender();

    return () => {
      if (renderFrame !== 0) cancelAnimationFrame(renderFrame);
      if (pointerFrame !== 0) cancelAnimationFrame(pointerFrame);
      runtimeRef.current = null;
      resizeObserver.disconnect();
      controls.removeEventListener("change", requestRender);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      controls.dispose();
      nodeGeometry.dispose();
      nodeMaterial.dispose();
      linkGeometry.dispose();
      linkMaterial.dispose();
      dustGeometry.dispose();
      dustMaterial.dispose();
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
            className="absolute left-0 top-0 flex items-center gap-1.5 will-change-transform"
            title={node.label}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-cta/30 bg-card/90 text-active shadow-sm">
              <MemorySourceIcon source={node.source} className="h-3.5 w-3.5" />
            </span>
            <span data-node-label className="max-w-[200px] truncate whitespace-nowrap rounded-md border border-card-border bg-card/90 px-2 py-1 text-xs font-medium text-foreground shadow-sm">
              {node.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});
