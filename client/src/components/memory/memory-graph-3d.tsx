import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
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

const CURVE_SEGMENTS = 6;
const MAX_PULSES = 28;
const LABEL_THROTTLE_FRAMES = 3;

/* ─── Shaders ─── */

const nodeVertexShader = `
  attribute float aPhase;
  attribute float aVisibility;
  attribute float aEmphasis;
  attribute vec3 aTint;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec3 vTint;
  varying float vVisibility;
  varying float vEmphasis;
  uniform float uTime;

  void main() {
    float breathing = 1.0 + sin(uTime * 0.9 + aPhase) * 0.015;
    vec4 world = modelMatrix * instanceMatrix * vec4(position * breathing, 1.0);
    vNormal = normalize(mat3(modelMatrix * instanceMatrix) * normal);
    vViewDir = normalize(cameraPosition - world.xyz);
    vTint = aTint;
    vVisibility = aVisibility;
    vEmphasis = aEmphasis;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const nodeFragmentShader = `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec3 vTint;
  varying float vVisibility;
  varying float vEmphasis;

  void main() {
    float facing = abs(dot(normalize(vNormal), normalize(vViewDir)));
    float fresnel = 1.0 - facing;
    float rim = smoothstep(0.0, 0.85, pow(fresnel, 0.7));
    float core = smoothstep(0.3, 0.9, facing) * 0.35;
    float highlight = pow(max(dot(normalize(vNormal), normalize(vec3(-0.4, 0.6, 0.5))), 0.0), 12.0);
    float alpha = (rim * 0.85 + core + highlight * 0.4) * vVisibility * (0.7 + vEmphasis * 0.3);
    vec3 color = vTint * (rim * 0.6 + core * 0.5 + highlight * 0.8 + 0.25);
    gl_FragColor = vec4(color, clamp(alpha, 0.18, 1.0));
  }
`;

const dustVertexShader = `
  attribute float aSize;
  attribute float aPhase;
  varying float vAlpha;
  uniform float uTime;

  void main() {
    vec3 p = position;
    p.x += sin(uTime * 0.08 + aPhase) * 0.15;
    p.y += cos(uTime * 0.06 + aPhase * 1.3) * 0.12;
    vec4 viewPos = modelViewMatrix * vec4(p, 1.0);
    float depthFade = 1.0 - smoothstep(60.0, 160.0, -viewPos.z);
    vAlpha = (0.18 + 0.2 * sin(uTime * 0.35 + aPhase)) * depthFade;
    gl_PointSize = clamp(aSize * (60.0 / max(1.0, -viewPos.z)), 0.8, 3.5);
    gl_Position = projectionMatrix * viewPos;
  }
`;

const dustFragmentShader = `
  varying float vAlpha;
  uniform vec3 uColor;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    float c = 1.0 - smoothstep(0.0, 0.5, d);
    if (c <= 0.0) discard;
    gl_FragColor = vec4(uColor, vAlpha * c);
  }
`;

/* ─── Helpers ─── */

function colorFromToken(token: string): THREE.Color {
  const root = getComputedStyle(document.documentElement);
  const val = root.getPropertyValue(token).trim();
  const fb = root.getPropertyValue("--foreground").trim() || getComputedStyle(document.body).color;
  return new THREE.Color(val ? `hsl(${val})` : fb.startsWith("rgb") ? fb : `hsl(${fb})`);
}

function seed(id: number, salt: number): number {
  const v = Math.sin(id * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

function initPosition(nodeId: number, index: number, count: number): THREE.Vector3 {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - ((index + 0.5) / Math.max(1, count)) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = golden * index + seed(nodeId, 1) * 0.5;
  const shell = Math.max(14, Math.cbrt(Math.max(1, count)) * 7);
  const depth = 0.7 + seed(nodeId, 2) * 0.45;
  return new THREE.Vector3(
    Math.cos(theta) * r * shell * depth,
    y * shell * depth,
    Math.sin(theta) * r * shell * depth,
  );
}

function buildGraph(nodes: MemoryGraph3DNode[], links: MemoryGraph3DLink[]) {
  const maxDeg = Math.max(1, ...nodes.map((n) => n.degree));
  const sceneNodes: SceneNode[] = nodes.map((node, i) => ({
    ...node,
    position: initPosition(node.id, i, nodes.length),
    velocity: new THREE.Vector3(),
    radius: 1.4 + Math.pow(node.degree / maxDeg, 0.5) * 2.8,
  }));
  const idx = new Map(sceneNodes.map((n, i) => [n.id, i]));
  const sceneLinks = links.flatMap((link): SceneLink[] => {
    const fi = idx.get(link.fromId);
    const ti = idx.get(link.toId);
    return fi == null || ti == null ? [] : [{ ...link, fromIndex: fi, toIndex: ti }];
  });
  return { sceneNodes, sceneLinks };
}

function fitCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls, nodes: SceneNode[]) {
  if (!nodes.length) return;
  const box = new THREE.Box3();
  nodes.forEach((n) => box.expandByPoint(n.position));
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const dist = Math.max(22, sphere.radius / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.25);
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (dir.lengthSq() === 0) dir.set(0.6, 0.35, 1);
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).add(dir.multiplyScalar(dist));
  camera.near = Math.max(0.1, dist / 200);
  camera.far = Math.max(500, dist * 20);
  camera.updateProjectionMatrix();
  controls.update();
}

function simulate(nodes: SceneNode[], links: SceneLink[], tick: number) {
  const alpha = Math.max(0, 1 - tick / 200);
  if (alpha <= 0) return;
  for (const link of links) {
    const a = nodes[link.fromIndex], b = nodes[link.toIndex];
    const d = b.position.clone().sub(a.position);
    const dist = Math.max(0.01, d.length());
    const str = Math.max(0.15, link.strength || 0.5);
    const target = 8 + (1 - str) * 8;
    const f = d.multiplyScalar(((dist - target) / dist) * 0.014 * str * alpha);
    a.velocity.add(f);
    b.velocity.sub(f);
  }
  // Repulsion — sample-based for large graphs
  const count = nodes.length;
  const samples = count <= 160 ? count : 36;
  for (let i = 0; i < count; i++) {
    const node = nodes[i];
    for (let s = 1; s < samples; s++) {
      const j = count <= 160 ? (i + s) % count : (i * 37 + s * 53) % count;
      if (j === i) continue;
      const d = node.position.clone().sub(nodes[j].position);
      node.velocity.add(d.normalize().multiplyScalar((0.05 * alpha) / Math.max(0.3, d.lengthSq())));
    }
    node.velocity.add(node.position.clone().multiplyScalar(-0.001 * alpha));
  }
  for (const node of nodes) {
    node.velocity.multiplyScalar(0.8).clampLength(0, 0.6);
    node.position.add(node.velocity);
  }
}

function curveControl(from: SceneNode, to: SceneNode, linkId: number) {
  const dir = to.position.clone().sub(from.position).normalize();
  const perp = dir.clone().cross(Math.abs(dir.y) < 0.85 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0));
  return from.position.clone().add(to.position).multiplyScalar(0.5).add(perp.normalize().multiplyScalar(0.8 + seed(linkId, 21) * 1.8));
}

function bezier(a: THREE.Vector3, ctrl: THREE.Vector3, b: THREE.Vector3, t: number, out: THREE.Vector3) {
  const inv = 1 - t;
  out.copy(a).multiplyScalar(inv * inv).addScaledVector(ctrl, 2 * inv * t).addScaledVector(b, t * t);
  return out;
}

function overlaps(rect: DOMRect, occupied: DOMRect[]) {
  return occupied.some((o) => !(rect.right + 6 < o.left || rect.left - 6 > o.right || rect.bottom + 4 < o.top || rect.top - 4 > o.bottom));
}

/* ─── Component ─── */

export const MemoryGraph3D = forwardRef<MemoryGraph3DHandle, MemoryGraph3DProps>(function MemoryGraph3D(
  { nodes, links, selectedNodeId, onNodeSelect, onNodeHover },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRefs = useRef(new Map<number, HTMLDivElement>());
  const stateRef = useRef<{ camera: THREE.PerspectiveCamera; controls: OrbitControls; nodes: SceneNode[] } | null>(null);
  const selectedRef = useRef(selectedNodeId);
  selectedRef.current = selectedNodeId;
  const selectCb = useRef(onNodeSelect);
  selectCb.current = onNodeSelect;
  const hoverCb = useRef(onNodeHover);
  hoverCb.current = onNodeHover;

  useImperativeHandle(ref, () => ({
    zoomIn: () => {
      const s = stateRef.current;
      if (s) { s.camera.position.lerp(s.controls.target, 0.2); s.controls.update(); }
    },
    zoomOut: () => {
      const s = stateRef.current;
      if (s) { const o = s.camera.position.clone().sub(s.controls.target).multiplyScalar(1.25); s.camera.position.copy(s.controls.target).add(o); s.controls.update(); }
    },
    fitToView: () => { const s = stateRef.current; if (s) fitCamera(s.camera, s.controls, s.nodes); },
  }), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || nodes.length === 0) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const { sceneNodes, sceneLinks } = buildGraph(nodes, links);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 2000);
    camera.position.set(30, 20, 45);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = "absolute inset-0 h-full w-full outline-none";
    renderer.domElement.style.touchAction = "none";
    renderer.domElement.setAttribute("data-testid", "palace-graph");
    renderer.domElement.setAttribute("aria-label", "Interactive 3D memory graph");
    renderer.domElement.tabIndex = 0;
    host.prepend(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.55;
    controls.zoomSpeed = 0.85;
    controls.panSpeed = 0.65;
    controls.minDistance = 6;
    controls.maxDistance = 500;
    controls.screenSpacePanning = true;

    // Colors
    const signalColor = colorFromToken("--cta");
    const activeColor = colorFromToken("--active");
    const deletionColor = colorFromToken("--destructive");

    // Node mesh — single pass, no bloom
    const geo = new THREE.IcosahedronGeometry(1, 3);
    const phases = new Float32Array(sceneNodes.length);
    const visibility = new Float32Array(sceneNodes.length);
    const emphasis = new Float32Array(sceneNodes.length);
    const tints = new Float32Array(sceneNodes.length * 3);
    sceneNodes.forEach((n, i) => {
      phases[i] = seed(n.id, 4) * Math.PI * 2;
      visibility[i] = Math.max(0.55, n.decayScore || 1);
      signalColor.toArray(tints, i * 3);
    });
    geo.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phases, 1));
    geo.setAttribute("aVisibility", new THREE.InstancedBufferAttribute(visibility, 1));
    geo.setAttribute("aEmphasis", new THREE.InstancedBufferAttribute(emphasis, 1));
    geo.setAttribute("aTint", new THREE.InstancedBufferAttribute(tints, 3));

    const nodeMat = new THREE.ShaderMaterial({
      vertexShader: nodeVertexShader,
      fragmentShader: nodeFragmentShader,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
    });
    const nodeMesh = new THREE.InstancedMesh(geo, nodeMat, sceneNodes.length);
    nodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    nodeMesh.frustumCulled = false;
    scene.add(nodeMesh);

    // Links — line segments
    const linkPositions = new Float32Array(sceneLinks.length * CURVE_SEGMENTS * 6);
    const linkGeo = new THREE.BufferGeometry();
    linkGeo.setAttribute("position", new THREE.BufferAttribute(linkPositions, 3).setUsage(THREE.DynamicDrawUsage));
    const linkMat = new THREE.LineBasicMaterial({
      color: signalColor.clone().multiplyScalar(0.5),
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    const linkLines = new THREE.LineSegments(linkGeo, linkMat);
    linkLines.frustumCulled = false;
    scene.add(linkLines);
    const linkCurves = sceneLinks.map(() => Array.from({ length: CURVE_SEGMENTS + 1 }, () => new THREE.Vector3()));

    // Pulses — small spheres traveling along top links
    const pulseLinks = sceneLinks.slice().sort((a, b) => b.strength - a.strength).slice(0, MAX_PULSES);
    const pulseGeo = new THREE.SphereGeometry(0.18, 6, 6);
    const pulseMat = new THREE.MeshBasicMaterial({ color: activeColor, transparent: true, opacity: 0.85, depthWrite: false });
    const pulseMesh = new THREE.InstancedMesh(pulseGeo, pulseMat, pulseLinks.length);
    pulseMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    pulseMesh.frustumCulled = false;
    scene.add(pulseMesh);

    // Atmosphere dust — sparse
    const dustCount = Math.min(200, Math.max(80, nodes.length * 2));
    const dustPositions = new Float32Array(dustCount * 3);
    const dustSizes = new Float32Array(dustCount);
    const dustPhases = new Float32Array(dustCount);
    const bounds = new THREE.Box3();
    sceneNodes.forEach((n) => bounds.expandByPoint(n.position));
    const bSphere = bounds.getBoundingSphere(new THREE.Sphere());
    for (let i = 0; i < dustCount; i++) {
      const theta = seed(i, 10) * Math.PI * 2;
      const phi = Math.acos(2 * seed(i, 11) - 1);
      const rad = bSphere.radius * (0.3 + Math.pow(seed(i, 12), 0.6) * 1.1);
      dustPositions[i * 3] = bSphere.center.x + Math.sin(phi) * Math.cos(theta) * rad;
      dustPositions[i * 3 + 1] = bSphere.center.y + Math.cos(phi) * rad * 0.7;
      dustPositions[i * 3 + 2] = bSphere.center.z + Math.sin(phi) * Math.sin(theta) * rad;
      dustSizes[i] = 0.6 + seed(i, 13) * 2;
      dustPhases[i] = seed(i, 14) * Math.PI * 2;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
    dustGeo.setAttribute("aSize", new THREE.BufferAttribute(dustSizes, 1));
    dustGeo.setAttribute("aPhase", new THREE.BufferAttribute(dustPhases, 1));
    const dustMat = new THREE.ShaderMaterial({
      vertexShader: dustVertexShader,
      fragmentShader: dustFragmentShader,
      uniforms: { uTime: { value: 0 }, uColor: { value: signalColor.clone().multiplyScalar(0.6) } },
      transparent: true,
      depthWrite: false,
    });
    const dustPoints = new THREE.Points(dustGeo, dustMat);
    dustPoints.frustumCulled = false;
    scene.add(dustPoints);

    // State
    const xform = new THREE.Object3D();
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const projected = new THREE.Vector3();
    let hovered: number | null = null;
    let pDown = { x: 0, y: 0 };
    let simTick = 0;
    let frame = 0;
    let labelFrame = 0;
    const clock = new THREE.Clock();

    function syncNodes() {
      for (let i = 0; i < sceneNodes.length; i++) {
        const n = sceneNodes[i];
        const sel = selectedRef.current === n.id;
        const hov = hovered === i;
        const s = n.radius * (sel ? 1.22 : hov ? 1.12 : 1);
        xform.position.copy(n.position);
        xform.scale.setScalar(s);
        xform.updateMatrix();
        nodeMesh.setMatrixAt(i, xform.matrix);
        emphasis[i] = sel ? 1 : hov ? 0.7 : 0;
        (n.pendingDeletion ? deletionColor : sel || hov ? activeColor : signalColor).toArray(tints, i * 3);
      }
      nodeMesh.instanceMatrix.needsUpdate = true;
      (geo.getAttribute("aEmphasis") as THREE.InstancedBufferAttribute).needsUpdate = true;
      (geo.getAttribute("aTint") as THREE.InstancedBufferAttribute).needsUpdate = true;
    }

    function syncLinks() {
      const tmp = new THREE.Vector3();
      sceneLinks.forEach((link, li) => {
        const a = sceneNodes[link.fromIndex], b = sceneNodes[link.toIndex];
        const dir = b.position.clone().sub(a.position).normalize();
        const from = a.position.clone().addScaledVector(dir, a.radius * 0.95);
        const to = b.position.clone().addScaledVector(dir, -b.radius * 0.95);
        const ctrl = curveControl(a, b, link.id);
        for (let s = 0; s <= CURVE_SEGMENTS; s++) {
          bezier(from, ctrl, to, s / CURVE_SEGMENTS, tmp);
          linkCurves[li][s].copy(tmp);
          if (s === CURVE_SEGMENTS) continue;
          const off = (li * CURVE_SEGMENTS + s) * 6;
          tmp.toArray(linkPositions, off);
          bezier(from, ctrl, to, (s + 1) / CURVE_SEGMENTS, tmp).toArray(linkPositions, off + 3);
        }
      });
      (linkGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      linkGeo.computeBoundingSphere();
    }

    function syncPulses(t: number) {
      pulseLinks.forEach((link, i) => {
        const li = sceneLinks.indexOf(link);
        const pts = linkCurves[li];
        const prog = reducedMotion ? 0.5 : (t * (0.07 + link.strength * 0.07) + seed(link.id, 30)) % 1;
        const scaled = prog * CURVE_SEGMENTS;
        const seg = Math.min(CURVE_SEGMENTS - 1, Math.floor(scaled));
        xform.position.copy(pts[seg]).lerp(pts[seg + 1], scaled - seg);
        xform.scale.setScalar(0.6 + Math.sin(prog * Math.PI) * 0.5);
        xform.updateMatrix();
        pulseMesh.setMatrixAt(i, xform.matrix);
      });
      pulseMesh.instanceMatrix.needsUpdate = true;
    }

    function syncLabels() {
      const w = host.clientWidth, h = host.clientHeight;
      const visible: ProjectedNode[] = [];
      sceneNodes.forEach((n, i) => {
        const el = labelRefs.current.get(n.id);
        if (!el) return;
        projected.copy(n.position).project(camera);
        const vis = projected.z > -1 && projected.z < 1 && Math.abs(projected.x) < 1.1 && Math.abs(projected.y) < 1.1;
        if (!vis) { el.style.visibility = "hidden"; return; }
        const x = (projected.x * 0.5 + 0.5) * w;
        const y = (-projected.y * 0.5 + 0.5) * h;
        const dist = camera.position.distanceTo(n.position);
        el.style.visibility = "visible";
        el.style.transform = `translate3d(${x}px,${y}px,0) translate(-50%,-50%)`;
        el.style.opacity = selectedRef.current === n.id || hovered === i ? "1" : String(THREE.MathUtils.clamp(1.2 - dist / 160, 0.4, 0.85));
        el.style.zIndex = String(Math.max(1, Math.round(1000 - dist)));
        visible.push({ index: i, x, y, distance: dist });
      });
      // Collision-based label suppression
      const occupied: DOMRect[] = [];
      const maxLabels = w < 700 ? 12 : 32;
      visible.sort((a, b) => {
        const an = sceneNodes[a.index], bn = sceneNodes[b.index];
        const ap = selectedRef.current === an.id ? 1e4 : hovered === a.index ? 9e3 : an.degree * 10 - a.distance;
        const bp = selectedRef.current === bn.id ? 1e4 : hovered === b.index ? 9e3 : bn.degree * 10 - b.distance;
        return bp - ap;
      });
      visible.forEach((item, order) => {
        const n = sceneNodes[item.index];
        const label = labelRefs.current.get(n.id)?.querySelector<HTMLElement>("[data-node-label]");
        if (!label) return;
        const forced = selectedRef.current === n.id || hovered === item.index;
        const lw = Math.min(200, 44 + Math.min(n.label.length, 26) * 6.2);
        const rect = new DOMRect(item.x + 14, item.y - 14, lw, 28);
        const show = forced || (order < maxLabels && !overlaps(rect, occupied));
        label.style.display = show ? "block" : "none";
        if (show) occupied.push(rect);
      });
    }

    function resize() {
      const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    function onPointerMove(e: PointerEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const next = raycaster.intersectObject(nodeMesh, false)[0]?.instanceId ?? null;
      if (next === hovered) return;
      hovered = next;
      renderer.domElement.style.cursor = next == null ? "grab" : "pointer";
      if (next == null) hoverCb.current(null);
      else hoverCb.current(sceneNodes[next].id, { x: e.clientX - rect.left + 16, y: e.clientY - rect.top });
    }
    function onPointerDown(e: PointerEvent) { pDown = { x: e.clientX, y: e.clientY }; renderer.domElement.style.cursor = hovered == null ? "grabbing" : "pointer"; }
    function onPointerUp(e: PointerEvent) {
      if (Math.hypot(e.clientX - pDown.x, e.clientY - pDown.y) < 6 && hovered != null) selectCb.current(sceneNodes[hovered].id);
      renderer.domElement.style.cursor = hovered == null ? "grab" : "pointer";
    }
    function onPointerLeave() { hovered = null; renderer.domElement.style.cursor = "grab"; hoverCb.current(null); }

    function render() {
      frame = requestAnimationFrame(render);
      const elapsed = reducedMotion ? 0 : clock.getElapsedTime();
      if (simTick < 200) { simulate(sceneNodes, sceneLinks, simTick); simTick++; syncLinks(); }
      syncNodes();
      syncPulses(elapsed);
      nodeMat.uniforms.uTime.value = elapsed;
      dustMat.uniforms.uTime.value = elapsed;
      controls.update();
      labelFrame++;
      if (labelFrame >= LABEL_THROTTLE_FRAMES) { labelFrame = 0; syncLabels(); }
      renderer.render(scene, camera);
    }

    function onVis() {
      if (document.hidden) { cancelAnimationFrame(frame); frame = 0; }
      else if (!frame) { clock.getDelta(); frame = requestAnimationFrame(render); }
    }

    const ro = new ResizeObserver(resize);
    ro.observe(host);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointerleave", onPointerLeave);
    document.addEventListener("visibilitychange", onVis);
    resize();
    fitCamera(camera, controls, sceneNodes);
    stateRef.current = { camera, controls, nodes: sceneNodes };
    syncLinks();
    render();

    return () => {
      cancelAnimationFrame(frame);
      stateRef.current = null;
      ro.disconnect();
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", onVis);
      controls.dispose();
      geo.dispose();
      nodeMat.dispose();
      linkGeo.dispose();
      linkMat.dispose();
      pulseGeo.dispose();
      pulseMat.dispose();
      dustGeo.dispose();
      dustMat.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [nodes, links]);

  return (
    <div ref={hostRef} className="relative h-full w-full overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,hsl(var(--cta)/0.06),transparent_60%)]" />
      <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-hidden="true">
        {nodes.map((node) => (
          <div
            key={node.id}
            ref={(el) => { if (el) labelRefs.current.set(node.id, el); else labelRefs.current.delete(node.id); }}
            className="absolute left-0 top-0 flex items-center gap-1.5 will-change-transform"
            title={node.label}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-cta/30 bg-card/90 text-active shadow-sm backdrop-blur-sm">
              <MemorySourceIcon source={node.source} className="h-3.5 w-3.5" />
            </span>
            <span data-node-label className="max-w-[200px] truncate whitespace-nowrap rounded-md border border-card-border bg-card/90 px-2 py-1 text-xs font-medium text-foreground shadow-sm backdrop-blur-sm">
              {node.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});
