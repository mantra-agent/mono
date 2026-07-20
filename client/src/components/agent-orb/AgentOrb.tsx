import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { AgentOrbProps } from './types';
import {
  orbVertexShader,
  orbFragmentShader,
  haloVertexShader,
  haloFragmentShader,
} from './shaders';
import { createAnimationState, tickAnimation } from './orb-state';

/** Max device pixel ratio to keep SwiftShader viable */
const MAX_DPR = 1.5;
/** Sphere geometry resolution (width segments, height segments) */
const SPHERE_DETAIL = [32, 24] as const;
/** Outer halo sphere scale relative to main orb */
const HALO_SCALE = 1.35;

/**
 * AgentOrb — volumetric glowing orb voice visualizer.
 *
 * Pure render component: (state, audioLevel) → pixels.
 * No transport logic. No data fetching. Props-driven only.
 */
export function AgentOrb({ state, audioLevel, className }: AgentOrbProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  const audioRef = useRef(audioLevel);

  // Keep refs in sync without triggering effect re-runs
  stateRef.current = state;
  audioRef.current = audioLevel;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // ── Renderer ──────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));
    renderer.setClearColor(0x000000, 1);
    container.appendChild(renderer.domElement);

    // ── Scene + Camera ────────────────────────────────────────
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 4);
    camera.lookAt(0, 0, 0);

    // ── Geometry (shared between orb and halo) ────────────────
    const sphereGeo = new THREE.SphereGeometry(1, ...SPHERE_DETAIL);

    // ── Main orb material ─────────────────────────────────────
    const orbUniforms = {
      uTime: { value: 0 },
      uRimPower: { value: 3.0 },
      uRimIntensity: { value: 0.7 },
      uCoreGlow: { value: 0.02 },
      uAudioLevel: { value: 0 },
      uAudioReactivity: { value: 0 },
      uSwirlAmount: { value: 0 },
      uSwirlSpeed: { value: 0 },
      uTickCount: { value: 0 },
      uTickSpeed: { value: 0 },
      uBreathPhase: { value: 0 },
      uPulseStrength: { value: 0 },
      uDimming: { value: 1.0 },
    };

    const orbMaterial = new THREE.ShaderMaterial({
      vertexShader: orbVertexShader,
      fragmentShader: orbFragmentShader,
      uniforms: orbUniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });

    const orbMesh = new THREE.Mesh(sphereGeo, orbMaterial);
    scene.add(orbMesh);

    // ── Outer halo ────────────────────────────────────────────
    const haloUniforms = {
      uIntensity: { value: 1.0 },
      uDimming: { value: 1.0 },
    };

    const haloMaterial = new THREE.ShaderMaterial({
      vertexShader: haloVertexShader,
      fragmentShader: haloFragmentShader,
      uniforms: haloUniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
    });

    const haloMesh = new THREE.Mesh(sphereGeo, haloMaterial);
    haloMesh.scale.setScalar(HALO_SCALE);
    scene.add(haloMesh);

    // ── Animation state ───────────────────────────────────────
    const anim = createAnimationState(stateRef.current);
    let lastTime = performance.now();
    let animFrameId = 0;

    // ── Resize handler ────────────────────────────────────────
    function resize() {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    // ── Render loop ───────────────────────────────────────────
    function animate(now: number) {
      animFrameId = requestAnimationFrame(animate);

      const dt = Math.min((now - lastTime) / 1000, 0.1); // cap dt to avoid jumps
      lastTime = now;

      const visuals = tickAnimation(
        anim,
        dt,
        stateRef.current,
        audioRef.current,
      );

      // Push interpolated visuals to shader uniforms
      orbUniforms.uTime.value = anim.time;
      orbUniforms.uRimPower.value = visuals.rimPower;
      orbUniforms.uRimIntensity.value = visuals.rimIntensity;
      orbUniforms.uCoreGlow.value = visuals.coreGlow;
      orbUniforms.uAudioLevel.value = anim.effectiveAudioLevel;
      orbUniforms.uAudioReactivity.value = visuals.audioReactivity;
      orbUniforms.uSwirlAmount.value = visuals.swirlAmount;
      orbUniforms.uSwirlSpeed.value = visuals.swirlSpeed;
      orbUniforms.uTickCount.value = visuals.tickCount;
      orbUniforms.uTickSpeed.value = visuals.tickSpeed;
      orbUniforms.uPulseStrength.value = visuals.pulseStrength;
      orbUniforms.uDimming.value = visuals.dimming;

      // Breathing modulation
      const breathPhase =
        visuals.breathDepth * Math.sin(anim.time * visuals.breathSpeed);
      orbUniforms.uBreathPhase.value = breathPhase;

      // Audio-driven scale pulse for speaking
      const scalePulse = 1.0 + anim.effectiveAudioLevel * visuals.pulseStrength * 0.08;
      orbMesh.scale.setScalar(scalePulse);

      // Halo intensity tracks main orb
      haloUniforms.uIntensity.value =
        visuals.rimIntensity * (1.0 + anim.effectiveAudioLevel * visuals.audioReactivity * 0.5);
      haloUniforms.uDimming.value = visuals.dimming;
      haloMesh.scale.setScalar(HALO_SCALE * scalePulse);

      renderer.render(scene, camera);
    }

    animFrameId = requestAnimationFrame(animate);

    // ── Cleanup ───────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(animFrameId);
      resizeObserver.disconnect();
      orbMaterial.dispose();
      haloMaterial.dispose();
      sphereGeo.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: '100%', height: '100%', background: '#000' }}
    />
  );
}
