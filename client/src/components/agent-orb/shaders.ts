/**
 * GLSL shaders for the AgentOrb volumetric glow effect.
 * Designed for software-rendering compatibility (SwiftShader):
 * no dependent texture lookups, bounded ALU, no loops.
 *
 * CTA blue: hsl(200, 80%, 50%) ≈ rgb(0.10, 0.64, 0.90)
 */

// ── Main orb sphere ─────────────────────────────────────────────

export const orbVertexShader = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec3 vWorldPos;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vNormal = normalize(normalMatrix * normal);
    vViewDir = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

export const orbFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uRimPower;
  uniform float uRimIntensity;
  uniform float uCoreGlow;
  uniform float uAudioLevel;
  uniform float uAudioReactivity;
  uniform float uSwirlAmount;
  uniform float uSwirlSpeed;
  uniform float uTickCount;
  uniform float uTickSpeed;
  uniform float uBreathPhase;
  uniform float uPulseStrength;
  uniform float uDimming;

  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec3 vWorldPos;

  const vec3 CTA_BLUE = vec3(0.10, 0.64, 0.90);
  const float TAU = 6.28318530718;

  void main() {
    vec3 normal = normalize(vNormal);
    vec3 viewDir = normalize(vViewDir);

    float facing = abs(dot(normal, viewDir));
    float fresnel = 1.0 - facing;

    // ── Swirl distortion (thinking state) ───────────────────────
    float swirlAngle = atan(vWorldPos.y, vWorldPos.x);
    float swirlOffset = sin(swirlAngle * 3.0 + uTime * uSwirlSpeed) * uSwirlAmount;
    fresnel = clamp(fresnel + swirlOffset * (1.0 - facing), 0.0, 1.0);

    // ── Rim glow ────────────────────────────────────────────────
    float rim = pow(fresnel, uRimPower);

    // ── Orbital ticks (tool_call state) ─────────────────────────
    float tickMask = 1.0;
    if (uTickCount > 0.5) {
      float angle = atan(vWorldPos.y, vWorldPos.x);
      float segment = fract((angle / TAU) * uTickCount + uTime * uTickSpeed);
      // Each tick occupies ~60% of its segment, gap is ~40%
      tickMask = smoothstep(0.38, 0.42, segment) * (1.0 - smoothstep(0.95, 1.0, segment));
      // Blend with base rim so the orb isn't invisible between ticks
      tickMask = mix(0.2, 1.0, tickMask);
    }

    // ── Audio reactivity ────────────────────────────────────────
    float audioBoost = uAudioLevel * uAudioReactivity;
    float audioRim = rim * (1.0 + audioBoost * 1.5);
    float audioPulse = audioBoost * uPulseStrength * 0.4;

    // ── Breathing modulation ────────────────────────────────────
    float breath = 1.0 + uBreathPhase;

    // ── Composite intensity ─────────────────────────────────────
    float intensity = (audioRim * tickMask + audioPulse) * uRimIntensity * breath * uDimming;

    // ── Core fill (subtle inner glow) ───────────────────────────
    float core = facing * uCoreGlow * uDimming;

    // ── Final color ─────────────────────────────────────────────
    vec3 color = CTA_BLUE * (intensity + core);
    float alpha = clamp(intensity + core, 0.0, 1.0);

    gl_FragColor = vec4(color, alpha);
  }
`;

// ── Outer halo sphere ─────────────────────────────────────────

export const haloVertexShader = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewDir;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vViewDir = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

export const haloFragmentShader = /* glsl */ `
  uniform float uIntensity;
  uniform float uDimming;

  varying vec3 vNormal;
  varying vec3 vViewDir;

  const vec3 CTA_BLUE = vec3(0.10, 0.64, 0.90);

  void main() {
    float facing = abs(dot(normalize(vNormal), normalize(vViewDir)));
    float fresnel = 1.0 - facing;
    float glow = pow(fresnel, 1.5) * 0.25 * uIntensity * uDimming;

    gl_FragColor = vec4(CTA_BLUE * glow, glow);
  }
`;
