import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
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
  velocity: THREE.Vector3;
  radius: number;
}

interface SceneLink extends MemoryGraph3DLink {
  fromIndex: number;
  toIndex: number;
}

interface ProjectedNode {
  index: number;
  x: number;
  y: number;
  distance: number;
}

const LINK_SEGMENTS = 10;
const MAX_PULSES = 96;

const shellVertexShader = `
  attribute float aPhase;
  attribute float aVisibility;
  attribute float aEmphasis;
  attribute vec3 aTint;
  varying vec3 vNormal;
  varying vec3 vViewDirection;
  varying vec3 vTint;
  varying float vVisibility;
  varying float vEmphasis;
  uniform float uTime;

  void main() {
    float breathing = 1.0 + sin(uTime * 1.05 + aPhase) * 0.012;
    vec4 worldPosition = modelMatrix * instanceMatrix * vec4(position * breathing, 1.0);
    vNormal = normalize(mat3(modelMatrix * instanceMatrix) * normal);
    vViewDirection = normalize(cameraPosition - worldPosition.xyz);
    vTint = aTint;
    vVisibility = aVisibility;
    vEmphasis = aEmphasis;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const shellFragmentShader = `
  varying vec3 vNormal;
  varying vec3 vViewDirection;
  varying vec3 vTint;
  varying float vVisibility;
  varying float vEmphasis;
  uniform vec3 uDeepColor;
  uniform float uBackface;

  void main() {
    float facing = abs(dot(normalize(vNormal), normalize(vViewDirection)));
    float fresnel = clamp(1.0 - facing, 0.0, 1.0);
    float broadRim = smoothstep(0.02, 0.92, pow(fresnel, 0.82));
    float glassRim = smoothstep(0.4, 0.98, pow(fresnel, 0.86));
    float innerEdge = smoothstep(0.08, 0.54, fresnel) * (1.0 - smoothstep(0.7, 0.96, fresnel));
    float highlight = pow(max(dot(normalize(vNormal), normalize(vec3(-0.42, 0.66, 0.61))), 0.0), 18.0);
    float frontAlpha = glassRim * 0.7 + broadRim * 0.14 + innerEdge * 0.08 + highlight * 0.2;
    float backAlpha = 0.028 + broadRim * 0.13;
    vec3 frontRadiance = mix(uDeepColor, vTint, 0.55) * broadRim * 0.34
      + vTint * (glassRim * (1.05 + vEmphasis * 0.75) + highlight * 0.7);
    vec3 backRadiance = uDeepColor + vTint * broadRim * 0.12;
    float alpha = mix(frontAlpha, backAlpha, uBackface) * vVisibility * (0.72 + vEmphasis * 0.28);
    gl_FragColor = vec4(mix(frontRadiance, backRadiance, uBackface), alpha);
  }
`;

const atmosphereVertexShader = `
  attribute float aSize;
  attribute float aPhase;
  varying float vAlpha;
  uniform float uTime;

  void main() {
    vec3 p = position;
    p.x += sin(uTime * 0.1 + aPhase) * 0.12;
    p.y += cos(uTime * 0.08 + aPhase * 1.2) * 0.1;
    vec4 viewPosition = modelViewMatrix * vec4(p, 1.0);
    float depthFade = 1.0 - smoothstep(70.0, 180.0, -viewPosition.z);
    vAlpha = (0.22 + 0.3 * sin(uTime * 0.42 + aPhase)) * depthFade;
    gl_PointSize = clamp(aSize * (72.0 / max(1.0, -viewPosition.z)), 1.0, 5.0);
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const atmosphereFragmentShader = `
  varying float vAlpha;
  uniform vec3 uColor;

  void main() {
    vec2 centered = gl_PointCoord - 0.5;
    float distanceFromCenter = length(centered);
    float core = 1.0 - smoothstep(0.0, 0.48, distanceFromCenter);
    float halo = 1.0 - smoothstep(0.12, 0.5, distanceFromCenter);
    if (core <= 0.0) discard;
    gl_FragColor = vec4(uColor * (core * 1.3 + halo * 0.28), vAlpha * (core + halo * 0.25));
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
    radius: 0.5 + Math.pow(node.degree / maxDegree, 0.55) * 1.15,
  }));
  const nodeIndex = new Map(sceneNodes.map((node, index) => [node.id, index]));
  const sceneLinks = links.flatMap((link): SceneLink[] => {
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
  const distance = Math.max(18, sphere.radius / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.22);
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
    const target = 5 + (1 - strength) * 5;
    const force = delta.multiplyScalar(((distance - target) / distance) * 0.012 * strength * alpha);
    from.velocity.add(force);
    to.velocity.sub(force);
  }
  updateRepulsion(nodes, alpha);
  for (const node of nodes) {
    node.velocity.multiplyScalar(0.82).clampLength(0, 0.55);
    node.position.add(node.velocity);
  }
}

function updateRepulsion(nodes: SceneNode[], alpha: number) {
  const count = nodes.length;
  const samples = count <= 220 ? count : 48;
  for (let index = 0; index < count; index += 1) {
    const node = nodes[index];
    for (let sample = 1; sample < samples; sample += 1) {
      const otherIndex = count <= 220 ? (index + sample) % count : (index * 37 + sample * 53) % count;
      if (otherIndex === index) continue;
      const delta = node.position.clone().sub(nodes[otherIndex].position);
      node.velocity.add(delta.normalize().multiplyScalar((0.04 * alpha) / Math.max(0.3, delta.lengthSq())));
    }
    node.velocity.add(node.position.clone().multiplyScalar(-0.0009 * alpha));
  }
}

function createShellMaterial(side: THREE.Side, deepColor: THREE.Color) {
  return new THREE.ShaderMaterial({
    vertexShader: shellVertexShader,
    fragmentShader: shellFragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uDeepColor: { value: deepColor },
      uBackface: { value: side === THREE.BackSide ? 1 : 0 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: side === THREE.BackSide ? THREE.NormalBlending : THREE.AdditiveBlending,
    side,
  });
}

function createAtmosphere(nodes: SceneNode[], color: THREE.Color) {
  const count = Math.min(620, Math.max(180, nodes.length * 4));
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);
  const bounds = new THREE.Box3();
  nodes.forEach((node) => bounds.expandByPoint(node.position));
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  for (let index = 0; index < count; index += 1) {
    const theta = seededUnit(index, 10) * Math.PI * 2;
    const phi = Math.acos(2 * seededUnit(index, 11) - 1);
    const radius = sphere.radius * (0.24 + Math.pow(seededUnit(index, 12), 0.62) * 1.12);
    positions[index * 3] = sphere.center.x + Math.sin(phi) * Math.cos(theta) * radius;
    positions[index * 3 + 1] = sphere.center.y + Math.cos(phi) * radius * 0.72;
    positions[index * 3 + 2] = sphere.center.z + Math.sin(phi) * Math.sin(theta) * radius;
    sizes[index] = 0.55 + Math.pow(seededUnit(index, 13), 2) * 2.4;
    phases[index] = seededUnit(index, 14) * Math.PI * 2;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
  const material = new THREE.ShaderMaterial({
    vertexShader: atmosphereVertexShader,
    fragmentShader: atmosphereFragmentShader,
    uniforms: { uTime: { value: 0 }, uColor: { value: color } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return { points: new THREE.Points(geometry, material), geometry, material };
}

function curveControlPoint(from: SceneNode, to: SceneNode, linkId: number) {
  const direction = to.position.clone().sub(from.position).normalize();
  const perpendicular = direction.clone().cross(Math.abs(direction.y) < 0.85 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0));
  const arc = 0.6 + seededUnit(linkId, 21) * 1.6;
  return from.position.clone().add(to.position).multiplyScalar(0.5).add(perpendicular.normalize().multiplyScalar(arc));
}

function curvePoint(from: THREE.Vector3, control: THREE.Vector3, to: THREE.Vector3, t: number, target: THREE.Vector3) {
  const inverse = 1 - t;
  target.copy(from).multiplyScalar(inverse * inverse)
    .addScaledVector(control, 2 * inverse * t)
    .addScaledVector(to, t * t);
  return target;
}

function overlaps(rect: DOMRect, occupied: DOMRect[]) {
  return occupied.some((other) => !(rect.right + 6 < other.left || rect.left - 6 > other.right || rect.bottom + 4 < other.top || rect.top - 4 > other.bottom));
}

export const MemoryGraph3D = forwardRef<MemoryGraph3DHandle, MemoryGraph3DProps>(function MemoryGraph3D(
  { nodes, links, selectedNodeId, onNodeSelect, onNodeHover },
  forwardedRef,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRefs = useRef(new Map<number, HTMLDivElement>());
  const sceneStateRef = useRef<{ camera: THREE.PerspectiveCamera; controls: OrbitControls; nodes: SceneNode[] } | null>(null);
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
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const { sceneNodes, sceneLinks } = buildSceneGraph(nodes, links);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 2000);
    camera.position.set(28, 18, 42);

    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.04;
    renderer.domElement.className = "absolute inset-0 h-full w-full outline-none";
    renderer.domElement.style.touchAction = "none";
    renderer.domElement.setAttribute("data-testid", "palace-graph");
    renderer.domElement.setAttribute("aria-label", "Interactive 3D memory graph");
    renderer.domElement.tabIndex = 0;
    host.prepend(renderer.domElement);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.68, 0.72);
    composer.addPass(bloomPass);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.rotateSpeed = 0.52;
    controls.zoomSpeed = 0.8;
    controls.panSpeed = 0.65;
    controls.minDistance = 4;
    controls.maxDistance = 600;
    controls.screenSpacePanning = true;

    const signalColor = colorFromToken("--cta");
    const activeColor = colorFromToken("--active");
    const deepColor = colorFromToken("--card").multiplyScalar(0.42);
    const deletionColor = colorFromToken("--destructive");
    const sphereGeometry = new THREE.IcosahedronGeometry(1, 4);
    const phases = new Float32Array(sceneNodes.length);
    const visibility = new Float32Array(sceneNodes.length);
    const emphasis = new Float32Array(sceneNodes.length);
    const tints = new Float32Array(sceneNodes.length * 3);
    sceneNodes.forEach((node, index) => {
      phases[index] = seededUnit(node.id, 4) * Math.PI * 2;
      visibility[index] = Math.max(0.48, node.decayScore || 1);
      signalColor.toArray(tints, index * 3);
    });
    sphereGeometry.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phases, 1));
    sphereGeometry.setAttribute("aVisibility", new THREE.InstancedBufferAttribute(visibility, 1));
    sphereGeometry.setAttribute("aEmphasis", new THREE.InstancedBufferAttribute(emphasis, 1));
    sphereGeometry.setAttribute("aTint", new THREE.InstancedBufferAttribute(tints, 3));
    const frontMaterial = createShellMaterial(THREE.FrontSide, deepColor);
    const backMaterial = createShellMaterial(THREE.BackSide, deepColor);
    const frontMesh = new THREE.InstancedMesh(sphereGeometry, frontMaterial, sceneNodes.length);
    const backMesh = new THREE.InstancedMesh(sphereGeometry, backMaterial, sceneNodes.length);
    for (const mesh of [backMesh, frontMesh]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      scene.add(mesh);
    }

    const linkPositions = new Float32Array(sceneLinks.length * LINK_SEGMENTS * 6);
    const linkGeometry = new THREE.BufferGeometry();
    linkGeometry.setAttribute("position", new THREE.BufferAttribute(linkPositions, 3).setUsage(THREE.DynamicDrawUsage));
    const linkMaterial = new THREE.LineBasicMaterial({
      color: signalColor.clone().multiplyScalar(0.48),
      transparent: true,
      opacity: 0.48,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const linkLines = new THREE.LineSegments(linkGeometry, linkMaterial);
    linkLines.frustumCulled = false;
    scene.add(linkLines);
    const linkCurves = sceneLinks.map(() => Array.from({ length: LINK_SEGMENTS + 1 }, () => new THREE.Vector3()));

    const pulseLinks = sceneLinks.slice().sort((a, b) => b.strength - a.strength).slice(0, MAX_PULSES);
    const pulseGeometry = new THREE.SphereGeometry(0.08, 6, 6);
    const pulseMaterial = new THREE.MeshBasicMaterial({ color: activeColor, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
    const pulseMesh = new THREE.InstancedMesh(pulseGeometry, pulseMaterial, pulseLinks.length);
    pulseMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    pulseMesh.frustumCulled = false;
    scene.add(pulseMesh);

    const atmosphere = createAtmosphere(sceneNodes, signalColor.clone().multiplyScalar(0.72));
    atmosphere.points.frustumCulled = false;
    scene.add(atmosphere.points);

    const transform = new THREE.Object3D();
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const projected = new THREE.Vector3();
    let hoveredIndex: number | null = null;
    let pointerDown = { x: 0, y: 0 };
    let simulationTick = 0;
    let animationFrame = 0;
    const clock = new THREE.Clock();

    function syncNodeInstances() {
      for (let index = 0; index < sceneNodes.length; index += 1) {
        const node = sceneNodes[index];
        const isSelected = selectedNodeIdRef.current === node.id;
        const isHovered = hoveredIndex === index;
        const scale = node.radius * (isSelected ? 1.26 : isHovered ? 1.14 : 1);
        transform.position.copy(node.position);
        transform.scale.setScalar(scale);
        transform.updateMatrix();
        frontMesh.setMatrixAt(index, transform.matrix);
        backMesh.setMatrixAt(index, transform.matrix);
        emphasis[index] = isSelected ? 1 : isHovered ? 0.68 : 0;
        (node.pendingDeletion ? deletionColor : isSelected || isHovered ? activeColor : signalColor).toArray(tints, index * 3);
      }
      frontMesh.instanceMatrix.needsUpdate = true;
      backMesh.instanceMatrix.needsUpdate = true;
      (sphereGeometry.getAttribute("aEmphasis") as THREE.InstancedBufferAttribute).needsUpdate = true;
      (sphereGeometry.getAttribute("aTint") as THREE.InstancedBufferAttribute).needsUpdate = true;
    }

    function syncLinks() {
      const segmentPoint = new THREE.Vector3();
      sceneLinks.forEach((link, linkIndex) => {
        const fromNode = sceneNodes[link.fromIndex];
        const toNode = sceneNodes[link.toIndex];
        const direction = toNode.position.clone().sub(fromNode.position).normalize();
        const from = fromNode.position.clone().addScaledVector(direction, fromNode.radius * 0.92);
        const to = toNode.position.clone().addScaledVector(direction, -toNode.radius * 0.92);
        const control = curveControlPoint(fromNode, toNode, link.id);
        for (let segment = 0; segment <= LINK_SEGMENTS; segment += 1) {
          curvePoint(from, control, to, segment / LINK_SEGMENTS, segmentPoint);
          linkCurves[linkIndex][segment].copy(segmentPoint);
          if (segment === LINK_SEGMENTS) continue;
          const offset = (linkIndex * LINK_SEGMENTS + segment) * 6;
          segmentPoint.toArray(linkPositions, offset);
          curvePoint(from, control, to, (segment + 1) / LINK_SEGMENTS, segmentPoint).toArray(linkPositions, offset + 3);
        }
      });
      (linkGeometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      linkGeometry.computeBoundingSphere();
    }

    function syncPulses(elapsed: number) {
      pulseLinks.forEach((link, index) => {
        const sceneLinkIndex = sceneLinks.indexOf(link);
        const points = linkCurves[sceneLinkIndex];
        const progress = reducedMotion ? 0.5 : (elapsed * (0.08 + link.strength * 0.08) + seededUnit(link.id, 30)) % 1;
        const scaled = progress * LINK_SEGMENTS;
        const segment = Math.min(LINK_SEGMENTS - 1, Math.floor(scaled));
        transform.position.copy(points[segment]).lerp(points[segment + 1], scaled - segment);
        const membraneFade = Math.sin(progress * Math.PI);
        transform.scale.setScalar(0.55 + membraneFade * 0.72);
        transform.updateMatrix();
        pulseMesh.setMatrixAt(index, transform.matrix);
      });
      pulseMesh.instanceMatrix.needsUpdate = true;
    }

    function syncLabels() {
      const width = host.clientWidth;
      const height = host.clientHeight;
      const visibleNodes: ProjectedNode[] = [];
      sceneNodes.forEach((node, index) => {
        const element = labelRefs.current.get(node.id);
        if (!element) return;
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
        element.style.opacity = selectedNodeIdRef.current === node.id || hoveredIndex === index ? "1" : String(THREE.MathUtils.clamp(1.15 - distance / 180, 0.42, 0.84));
        element.style.zIndex = String(Math.max(1, Math.round(1000 - distance)));
        visibleNodes.push({ index, x, y, distance });
      });
      syncLabelVisibility(visibleNodes, width);
    }

    function syncLabelVisibility(projectedNodes: ProjectedNode[], width: number) {
      const occupied: DOMRect[] = [];
      const maxLabels = width < 700 ? 14 : 38;
      projectedNodes.sort((a, b) => {
        const aNode = sceneNodes[a.index];
        const bNode = sceneNodes[b.index];
        const aPriority = selectedNodeIdRef.current === aNode.id ? 10000 : hoveredIndex === a.index ? 9000 : aNode.degree * 10 - a.distance;
        const bPriority = selectedNodeIdRef.current === bNode.id ? 10000 : hoveredIndex === b.index ? 9000 : bNode.degree * 10 - b.distance;
        return bPriority - aPriority;
      });
      projectedNodes.forEach((item, order) => {
        const node = sceneNodes[item.index];
        const label = labelRefs.current.get(node.id)?.querySelector<HTMLElement>("[data-node-label]");
        if (!label) return;
        const forced = selectedNodeIdRef.current === node.id || hoveredIndex === item.index;
        const labelWidth = Math.min(210, 44 + Math.min(node.label.length, 28) * 6.4);
        const rect = new DOMRect(item.x + 12, item.y - 15, labelWidth, 30);
        const show = forced || (order < maxLabels && !overlaps(rect, occupied));
        label.style.display = show ? "block" : "none";
        if (show) occupied.push(rect);
      });
    }

    function resize() {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      composer.setSize(width, height);
      bloomPass.setSize(width, height);
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
      const nextIndex = raycaster.intersectObject(frontMesh, false)[0]?.instanceId ?? null;
      if (nextIndex === hoveredIndex) return;
      hoveredIndex = nextIndex;
      renderer.domElement.style.cursor = nextIndex == null ? "grab" : "pointer";
      if (nextIndex == null) onNodeHoverRef.current(null);
      else onNodeHoverRef.current(sceneNodes[nextIndex].id, { x: event.clientX - rect.left + 16, y: event.clientY - rect.top });
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

    function render() {
      animationFrame = requestAnimationFrame(render);
      const elapsed = reducedMotion ? 0 : clock.getElapsedTime();
      if (simulationTick < 260) {
        updateSimulation(sceneNodes, sceneLinks, simulationTick);
        simulationTick += 1;
        syncLinks();
      }
      syncNodeInstances();
      syncPulses(elapsed);
      frontMaterial.uniforms.uTime.value = elapsed;
      backMaterial.uniforms.uTime.value = elapsed;
      atmosphere.material.uniforms.uTime.value = elapsed;
      controls.update();
      syncLabels();
      composer.render();
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      } else if (animationFrame === 0) {
        clock.getDelta();
        animationFrame = requestAnimationFrame(render);
      }
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    renderer.domElement.addEventListener("pointermove", findHoveredNode);
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("pointerleave", handlePointerLeave);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    resize();
    fitCamera(camera, controls, sceneNodes);
    sceneStateRef.current = { camera, controls, nodes: sceneNodes };
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
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      controls.dispose();
      sphereGeometry.dispose();
      frontMaterial.dispose();
      backMaterial.dispose();
      linkGeometry.dispose();
      linkMaterial.dispose();
      pulseGeometry.dispose();
      pulseMaterial.dispose();
      atmosphere.geometry.dispose();
      atmosphere.material.dispose();
      bloomPass.dispose();
      composer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [nodes, links]);

  return (
    <div ref={hostRef} className="relative h-full w-full overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,hsl(var(--cta)/0.08),transparent_64%)]" />
      <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-hidden="true">
        {nodes.map((node) => (
          <div
            key={node.id}
            ref={(element) => {
              if (element) labelRefs.current.set(node.id, element);
              else labelRefs.current.delete(node.id);
            }}
            className="absolute left-0 top-0 flex items-center gap-1.5 will-change-transform"
            title={node.label}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-cta/25 bg-card/85 text-active shadow-sm backdrop-blur-sm">
              <MemorySourceIcon source={node.source} className="h-3.5 w-3.5" />
            </span>
            <span data-node-label className="max-w-[210px] truncate whitespace-nowrap rounded-md border border-card-border bg-card/85 px-2 py-1 text-xs font-medium text-foreground shadow-sm backdrop-blur-sm">
              {node.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});
