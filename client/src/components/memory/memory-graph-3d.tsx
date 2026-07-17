import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export interface MemoryGraph3DNode {
  id: number;
  source: string;
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
  velocity: THREE.Vector3;
  radius: number;
}

interface SceneLink extends MemoryGraph3DLink {
  fromIndex: number;
  toIndex: number;
}

const SOURCE_TOKEN_MAP: Record<string, string> = {
  chat: "--chart-2",
  conversation: "--chart-2",
  manual: "--chart-1",
  voice: "--chart-3",
  insight: "--chart-4",
  workspace: "--success",
  person: "--chart-5",
  project: "--chart-3",
  issue: "--warning",
  web: "--info",
  tool: "--muted-foreground",
  identity: "--chart-4",
  belief: "--chart-3",
  claim: "--chart-2",
  state: "--chart-2",
  cause: "--warning",
  action: "--chart-1",
  page: "--chart-1",
  session: "--chart-3",
};

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

function createInitialPosition(nodeId: number, index: number, count: number): THREE.Vector3 {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - ((index + 0.5) / Math.max(1, count)) * 2;
  const radial = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = goldenAngle * index + seededUnit(nodeId, 1) * 0.5;
  const shellRadius = Math.max(12, Math.cbrt(Math.max(1, count)) * 6.5);
  const depth = 0.7 + seededUnit(nodeId, 2) * 0.45;
  return new THREE.Vector3(
    Math.cos(theta) * radial * shellRadius * depth,
    y * shellRadius * depth,
    Math.sin(theta) * radial * shellRadius * depth,
  );
}

function buildSceneGraph(nodes: MemoryGraph3DNode[], links: MemoryGraph3DLink[]) {
  const maxDegree = Math.max(1, ...nodes.map((node) => node.degree));
  const sceneNodes: SceneNode[] = nodes.map((node, index) => ({
    ...node,
    position: createInitialPosition(node.id, index, nodes.length),
    velocity: new THREE.Vector3(),
    radius: 0.42 + Math.pow(node.degree / maxDegree, 0.55) * 1.1,
  }));
  const nodeIndex = new Map(sceneNodes.map((node, index) => [node.id, index]));
  const sceneLinks: SceneLink[] = links.flatMap((link) => {
    const fromIndex = nodeIndex.get(link.fromId);
    const toIndex = nodeIndex.get(link.toId);
    return fromIndex == null || toIndex == null ? [] : [{ ...link, fromIndex, toIndex }];
  });
  return { sceneNodes, sceneLinks };
}

function fitCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls, nodes: SceneNode[]) {
  if (nodes.length === 0) return;
  const box = new THREE.Box3();
  nodes.forEach((node) => box.expandByPoint(node.position));
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const distance = Math.max(18, sphere.radius / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.25);
  const direction = camera.position.clone().sub(controls.target).normalize();
  if (direction.lengthSq() === 0) direction.set(0.65, 0.35, 1);
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).add(direction.multiplyScalar(distance));
  camera.near = Math.max(0.1, distance / 200);
  camera.far = Math.max(500, distance * 20);
  camera.updateProjectionMatrix();
  controls.update();
}

function updateSimulation(nodes: SceneNode[], links: SceneLink[], tick: number) {
  const alpha = Math.max(0, 1 - tick / 260);
  if (alpha <= 0) return;

  for (const link of links) {
    const from = nodes[link.fromIndex];
    const to = nodes[link.toIndex];
    const delta = to.position.clone().sub(from.position);
    const distance = Math.max(0.01, delta.length());
    const strength = Math.max(0.15, link.strength || 0.5);
    const target = 4.5 + (1 - strength) * 5;
    const force = delta.multiplyScalar(((distance - target) / distance) * 0.012 * strength * alpha);
    from.velocity.add(force);
    to.velocity.sub(force);
  }

  const count = nodes.length;
  const samples = count <= 220 ? count : 48;
  for (let index = 0; index < count; index += 1) {
    const node = nodes[index];
    for (let sample = 1; sample < samples; sample += 1) {
      const otherIndex = count <= 220
        ? (index + sample) % count
        : (index * 37 + sample * 53) % count;
      if (otherIndex === index) continue;
      const other = nodes[otherIndex];
      const delta = node.position.clone().sub(other.position);
      const distanceSq = Math.max(0.3, delta.lengthSq());
      node.velocity.add(delta.normalize().multiplyScalar((0.035 * alpha) / distanceSq));
    }
    node.velocity.add(node.position.clone().multiplyScalar(-0.0009 * alpha));
  }

  for (const node of nodes) {
    node.velocity.multiplyScalar(0.82);
    node.velocity.clampLength(0, 0.55);
    node.position.add(node.velocity);
  }
}

export const MemoryGraph3D = forwardRef<MemoryGraph3DHandle, MemoryGraph3DProps>(function MemoryGraph3D(
  { nodes, links, selectedNodeId, onNodeSelect, onNodeHover },
  forwardedRef,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneStateRef = useRef<{
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    nodes: SceneNode[];
  } | null>(null);
  const selectedNodeIdRef = useRef(selectedNodeId);
  selectedNodeIdRef.current = selectedNodeId;
  const onNodeSelectRef = useRef(onNodeSelect);
  onNodeSelectRef.current = onNodeSelect;
  const onNodeHoverRef = useRef(onNodeHover);
  onNodeHoverRef.current = onNodeHover;

  useImperativeHandle(forwardedRef, () => ({
    zoomIn: () => {
      const state = sceneStateRef.current;
      if (!state) return;
      state.camera.position.lerp(state.controls.target, 0.2);
      state.controls.update();
    },
    zoomOut: () => {
      const state = sceneStateRef.current;
      if (!state) return;
      const offset = state.camera.position.clone().sub(state.controls.target).multiplyScalar(1.25);
      state.camera.position.copy(state.controls.target).add(offset);
      state.controls.update();
    },
    fitToView: () => {
      const state = sceneStateRef.current;
      if (state) fitCamera(state.camera, state.controls, state.nodes);
    },
  }), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || nodes.length === 0) return;

    const { sceneNodes, sceneLinks } = buildSceneGraph(nodes, links);
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(colorFromToken("--background"), 0.008);

    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 2000);
    camera.position.set(28, 18, 42);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = "h-full w-full outline-none";
    renderer.domElement.style.touchAction = "none";
    renderer.domElement.setAttribute("data-testid", "palace-graph");
    renderer.domElement.setAttribute("aria-label", "Interactive 3D memory graph");
    renderer.domElement.tabIndex = 0;
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.rotateSpeed = 0.55;
    controls.zoomSpeed = 0.8;
    controls.panSpeed = 0.65;
    controls.minDistance = 4;
    controls.maxDistance = 600;
    controls.screenSpacePanning = true;

    const sphereGeometry = new THREE.IcosahedronGeometry(1, 2);
    const sphereMaterial = new THREE.MeshPhongMaterial({
      vertexColors: true,
      shininess: 70,
      transparent: true,
      opacity: 0.94,
    });
    const nodeMesh = new THREE.InstancedMesh(sphereGeometry, sphereMaterial, sceneNodes.length);
    nodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    nodeMesh.frustumCulled = false;
    scene.add(nodeMesh);

    const linkPositions = new Float32Array(sceneLinks.length * 6);
    const linkColors = new Float32Array(sceneLinks.length * 6);
    const neutralLink = colorFromToken("--muted-foreground");
    for (let index = 0; index < sceneLinks.length; index += 1) {
      const intensity = 0.18 + Math.max(0, Math.min(1, sceneLinks[index].strength)) * 0.32;
      const color = neutralLink.clone().multiplyScalar(intensity);
      color.toArray(linkColors, index * 6);
      color.toArray(linkColors, index * 6 + 3);
    }
    const linkGeometry = new THREE.BufferGeometry();
    linkGeometry.setAttribute("position", new THREE.BufferAttribute(linkPositions, 3));
    linkGeometry.setAttribute("color", new THREE.BufferAttribute(linkColors, 3));
    const linkMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55 });
    const linkLines = new THREE.LineSegments(linkGeometry, linkMaterial);
    linkLines.frustumCulled = false;
    scene.add(linkLines);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x111827, 1.45));
    const keyLight = new THREE.PointLight(colorFromToken("--cta"), 18, 180);
    keyLight.position.set(24, 28, 36);
    scene.add(keyLight);
    const fillLight = new THREE.PointLight(colorFromToken("--chart-3"), 10, 160);
    fillLight.position.set(-30, -12, -24);
    scene.add(fillLight);

    const sourceColors = new Map<string, THREE.Color>();
    for (const node of sceneNodes) {
      if (!sourceColors.has(node.source)) {
        sourceColors.set(node.source, colorFromToken(SOURCE_TOKEN_MAP[node.source] || "--muted-foreground"));
      }
    }
    const selectedColor = colorFromToken("--cta");
    const deletionColor = colorFromToken("--destructive");
    const transform = new THREE.Object3D();
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hoveredIndex: number | null = null;
    let pointerDown = { x: 0, y: 0 };
    let simulationTick = 0;
    let animationFrame = 0;

    function syncNodeInstances() {
      for (let index = 0; index < sceneNodes.length; index += 1) {
        const node = sceneNodes[index];
        const isSelected = selectedNodeIdRef.current === node.id;
        const isHovered = hoveredIndex === index;
        const scale = node.radius * (isSelected ? 1.4 : isHovered ? 1.22 : 1) * Math.max(0.65, node.decayScore || 1);
        transform.position.copy(node.position);
        transform.scale.setScalar(scale);
        transform.updateMatrix();
        nodeMesh.setMatrixAt(index, transform.matrix);
        const color = isSelected || isHovered
          ? selectedColor
          : node.pendingDeletion
            ? deletionColor
            : sourceColors.get(node.source)!;
        nodeMesh.setColorAt(index, color);
      }
      nodeMesh.instanceMatrix.needsUpdate = true;
      if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
    }

    function syncLinks() {
      for (let index = 0; index < sceneLinks.length; index += 1) {
        const link = sceneLinks[index];
        sceneNodes[link.fromIndex].position.toArray(linkPositions, index * 6);
        sceneNodes[link.toIndex].position.toArray(linkPositions, index * 6 + 3);
      }
      (linkGeometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      linkGeometry.computeBoundingSphere();
    }

    function resize() {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }

    function updatePointer(event: PointerEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      return rect;
    }

    function findHoveredNode(event: PointerEvent) {
      const rect = updatePointer(event);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(nodeMesh, false)[0];
      const nextIndex = hit?.instanceId ?? null;
      if (nextIndex === hoveredIndex) return;
      hoveredIndex = nextIndex;
      renderer.domElement.style.cursor = nextIndex == null ? "grab" : "pointer";
      if (nextIndex == null) {
        onNodeHoverRef.current(null);
      } else {
        onNodeHoverRef.current(sceneNodes[nextIndex].id, {
          x: event.clientX - rect.left + 16,
          y: event.clientY - rect.top,
        });
      }
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
      hoveredIndex = null;
      renderer.domElement.style.cursor = "grab";
      onNodeHoverRef.current(null);
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    renderer.domElement.addEventListener("pointermove", findHoveredNode);
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("pointerleave", handlePointerLeave);

    resize();
    fitCamera(camera, controls, sceneNodes);
    sceneStateRef.current = { camera, controls, nodes: sceneNodes };

    function render() {
      animationFrame = requestAnimationFrame(render);
      if (simulationTick < 260) {
        updateSimulation(sceneNodes, sceneLinks, simulationTick);
        simulationTick += 1;
        syncLinks();
      }
      syncNodeInstances();
      controls.update();
      renderer.render(scene, camera);
    }
    syncLinks();
    render();

    return () => {
      cancelAnimationFrame(animationFrame);
      sceneStateRef.current = null;
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointermove", findHoveredNode);
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
      controls.dispose();
      sphereGeometry.dispose();
      sphereMaterial.dispose();
      linkGeometry.dispose();
      linkMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [nodes, links]);

  return <div ref={hostRef} className="h-full w-full" />;
});
