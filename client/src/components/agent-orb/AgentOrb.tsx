import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { createLogger } from '@/lib/logger';
import type { AgentOrbProps } from './types';
import {
  fieldVertexShader,
  fieldFragmentShader,
  orbVertexShader,
  orbFragmentShader,
  haloVertexShader,
  haloFragmentShader,
} from './shaders';
import { createAnimationState, tickAnimation } from './orb-state';

const log = createLogger('AgentOrb');
const MAX_DPR = 1.5;
const SPHERE_DETAIL = [32, 24] as const;
const FIELD_DETAIL = [24, 18] as const;
const HALO_SCALE = 1.35;

function qualitySteps(maxFrameRate: number): number {
  if (maxFrameRate <= 20) return 12;
  if (maxFrameRate <= 30) return 16;
  return 22;
}

/**
 * AgentOrb is the shared pure render boundary for every voice host.
 * It owns GPU lifecycle only. Transport, state ownership, and audio capture stay outside.
 */
export function AgentOrb({ state, audioLevel, maxFrameRate = 60, className }: AgentOrbProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  const audioRef = useRef(audioLevel);
  const [webGlFailed, setWebGlFailed] = useState(false);

  stateRef.current = state;
  audioRef.current = audioLevel;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (error) {
      setWebGlFailed(true);
      log.warn('WebGL unavailable; rendering static Agent Orb fallback', error);
      return;
    }

    setWebGlFailed(false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));
    renderer.setClearColor(0x000000, 1);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 4);
    camera.lookAt(0, 0, 0);

    const fieldGeometry = new THREE.SphereGeometry(1, ...FIELD_DETAIL);
    const shellGeometry = new THREE.SphereGeometry(1, ...SPHERE_DETAIL);

    const fieldUniforms = {
      uTime: { value: 0 },
      uAudioLevel: { value: 0 },
      uDimming: { value: 1 },
      uFieldEnergy: { value: 0 },
      uFilamentDensity: { value: 0.7 },
      uCloudDensity: { value: 0.3 },
      uFlowSpeed: { value: 0 },
      uFlowStrength: { value: 0 },
      uCoherence: { value: 1 },
      uAttractorStrength: { value: 0 },
      uKnotStrength: { value: 0 },
      uOrbitPrecision: { value: 0 },
      uWaveEnergy: { value: 0 },
      uCoreDarkness: { value: 0.7 },
      uQualitySteps: { value: qualitySteps(maxFrameRate) },
    };
    const fieldMaterial = new THREE.ShaderMaterial({
      vertexShader: fieldVertexShader,
      fragmentShader: fieldFragmentShader,
      uniforms: fieldUniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
    });
    const fieldMesh = new THREE.Mesh(fieldGeometry, fieldMaterial);
    scene.add(fieldMesh);

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
    const orbMesh = new THREE.Mesh(shellGeometry, orbMaterial);
    scene.add(orbMesh);

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
    const haloMesh = new THREE.Mesh(shellGeometry, haloMaterial);
    haloMesh.scale.setScalar(HALO_SCALE);
    scene.add(haloMesh);

    const anim = createAnimationState(stateRef.current);
    let lastTime = performance.now();
    let lastRenderTime = 0;
    let animFrameId = 0;
    let hidden = document.hidden;
    const frameIntervalMs = 1000 / Math.max(1, Math.min(60, maxFrameRate));

    function resize() {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    }

    function applyVisuals(now: number) {
      if (hidden) return;
      if (now - lastRenderTime < frameIntervalMs) return;
      lastRenderTime = now;

      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      const visuals = tickAnimation(anim, dt, stateRef.current, audioRef.current);
      const audio = anim.effectiveAudioLevel;
      const breath = visuals.breathDepth * Math.sin(anim.time * visuals.breathSpeed);

      fieldUniforms.uTime.value = anim.time;
      fieldUniforms.uAudioLevel.value = audio;
      fieldUniforms.uDimming.value = visuals.dimming;
      fieldUniforms.uFieldEnergy.value = visuals.fieldEnergy;
      fieldUniforms.uFilamentDensity.value = visuals.filamentDensity;
      fieldUniforms.uCloudDensity.value = visuals.cloudDensity;
      fieldUniforms.uFlowSpeed.value = visuals.flowSpeed;
      fieldUniforms.uFlowStrength.value = visuals.flowStrength;
      fieldUniforms.uCoherence.value = visuals.coherence;
      fieldUniforms.uAttractorStrength.value = visuals.attractorStrength;
      fieldUniforms.uKnotStrength.value = visuals.knotStrength;
      fieldUniforms.uOrbitPrecision.value = visuals.orbitPrecision;
      fieldUniforms.uWaveEnergy.value = visuals.waveEnergy;
      fieldUniforms.uCoreDarkness.value = visuals.coreDarkness;

      orbUniforms.uTime.value = anim.time;
      orbUniforms.uRimPower.value = visuals.rimPower;
      orbUniforms.uRimIntensity.value = visuals.rimIntensity;
      orbUniforms.uCoreGlow.value = visuals.coreGlow;
      orbUniforms.uAudioLevel.value = audio;
      orbUniforms.uAudioReactivity.value = visuals.audioReactivity;
      orbUniforms.uSwirlAmount.value = visuals.swirlAmount;
      orbUniforms.uSwirlSpeed.value = visuals.swirlSpeed;
      orbUniforms.uTickCount.value = visuals.tickCount;
      orbUniforms.uTickSpeed.value = visuals.tickSpeed;
      orbUniforms.uPulseStrength.value = visuals.pulseStrength;
      orbUniforms.uDimming.value = visuals.dimming;
      orbUniforms.uBreathPhase.value = breath;

      const scalePulse = 1.0 + audio * visuals.pulseStrength * 0.08;
      fieldMesh.scale.setScalar(scalePulse * (1.0 + breath * 0.03));
      orbMesh.scale.setScalar(scalePulse);
      haloUniforms.uIntensity.value = visuals.rimIntensity * (
        1.0 + audio * visuals.audioReactivity * 0.5
      );
      haloUniforms.uDimming.value = visuals.dimming;
      haloMesh.scale.setScalar(HALO_SCALE * scalePulse);
      renderer.render(scene, camera);
    }

    function animate(now: number) {
      animFrameId = requestAnimationFrame(animate);
      applyVisuals(now);
    }

    function handleVisibilityChange() {
      hidden = document.hidden;
      lastTime = performance.now();
      lastRenderTime = 0;
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    resize();
    animFrameId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animFrameId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      resizeObserver.disconnect();
      scene.remove(fieldMesh, orbMesh, haloMesh);
      fieldMaterial.dispose();
      orbMaterial.dispose();
      haloMaterial.dispose();
      fieldGeometry.dispose();
      shellGeometry.dispose();
      renderer.renderLists.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []); // The renderer reads live props from refs and keeps one GPU context.

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: '100%', height: '100%', background: '#000' }}
      data-renderer={webGlFailed ? 'fallback' : 'webgl'}
    >
      {webGlFailed && (
        <div
          className="absolute left-1/2 top-1/2 aspect-square w-[42%] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(26,163,230,0.12) 0%, rgba(5,45,76,0.28) 48%, rgba(26,163,230,0.65) 73%, rgba(26,163,230,0.08) 77%, transparent 80%)',
            boxShadow: '0 0 56px rgba(26,163,230,0.28)',
          }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
