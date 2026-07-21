/**
 * Bounded shaders for the shared Agent Field.
 * The field pass raymarches a low-step analytic density volume. It avoids
 * textures, dynamic loop bounds, and unbounded particle work for SwiftShader.
 */

export const fieldVertexShader = /* glsl */ `
  varying vec3 vObjectPosition;

  void main() {
    vObjectPosition = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const fieldFragmentShader = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform float uAudioLevel;
  uniform float uDimming;
  uniform float uFieldEnergy;
  uniform float uFilamentDensity;
  uniform float uCloudDensity;
  uniform float uFlowSpeed;
  uniform float uFlowStrength;
  uniform float uCoherence;
  uniform float uAttractorStrength;
  uniform float uKnotStrength;
  uniform float uOrbitPrecision;
  uniform float uWaveEnergy;
  uniform float uCoreDarkness;
  uniform float uQualitySteps;

  varying vec3 vObjectPosition;

  const vec3 CTA_BLUE = vec3(0.10, 0.64, 0.90);
  const vec3 DEEP_BLUE = vec3(0.015, 0.18, 0.34);
  const float MAX_STEPS = 22.0;

  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float valueNoise(vec3 p) {
    vec3 cell = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash31(cell);
    float n100 = hash31(cell + vec3(1.0, 0.0, 0.0));
    float n010 = hash31(cell + vec3(0.0, 1.0, 0.0));
    float n110 = hash31(cell + vec3(1.0, 1.0, 0.0));
    float n001 = hash31(cell + vec3(0.0, 0.0, 1.0));
    float n101 = hash31(cell + vec3(1.0, 0.0, 1.0));
    float n011 = hash31(cell + vec3(0.0, 1.0, 1.0));
    float n111 = hash31(cell + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
      f.z
    );
  }

  // Each component omits its matching coordinate, so divergence is exactly zero.
  vec3 divergenceFreeFlow(vec3 p, float phase) {
    return vec3(
      sin(p.y * 2.7 + phase) + cos(p.z * 3.1 - phase * 0.7),
      sin(p.z * 2.9 - phase * 0.8) + cos(p.x * 2.5 + phase * 0.6),
      sin(p.x * 3.3 + phase * 0.65) + cos(p.y * 2.3 - phase)
    ) * 0.5;
  }

  float ringDistance(vec3 p, vec3 axis, float radius) {
    vec3 a = normalize(axis);
    float axial = dot(p, a);
    float radial = length(p - a * axial);
    return length(vec2(radial - radius, axial));
  }

  float linkedCurrents(vec3 p, float phase) {
    float fold = uKnotStrength * 0.28;
    p += fold * vec3(
      sin(p.z * 4.0 + phase),
      sin(p.x * 4.3 - phase * 0.8),
      sin(p.y * 3.7 + phase * 0.65)
    );

    float d1 = ringDistance(p, vec3(0.44, 1.0, 0.18), 0.56);
    float d2 = ringDistance(p + vec3(0.08, -0.03, 0.02), vec3(1.0, -0.28, 0.48), 0.53);
    float d3 = ringDistance(p - vec3(0.04, 0.06, 0.01), vec3(-0.34, 0.46, 1.0), 0.48);

    float width = mix(0.13, 0.075, uCoherence);
    float currents = exp(-min(d1, min(d2, d3)) * min(d1, min(d2, d3)) / (width * width));

    float preciseOrbit = exp(-d2 * d2 / 0.0048) * uOrbitPrecision;
    return max(currents, preciseOrbit);
  }

  vec2 fieldDensity(vec3 p) {
    // Internal audio reactivity gate. uWaveEnergy keeps this near zero unless the
    // state opts in (speaking fully, listening subtly). Damping already happened
    // on effectiveAudioLevel upstream, so this stays smooth and never strobes.
    float audio = uAudioLevel * uWaveEnergy;

    // Audio accelerates and agitates the internal currents so the speaking field
    // visibly moves with the voice rather than only changing color and size.
    float phase = uTime * uFlowSpeed * (1.0 + audio * 1.6);
    vec3 flow = divergenceFreeFlow(p, phase);
    vec3 advected = p + flow * uFlowStrength * (1.0 + audio * 0.9);

    // Radial gather toward the core. As uAttractorStrength rises (thinking), the
    // field is sampled from farther out, so filaments migrate inward and the
    // whole field visibly draws together instead of dispersing.
    float sampleRadius = length(advected);
    vec3 gathered = advected * (1.0 + uAttractorStrength * 0.9 * smoothstep(0.05, 1.0, sampleRadius));

    float filaments = linkedCurrents(gathered, phase);
    float cloudA = valueNoise(gathered * 2.35 + vec3(phase * 0.7, -phase * 0.4, phase * 0.25));
    float cloudB = valueNoise(gathered * 4.7 - vec3(phase * 0.2, phase * 0.35, -phase * 0.3));
    float cloud = smoothstep(0.4, 0.7, cloudA * 0.72 + cloudB * 0.28);

    float radius = length(p);
    float wave = sin(radius * 24.0 - uTime * (4.5 + audio * 4.0));
    float damping = exp(-radius * 1.65);
    float pressure = smoothstep(0.28, 0.88, wave * 0.5 + 0.5) * damping * audio;

    float coreLight = 0.22 + 0.78 * smoothstep(0.08, 0.42, radius);
    float coreMask = mix(1.0, coreLight, uCoreDarkness);
    float edgeMask = smoothstep(1.0, 0.72, radius);

    // Concentration brightens the gathered core so thinking convergence reads clearly.
    float concentration = 1.0 + uAttractorStrength * 1.7 * exp(-radius * radius * 3.2);
    // Audio pulses the whole internal field so speaking internals breathe with the voice.
    float audioPulse = 1.0 + audio * 1.15;

    float density = (
      filaments * uFilamentDensity * 2.25
      + cloud * uCloudDensity * 1.05
      + pressure * 1.15
    ) * coreMask * edgeMask * uFieldEnergy * uDimming * concentration * audioPulse;

    return vec2(density, filaments + pressure);
  }

  void main() {
    vec3 ro = vec3(0.0, 0.0, 3.1);
    vec3 rd = normalize(vObjectPosition - ro);
    float b = dot(ro, rd);
    float c = dot(ro, ro) - 0.96;
    float h = b * b - c;
    if (h < 0.0) discard;

    h = sqrt(h);
    float nearT = -b - h;
    float farT = -b + h;
    float stepSize = (farT - nearT) / uQualitySteps;
    float jitter = hash31(vec3(gl_FragCoord.xy, floor(uTime * 12.0))) - 0.5;
    float travel = nearT + stepSize * (0.5 + jitter * 0.28);

    vec3 accumulated = vec3(0.0);
    float transmittance = 1.0;
    for (float i = 0.0; i < MAX_STEPS; i += 1.0) {
      if (i >= uQualitySteps) break;
      vec3 p = ro + rd * travel;
      vec2 sampleField = fieldDensity(p);
      float density = clamp(sampleField.x * stepSize * 5.2, 0.0, 0.78);
      vec3 sampleColor = mix(DEEP_BLUE, CTA_BLUE, clamp(sampleField.y * 0.78, 0.0, 1.0));
      accumulated += transmittance * density * sampleColor;
      transmittance *= 1.0 - density;
      if (transmittance < 0.06) break;
      travel += stepSize;
    }

    float alpha = clamp(1.0 - transmittance, 0.0, 0.82);
    gl_FragColor = vec4(accumulated * 1.85, alpha);
  }
`;

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

    float swirlAngle = atan(vWorldPos.y, vWorldPos.x);
    float swirlOffset = sin(swirlAngle * 3.0 + uTime * uSwirlSpeed) * uSwirlAmount;
    fresnel = clamp(fresnel + swirlOffset * (1.0 - facing), 0.0, 1.0);
    float rim = pow(fresnel, uRimPower);

    float tickMask = 1.0;
    if (uTickCount > 0.5) {
      float angle = atan(vWorldPos.y, vWorldPos.x);
      float segment = fract((angle / TAU) * uTickCount + uTime * uTickSpeed);
      tickMask = smoothstep(0.38, 0.42, segment) * (1.0 - smoothstep(0.95, 1.0, segment));
      tickMask = mix(0.2, 1.0, tickMask);
    }

    float audioBoost = uAudioLevel * uAudioReactivity;
    float audioRim = rim * (1.0 + audioBoost * 1.5);
    float audioPulse = audioBoost * uPulseStrength * 0.4;
    float intensity = (audioRim * tickMask + audioPulse) * uRimIntensity * (1.0 + uBreathPhase) * uDimming;
    float core = facing * uCoreGlow * uDimming;
    vec3 color = CTA_BLUE * (intensity + core);
    gl_FragColor = vec4(color, clamp(intensity + core, 0.0, 1.0));
  }
`;

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
    float glow = pow(1.0 - facing, 1.5) * 0.25 * uIntensity * uDimming;
    gl_FragColor = vec4(CTA_BLUE * glow, glow);
  }
`;
