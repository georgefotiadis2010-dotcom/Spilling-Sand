// Multi-Pass WebGL2 2.5D Metaball, Procedural Relief Normal-Mapped PBR & Raymarched GI Renderer

const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  // Flip Y so UV (0,0) matches simulation top-left (0,0)
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

// PASS 1: 2D Raymarched Global Illumination & Volumetric Shadow Field
const GI_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_simTex;
uniform vec2 u_simRes;
uniform float u_time;
uniform int u_lightingPreset; // 0 = Cavern GI, 1 = Golden Sunset, 2 = Studio Daylight
uniform vec2 u_cursorUV;
uniform int u_cursorActive;

// Decode material ID (0..24) and normalized temperature (0..1)
void sampleCell(vec2 uv, out int matId, out float normTemp, out float metaVal) {
  vec4 raw = texture(u_simTex, clamp(uv, vec2(0.001), vec2(0.999)));
  matId = int(floor(raw.r * 255.0 + 0.5));
  normTemp = raw.b;
  metaVal = raw.a * 255.0;
}

vec3 getEmission(int id, float normTemp, float metaVal, vec2 uv) {
  float tempC = normTemp * 1600.0 - 100.0;
  vec3 em = vec3(0.0);

  if (id == 13) { // LAVA
    em = vec3(2.9, 0.85, 0.14);
  } else if (id == 18) { // FIRE
    float life = clamp(metaVal / 90.0, 0.2, 1.0);
    em = vec3(3.1, 1.35, 0.28) * life;
  } else if (id == 14) { // ACID
    em = vec3(0.28, 2.15, 0.65);
  } else if (id == 16) { // FUNGUS (Bioluminescent cyan/violet pulse)
    float pulse = 0.82 + 0.18 * sin(u_time * 2.4 + uv.x * 18.0 + uv.y * 14.0);
    em = mix(vec3(0.18, 1.75, 2.2), vec3(1.15, 0.45, 2.25), fract(metaVal * 0.013)) * pulse;
  } else if (id == 17) { // MITE (Firefly glow)
    em = vec3(2.4, 1.75, 0.45);
  } else if (id == 22) { // LIGHTNING
    em = vec3(4.5, 6.2, 9.0);
  } else if (id == 23) { // CLONER
    em = vec3(2.1, 1.45, 0.35);
  } else if (id == 24) { // VOID accretion rim
    em = vec3(1.4, 0.35, 2.5);
  }

  // Blackbody incandescence for any superheated solid/liquid (> 500°C)
  if (tempC > 480.0 && id != 0) {
    float heat = clamp((tempC - 480.0) / 1100.0, 0.0, 1.5);
    vec3 bb = vec3(1.8 * heat, 0.65 * heat * heat, 0.15 * heat * heat * heat);
    em = max(em, bb);
  }

  return em;
}

float getOpacity(int id) {
  if (id == 0) return 0.02;
  if (id == 1 || id == 2 || id == 3 || id == 6 || id == 23) return 0.36; // Dense solids block light
  if (id == 7 || id == 8 || id == 9 || id == 15 || id == 16) return 0.24; // Powders & foliage
  if (id == 11 || id == 12 || id == 4 || id == 5) return 0.065; // Translucent Water, Oil, Ice, Glass
  if (id == 19 || id == 20 || id == 21) return 0.11; // Volumetric smoke/steam/gas
  return 0.08;
}

// Interleaved gradient noise for jitter-free raymarching
float ign(vec2 p) {
  vec3 magic = vec3(0.06711056, 0.00583715, 52.9829189);
  return fract(magic.z * fract(dot(p, magic.xy)));
}

void main() {
  vec2 texel = 1.0 / u_simRes;
  int centerId;
  float centerTemp, centerMeta;
  sampleCell(v_uv, centerId, centerTemp, centerMeta);

  vec3 totalLight = getEmission(centerId, centerTemp, centerMeta, v_uv) * 0.65;

  // Ambient sky / atmosphere base depending on lighting preset
  vec3 skyTop = vec3(0.07, 0.12, 0.24);
  vec3 skyBot = vec3(0.03, 0.04, 0.08);
  if (u_lightingPreset == 1) { // Golden Sunset
    skyTop = vec3(0.55, 0.32, 0.22);
    skyBot = vec3(0.14, 0.08, 0.12);
  } else if (u_lightingPreset == 2) { // Studio Daylight
    skyTop = vec3(0.62, 0.76, 0.95);
    skyBot = vec3(0.22, 0.28, 0.38);
  }

  // 16-Direction 2D Raymarched Global Illumination
  const int NUM_RAYS = 16;
  const int MAX_STEPS = 18;
  float jitter = ign(gl_FragCoord.xy + fract(u_time) * 100.0);

  for (int r = 0; r < NUM_RAYS; r++) {
    float angle = ( (float(r) + jitter) / float(NUM_RAYS) ) * 6.2831853;
    vec2 dir = vec2(cos(angle), sin(angle));
    vec3 transmittance = vec3(1.0);
    vec2 pos = v_uv;

    // Non-linear step size reaches across the cavern while keeping near shadows sharp
    for (int s = 1; s <= MAX_STEPS; s++) {
      float stepDist = (float(s) * 0.85 + 0.4);
      pos = v_uv + dir * texel * stepDist;

      if (pos.x < 0.0 || pos.x > 1.0 || pos.y < 0.0 || pos.y > 1.0) {
        // Ray escaped into open sky/ceiling
        if (pos.y <= 0.02) {
          totalLight += skyTop * transmittance * 0.7;
        } else {
          totalLight += mix(skyTop, skyBot, clamp(pos.y, 0.0, 1.0)) * transmittance * 0.35;
        }
        break;
      }

      int sid;
      float sTemp, sMeta;
      sampleCell(pos, sid, sTemp, sMeta);

      if (sid != 0) {
        vec3 em = getEmission(sid, sTemp, sMeta, pos);
        if (em.r + em.g + em.b > 0.01) {
          float atten = 1.0 / (1.0 + stepDist * 0.085);
          totalLight += em * transmittance * atten;
        }

        // Translucent spectral tinting through Water, Ice, Glass, Acid
        if (sid == 11 || sid == 4) {
          transmittance *= vec3(0.86, 0.95, 0.99);
        } else if (sid == 14) {
          transmittance *= vec3(0.85, 0.99, 0.88);
        } else {
          float op = getOpacity(sid);
          transmittance *= (1.0 - op);
        }

        if (max(transmittance.r, max(transmittance.g, transmittance.b)) < 0.03) {
          break;
        }
      }
    }
  }

  totalLight /= float(NUM_RAYS) * 0.42;

  // Add subtle base ambient so dark caverns still showcase 2.5D normal-mapped rock relief
  vec3 baseAmb = mix(skyTop, skyBot, v_uv.y) * (u_lightingPreset == 0 ? 0.42 : 0.72);
  totalLight += baseAmb;

  // Interactive cursor torch light
  if (u_cursorActive == 1) {
    vec2 aspect = vec2(u_simRes.x / u_simRes.y, 1.0);
    float d = length((v_uv - u_cursorUV) * aspect);
    float torch = exp(-d * 9.5) * 0.75;
    totalLight += vec3(0.65, 0.85, 1.0) * torch;
  }

  fragColor = vec4(totalLight, 1.0);
}
`;

// PASS 2: Full-Resolution 2.5D Metaball Isosurface, Relief Normal Mapping, PBR, Refraction & Caustics
const COMPOSITE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_simTex;
uniform sampler2D u_giTex;
uniform vec2 u_simRes;
uniform vec2 u_canvasRes;
uniform float u_time;
uniform int u_renderMode;    // 0 = Ultra 100x, 1 = Split Compare, 2 = Thermal Vision, 3 = Classic Pixels
uniform float u_splitX;      // 0..1 split divider X
uniform float u_giIntensity; // User GI & Bloom multiplier
uniform int u_lightingPreset;
uniform int u_enableMetaballs;
uniform int u_enableGI;
uniform int u_enableRefraction;

// High-speed procedural hash & noise functions for high-DPI micro-surface shaders
float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float noise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i + vec2(0.0, 0.0)), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    v += a * noise2D(p);
    p = rot * p * 2.03;
    a *= 0.5;
  }
  return v;
}

// Animated Voronoi Caustics for underwater & glass light patterns
float voronoiCaustics(vec2 p, float t) {
  vec2 n = floor(p);
  vec2 f = fract(p);
  float md = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = vec2(hash21(n + g), hash21(n + g + 17.3));
      o = 0.5 + 0.42 * sin(t + 6.2831 * o);
      vec2 r = g + o - f;
      float d = dot(r, r);
      md = min(md, d);
    }
  }
  return pow(clamp(1.0 - sqrt(md), 0.0, 1.0), 2.4);
}

// Classify element into rendering domain
// 0=Air, 1=Solid Bevel, 2=Granular, 3=Fluid Metaball, 4=Organic, 5=Volumetric
int getDomain(int id) {
  if (id == 0) return 0;
  if (id == 11 || id == 12 || id == 13 || id == 14) return 3; // Fluids
  if (id == 1 || id == 2 || id == 3 || id == 4 || id == 5 || id == 6 || id == 23) return 1; // Beveled Solids
  if (id == 7 || id == 8 || id == 9 || id == 10) return 2; // Granular Powders
  if (id == 15 || id == 16 || id == 17) return 4; // Organics
  return 5; // Volumetric Fire/Smoke/Steam/Gas/Lightning/Void
}

// Classic flat color palette for Split-Screen Comparison / Classic Sandspiel mode
vec3 getClassicColor(int id, float seedVal, float metaVal) {
  float jit = (seedVal - 0.5) * 0.12;
  if (id == 0) return vec3(0.08, 0.09, 0.12);
  if (id == 1) return vec3(0.32, 0.35, 0.42);
  if (id == 2) return vec3(0.52, 0.55, 0.60) + jit;
  if (id == 3) return vec3(0.58, 0.36, 0.19) + jit;
  if (id == 4) return vec3(0.68, 0.89, 1.00) + jit * 0.5;
  if (id == 5) return vec3(0.84, 0.94, 0.99);
  if (id == 6) return vec3(0.96, 0.78, 0.26) + jit * 0.5;
  if (id == 7) return vec3(0.91, 0.73, 0.42) + jit;
  if (id == 8) return vec3(0.93, 0.96, 1.00) + jit * 0.4;
  if (id == 9) return vec3(0.28, 0.29, 0.33) + jit;
  if (id == 10) return vec3(0.64, 0.85, 0.34);
  if (id == 11) return vec3(0.14, 0.60, 0.95) + jit * 0.3;
  if (id == 12) return vec3(0.34, 0.26, 0.21) + jit * 0.3;
  if (id == 13) return vec3(1.00, 0.38, 0.06) + jit;
  if (id == 14) return vec3(0.22, 0.95, 0.46) + jit * 0.4;
  if (id == 15) return metaVal > 90.0 ? vec3(0.96, 0.45, 0.72) : vec3(0.16, 0.70, 0.32) + jit;
  if (id == 16) return vec3(0.22, 0.88, 0.92) + jit;
  if (id == 17) return vec3(1.00, 0.78, 0.36);
  if (id == 18) return vec3(1.00, 0.55, 0.10);
  if (id == 19) return vec3(0.38, 0.41, 0.46);
  if (id == 20) return vec3(0.76, 0.87, 0.96);
  if (id == 21) return vec3(0.75, 0.44, 0.98);
  if (id == 22) return vec3(0.65, 0.92, 1.00);
  if (id == 23) return vec3(0.95, 0.77, 0.28);
  if (id == 24) return vec3(0.12, 0.02, 0.22);
  return vec3(0.5);
}

// Rich atmospheric cave/sky background with parallax rock silhouettes & volumetric mist
vec3 renderBackground(vec2 uv, vec3 giLight) {
  vec2 p = uv * vec2(u_simRes.x / u_simRes.y, 1.0);
  vec3 topCol = vec3(0.035, 0.055, 0.10);
  vec3 botCol = vec3(0.015, 0.02, 0.04);
  if (u_lightingPreset == 1) {
    topCol = vec3(0.18, 0.10, 0.12);
    botCol = vec3(0.05, 0.03, 0.05);
  } else if (u_lightingPreset == 2) {
    topCol = vec3(0.16, 0.24, 0.36);
    botCol = vec3(0.07, 0.10, 0.16);
  }

  vec3 bg = mix(topCol, botCol, uv.y);

  // Subtle distant cavern wall strata relief in background
  float wallNoise = fbm(p * 6.5 + vec2(0.0, 0.4));
  float wallNoise2 = fbm(p * 14.0 - vec2(1.2, 0.7));
  float rockRelief = wallNoise * 0.65 + wallNoise2 * 0.35;
  vec3 bgNormal = normalize(vec3(
    (wallNoise2 - 0.5) * 0.5,
    (wallNoise - 0.5) * 0.5,
    1.0
  ));

  vec3 lightDir = normalize(vec3(-0.35, -0.65, 0.68));
  float ndl = max(0.25, dot(bgNormal, lightDir));
  vec3 distantRock = bg * (0.65 + 0.55 * rockRelief) * ndl;

  // Illuminated by real-time 2D GI bounce light!
  distantRock += distantRock * giLight * 1.45 + giLight * 0.18;
  return distantRock;
}

// Thermal vision color ramp
vec3 thermalPalette(float t) {
  // t in 0..1
  vec3 c0 = vec3(0.04, 0.06, 0.22);
  vec3 c1 = vec3(0.12, 0.45, 0.88);
  vec3 c2 = vec3(0.15, 0.85, 0.55);
  vec3 c3 = vec3(0.98, 0.82, 0.18);
  vec3 c4 = vec3(1.00, 0.22, 0.08);
  vec3 c5 = vec3(1.00, 0.98, 0.95);
  if (t < 0.2) return mix(c0, c1, t / 0.2);
  if (t < 0.4) return mix(c1, c2, (t - 0.2) / 0.2);
  if (t < 0.65) return mix(c2, c3, (t - 0.4) / 0.25);
  if (t < 0.85) return mix(c3, c4, (t - 0.65) / 0.2);
  return mix(c4, c5, clamp((t - 0.85) / 0.15, 0.0, 1.0));
}

void main() {
  vec2 texel = 1.0 / u_simRes;
  vec2 worldP = v_uv * u_simRes;

  // Classic Pixel Mode or Left Half of Split-Screen Compare
  bool isClassicSide = (u_renderMode == 3) || (u_renderMode == 1 && v_uv.x < u_splitX);
  if (isClassicSide) {
    vec4 raw = texture(u_simTex, v_uv);
    int cid = int(floor(raw.r * 255.0 + 0.5));
    vec3 col = getClassicColor(cid, raw.g, raw.a * 255.0);
    fragColor = vec4(col, 1.0);
    return;
  }

  // Thermal Vision Mode
  if (u_renderMode == 2) {
    vec4 raw = texture(u_simTex, v_uv);
    int cid = int(floor(raw.r * 255.0 + 0.5));
    float normT = raw.b;
    vec3 gi = texture(u_giTex, v_uv).rgb;
    vec3 th = thermalPalette(clamp(normT * 1.35, 0.0, 1.0));
    if (cid == 0) th *= 0.45;
    th += length(gi) * 0.08;
    fragColor = vec4(th, 1.0);
    return;
  }

  // Heat-shimmer & Void Gravitational Lensing UV pre-warp
  vec2 sampleUV = v_uv;
  vec4 rawCenter = texture(u_simTex, sampleUV);
  float centerNormTemp = rawCenter.b;
  if (centerNormTemp > 0.15) {
    float shimmer = (centerNormTemp - 0.15) * 0.0022;
    sampleUV.x += sin(u_time * 12.0 + worldP.y * 0.45) * shimmer;
  }

  // Sample Raymarched Global Illumination (bicubic/bilinear smoothed)
  vec3 giLight = (u_enableGI == 1)
    ? texture(u_giTex, sampleUV).rgb * u_giIntensity
    : vec3(0.75, 0.82, 0.92);

  // ---------------------------------------------------------------------------
  // 5x5 Continuous Isosurface & 2.5D Relief Kernel Evaluation
  // ---------------------------------------------------------------------------
  // Bilinear sub-cell offset within current simulation texel
  vec2 cellCoord = sampleUV * u_simRes - 0.5;
  vec2 baseCell = floor(cellCoord);
  vec2 subPos = cellCoord - baseCell; // 0..1 continuous sub-pixel coordinate

  float fluidField = 0.0;
  vec2 fluidGrad = vec2(0.0);
  float wWater = 0.0, wOil = 0.0, wLava = 0.0, wAcid = 0.0;

  float solidField = 0.0;
  vec2 solidGrad = vec2(0.0);

  float volField = 0.0;
  float wFire = 0.0, wSmoke = 0.0, wSteam = 0.0, wGas = 0.0, wLight = 0.0, wVoid = 0.0;

  // Nearest center cell properties
  vec4 centerTex = texture(u_simTex, (floor(sampleUV * u_simRes) + 0.5) * texel);
  int exactId = int(floor(centerTex.r * 255.0 + 0.5));
  float exactSeed = centerTex.g;
  float exactTemp = centerTex.b;
  float exactMeta = centerTex.a * 255.0;

  // Evaluate 4x4 smooth Gaussian/Cubic kernel around sub-pixel position
  for (int ky = -1; ky <= 2; ky++) {
    for (int kx = -1; kx <= 2; kx++) {
      vec2 offset = vec2(float(kx), float(ky)) - subPos;
      float r2 = dot(offset, offset);
      float w = exp(-r2 * 1.15);
      // Analytic spatial derivative of Gaussian kernel: d/dx exp(-k*r^2) = -2*k*offset * w
      vec2 dw = -2.3 * offset * w;

      vec2 tapUV = (baseCell + vec2(float(kx), float(ky)) + 0.5) * texel;
      vec4 tap = texture(u_simTex, clamp(tapUV, vec2(0.001), vec2(0.999)));
      int tid = int(floor(tap.r * 255.0 + 0.5));
      int dom = getDomain(tid);

      if (dom == 3) { // Fluid metaball
        fluidField += w;
        fluidGrad += dw;
        if (tid == 11) wWater += w;
        else if (tid == 12) wOil += w;
        else if (tid == 13) wLava += w;
        else if (tid == 14) wAcid += w;
      } else if (dom == 1 || dom == 2 || dom == 4) { // Solids, Granulars & Organics
        solidField += w;
        solidGrad += dw;
      } else if (dom == 5) { // Volumetrics
        volField += w;
        if (tid == 18) wFire += w;
        else if (tid == 19) wSmoke += w;
        else if (tid == 20) wSteam += w;
        else if (tid == 21) wGas += w;
        else if (tid == 22) wLight += w;
        else if (tid == 24) wVoid += w;
      }
    }
  }

  // Normalize density fields (max theoretical sum of 4x4 Gaussian is ~2.75)
  float normFluid = fluidField / 2.65;
  float normSolid = solidField / 2.65;
  float normVol   = volField / 2.65;

  vec3 bgCol = renderBackground(sampleUV, giLight);
  vec3 finalCol = bgCol;

  vec3 sunDir = normalize(vec3(-0.42, -0.68, 0.60));
  vec3 viewDir = vec3(0.0, 0.0, 1.0);
  vec3 halfVec = normalize(sunDir + viewDir);

  // Determine whether this screen pixel belongs to a Solid/Granular/Organic, a Smooth Metaball Fluid, or Volumetric Cloud
  bool isSolidHere = (getDomain(exactId) == 1 || getDomain(exactId) == 2 || getDomain(exactId) == 4);
  // Smooth beveled corners on solids if metaballs enabled
  if (u_enableMetaballs == 1 && getDomain(exactId) == 1) {
    isSolidHere = normSolid > 0.34;
  }

  bool isFluidHere = (u_enableMetaballs == 1)
    ? (normFluid > 0.34 && !isSolidHere)
    : (getDomain(exactId) == 3);

  // ===========================================================================
  // 1. 2.5D SCULPTED SOLIDS, MICRO-FACET GRANULARS & LIVING ORGANICS
  // ===========================================================================
  if (isSolidHere) {
    int matId = exactId;
    // If smooth bevel pulled in an edge pixel that was empty, borrow nearest solid neighbor ID
    if (matId == 0 || getDomain(matId) == 3 || getDomain(matId) == 5) {
      for (int ny = -1; ny <= 1; ny++) {
        for (int nx = -1; nx <= 1; nx++) {
          vec4 nTap = texture(u_simTex, sampleUV + vec2(float(nx), float(ny)) * texel);
          int nid = int(floor(nTap.r * 255.0 + 0.5));
          if (getDomain(nid) == 1 || getDomain(nid) == 4) {
            matId = nid;
            exactSeed = nTap.g;
            exactTemp = nTap.b;
            exactMeta = nTap.a * 255.0;
          }
        }
      }
    }

    // 2.5D Bas-Relief Normal from macro density gradient + high-frequency procedural micro-normal
    vec2 macroN = (u_enableRefraction == 1) ? -solidGrad * 0.85 : vec2(0.0);
    vec2 microN = vec2(0.0);
    vec3 albedo = vec3(0.5);
    float roughness = 0.6;
    float metallic = 0.0;
    float subsurface = 0.0;
    vec3 selfEmission = vec3(0.0);

    if (matId == 1) { // OBSIDIAN WALL (Chamfered dark armor panels with metallic sheen)
      vec2 gridTile = fract(worldP * 0.25);
      float bevel = smoothstep(0.04, 0.16, min(min(gridTile.x, 1.0 - gridTile.x), min(gridTile.y, 1.0 - gridTile.y)));
      float brushed = noise2D(vec2(worldP.x * 2.5, worldP.y * 0.4));
      albedo = mix(vec3(0.12, 0.15, 0.21), vec3(0.24, 0.28, 0.36), bevel * (0.75 + 0.25 * brushed));
      microN = vec2(dFdx(bevel), dFdy(bevel)) * 4.0;
      roughness = 0.28;
      metallic = 0.72;
    } else if (matId == 2) { // BASALT STONE (Sculpted 3D rock strata & mineral facets)
      float r1 = fbm(worldP * 0.22 + vec2(0.0, worldP.x * 0.06));
      float r2 = fbm(worldP * 0.75);
      float crack = smoothstep(0.47, 0.51, abs(r1 - 0.5));
      albedo = mix(vec3(0.32, 0.35, 0.41), vec3(0.56, 0.60, 0.67), r1 * 0.7 + r2 * 0.3) * (0.65 + 0.35 * crack);
      microN = vec2(r2 - 0.5, r1 - 0.5) * 1.4;
      roughness = 0.68;
    } else if (matId == 3) { // TIMBER WOOD (Procedural wood grain rings & bark fibers)
      float grain = sin(worldP.y * 1.4 + fbm(worldP * vec2(0.15, 0.65)) * 5.5) * 0.5 + 0.5;
      float fiber = noise2D(worldP * vec2(0.35, 2.4));
      albedo = mix(vec3(0.38, 0.20, 0.09), vec3(0.66, 0.41, 0.21), grain * 0.75 + fiber * 0.25);
      microN = vec2((fiber - 0.5) * 0.5, (grain - 0.5) * 1.1);
      roughness = 0.58;
    } else if (matId == 4) { // CRYSTAL ICE (Refractive translucent glacier ice with internal frost cracks)
      float frost = voronoiCaustics(worldP * 0.32, 0.0);
      float crystal = fbm(worldP * 0.6);
      vec2 refractUV = sampleUV + macroN * 0.014 + (crystal - 0.5) * 0.006;
      vec3 behindIce = renderBackground(refractUV, giLight);
      albedo = mix(behindIce * vec3(0.65, 0.90, 1.0), vec3(0.75, 0.94, 1.0), 0.58 + 0.32 * frost);
      microN = vec2(crystal - 0.5, frost - 0.5) * 1.2;
      roughness = 0.14;
      subsurface = 0.65;
    } else if (matId == 5) { // FUSED GLASS (Chromatic optical lens refraction & Fresnel edge sheen)
      float facet = fbm(worldP * 0.4);
      vec2 disp = (macroN * 0.022 + (facet - 0.5) * 0.004) * float(u_enableRefraction);
      vec3 refrCol;
      refrCol.r = renderBackground(sampleUV + disp * 1.15, giLight).r;
      refrCol.g = renderBackground(sampleUV + disp * 1.00, giLight).g;
      refrCol.b = renderBackground(sampleUV + disp * 0.85, giLight).b;
      float edgeFresnel = clamp(length(macroN) * 0.85, 0.08, 0.92);
      albedo = mix(refrCol * vec3(0.88, 0.97, 1.0), vec3(0.92, 0.98, 1.0), edgeFresnel * 0.55);
      microN = vec2(facet - 0.5) * 0.45;
      roughness = 0.06;
      subsurface = 0.8;
    } else if (matId == 6) { // AURUM GOLD METAL (Anisotropic mirror-metallic PBR)
      float sheen = noise2D(worldP * vec2(1.8, 0.35));
      albedo = mix(vec3(0.85, 0.62, 0.16), vec3(1.0, 0.88, 0.44), 0.55 + 0.45 * sheen);
      microN = vec2(0.0, (sheen - 0.5) * 0.6);
      roughness = 0.16;
      metallic = 0.94;
    } else if (matId == 7) { // SILICA SAND (Micro-faceted desert dunes with quartz crystal sparkle)
      float grainNoise = hash21(floor(worldP * 2.5) + exactSeed);
      float duneWave = sin(worldP.x * 0.25 + worldP.y * 0.6 + fbm(worldP * 0.18) * 3.0) * 0.5 + 0.5;
      albedo = mix(vec3(0.78, 0.58, 0.30), vec3(0.96, 0.82, 0.52), grainNoise * 0.65 + duneWave * 0.35);
      // Individual quartz sparkle glints at native screen resolution!
      float sparkle = pow(hash21(floor(gl_FragCoord.xy * 0.5) + floor(exactSeed * 255.0)), 18.0);
      selfEmission += vec3(1.2, 1.05, 0.75) * sparkle * 0.9;
      microN = vec2(grainNoise - 0.5, duneWave - 0.5) * 1.1;
      roughness = 0.52;
    } else if (matId == 8) { // ALPINE SNOW (Fluffy high-albedo subsurface powder with ice glints)
      float fluff = fbm(worldP * 0.9);
      float glint = pow(hash21(floor(gl_FragCoord.xy * 0.6) + exactSeed), 20.0);
      albedo = mix(vec3(0.84, 0.91, 0.98), vec3(0.98, 0.99, 1.0), fluff);
      selfEmission += vec3(0.9, 0.96, 1.0) * glint;
      microN = vec2(fluff - 0.5) * 0.8;
      roughness = 0.45;
      subsurface = 0.5;
    } else if (matId == 9) { // GUNPOWDER
      float grit = hash21(floor(worldP * 2.2) + exactSeed);
      albedo = mix(vec3(0.18, 0.19, 0.22), vec3(0.32, 0.33, 0.38), grit);
      microN = vec2(grit - 0.5) * 1.2;
      roughness = 0.78;
    } else if (matId == 10) { // FLORA SEED
      albedo = vec3(0.65, 0.88, 0.32);
      roughness = 0.35;
      subsurface = 0.4;
    } else if (matId == 15) { // LUSH FOLIAGE PLANT (Subsurface leaf veins & blooming flowers)
      float leaf = fbm(worldP * 0.85 + vec2(sin(u_time * 1.8 + worldP.y * 0.1) * 0.25, 0.0));
      if (exactMeta > 90.0) {
        // Blooming botanical flower bud!
        albedo = mix(vec3(0.95, 0.32, 0.62), vec3(1.0, 0.82, 0.35), leaf);
        selfEmission = vec3(0.35, 0.12, 0.22);
      } else {
        albedo = mix(vec3(0.08, 0.42, 0.18), vec3(0.32, 0.78, 0.36), leaf * 0.7 + exactSeed * 0.3);
      }
      microN = vec2(leaf - 0.5) * 1.15;
      roughness = 0.42;
      subsurface = 0.65;
    } else if (matId == 16) { // BIOLUMINESCENT FUNGUS
      float pulse = 0.8 + 0.2 * sin(u_time * 2.6 + worldP.x * 0.2);
      float myc = fbm(worldP * 0.9);
      albedo = mix(vec3(0.12, 0.78, 0.88), vec3(0.68, 0.32, 0.96), fract(exactSeed * 3.7 + myc * 0.4));
      selfEmission = albedo * 1.35 * pulse;
      microN = vec2(myc - 0.5) * 0.9;
      roughness = 0.35;
      subsurface = 0.85;
    } else if (matId == 17) { // GLOW MITE
      albedo = vec3(1.0, 0.85, 0.35);
      selfEmission = vec3(1.8, 1.3, 0.4);
      roughness = 0.2;
    } else if (matId == 23) { // RUNIC CLONER
      float rune = sin(worldP.x * 1.6 + u_time * 4.0) * cos(worldP.y * 1.6 - u_time * 4.0);
      albedo = mix(vec3(0.88, 0.65, 0.15), vec3(0.25, 0.85, 1.0), smoothstep(0.2, 0.7, rune));
      selfEmission = albedo * 0.85;
      roughness = 0.2;
      metallic = 0.8;
    }

    // Construct 3D Surface Normal & evaluate PBR + GI Lighting
    vec3 N = normalize(vec3(macroN + microN, 1.0));
    float NdotL = max(0.08, dot(N, sunDir));
    float NdotH = max(0.0, dot(N, halfVec));
    float specPower = mix(128.0, 8.0, roughness);
    float spec = pow(NdotH, specPower) * mix(0.25, 1.4, 1.0 - roughness);

    // Edge rim lighting from 2.5D bevel normal
    float rim = pow(1.0 - max(0.0, N.z), 2.2);

    vec3 lit = albedo * (giLight * (0.75 + 0.45 * NdotL + subsurface * 0.35));
    lit += mix(vec3(1.0), albedo, metallic) * spec * (0.45 + length(giLight) * 0.35);
    lit += giLight * rim * 0.35;
    lit += selfEmission;

    // Thermal Blackbody Incandescence on superheated solids (> 450°C)
    float tempC = exactTemp * 1600.0 - 100.0;
    if (tempC > 450.0) {
      float h = clamp((tempC - 450.0) / 1000.0, 0.0, 1.4);
      vec3 heatGlow = vec3(1.6 * h, 0.55 * h * h, 0.12 * h * h * h);
      lit += heatGlow;
    }

    finalCol = lit;
  }

  // ===========================================================================
  // 2. SMOOTH METABALL FLUID ISOSURFACES (WATER, OIL, LAVA, ACID)
  // ===========================================================================
  else if (isFluidHere) {
    float totalW = max(0.0001, wWater + wOil + wLava + wAcid);
    float fWater = wWater / totalW;
    float fOil   = wOil / totalW;
    float fLava  = wLava / totalW;
    float fAcid  = wAcid / totalW;

    // Smooth 2.5D curved liquid surface normal from SDF gradient + capillary ripples
    vec2 wave = vec2(
      sin(worldP.x * 0.45 + u_time * 3.8 + worldP.y * 0.2),
      cos(worldP.y * 0.55 - u_time * 3.1 + worldP.x * 0.25)
    ) * 0.14;
    vec3 fluidN = normalize(vec3(-fluidGrad * 1.15 + wave, 1.0));

    // Meniscus & surface tension boundary thickness (near isosurface threshold 0.34..0.50)
    float edgeBand = 1.0 - smoothstep(0.34, 0.54, normFluid);
    float fresnel = pow(1.0 - max(0.0, fluidN.z), 2.6);

    // Animated Voronoi Caustics
    float caustics = voronoiCaustics(worldP * 0.24 + fluidN.xy * 0.6, u_time * 2.2);

    // Refracted background behind translucent fluids
    vec2 refrUV = sampleUV + fluidN.xy * 0.018 * float(u_enableRefraction);
    vec3 refrBg = renderBackground(refrUV, giLight);

    // WATER SHADER
    vec3 waterAbsorb = refrBg * vec3(0.32, 0.76, 0.96);
    vec3 waterBody = mix(waterAbsorb, vec3(0.06, 0.48, 0.84) * (giLight + 0.25), 0.52);
    waterBody += vec3(0.25, 0.78, 1.0) * caustics * (0.28 + length(giLight) * 0.25);
    // Meniscus foam & splash crest
    float foamNoise = fbm(worldP * 0.9 + vec2(u_time * 1.5, 0.0));
    float foam = smoothstep(0.35, 0.85, edgeBand * (0.65 + 0.55 * foamNoise));
    waterBody = mix(waterBody, vec3(0.88, 0.96, 1.0) * max(vec3(0.7), giLight), foam * 0.72);

    // OIL SHADER (Dark hydrocarbon with thin-film rainbow iridescence)
    float iridPhase = dot(fluidN.xy, vec2(4.5, 3.5)) + fbm(worldP * 0.4 + u_time * 0.4) * 5.0;
    vec3 rainbow = 0.5 + 0.5 * cos(iridPhase + vec3(0.0, 2.1, 4.2));
    vec3 oilBody = mix(vec3(0.10, 0.08, 0.07) * (giLight + 0.3), rainbow * 0.55, 0.32 + edgeBand * 0.35);

    // LAVA SHADER (Incandescent molten magma core with floating dark cooled basalt crust cracks)
    float magmaCells = voronoiCaustics(worldP * 0.28 + vec2(0.0, u_time * 0.45), u_time * 1.4);
    float magmaFbm = fbm(worldP * 0.45 - vec2(u_time * 0.3, u_time * 0.5));
    float heatCore = clamp(magmaCells * 0.65 + magmaFbm * 0.55 + edgeBand * 0.3, 0.0, 1.2);
    vec3 lavaCrust = vec3(0.18, 0.05, 0.02);
    vec3 lavaOrange = vec3(1.35, 0.38, 0.04);
    vec3 lavaYellow = vec3(2.2, 1.65, 0.45);
    vec3 lavaBody = mix(lavaCrust, lavaOrange, smoothstep(0.18, 0.58, heatCore));
    lavaBody = mix(lavaBody, lavaYellow, smoothstep(0.62, 0.98, heatCore));

    // ACID SHADER (Bioluminescent emerald solvent with glowing caustic core)
    vec3 acidBody = mix(refrBg * vec3(0.25, 0.95, 0.45), vec3(0.15, 0.92, 0.38), 0.68);
    acidBody += vec3(0.45, 1.2, 0.55) * (caustics * 0.45 + edgeBand * 0.5);

    // Blend smoothly across multi-fluid phase boundaries (e.g. Oil floating on Water!)
    vec3 fluidCol = waterBody * fWater + oilBody * fOil + lavaBody * fLava + acidBody * fAcid;

    // Specular GGX reflection on liquid surface
    float spec = pow(max(0.0, dot(fluidN, halfVec)), 96.0);
    fluidCol += vec3(0.95, 0.98, 1.0) * (spec * 0.85 + fresnel * 0.32) * (1.0 - fLava * 0.6);

    // Smooth anti-aliased blend at the outer metaball meniscus
    float alpha = smoothstep(0.32, 0.41, normFluid);
    finalCol = mix(bgCol, fluidCol, alpha);
  }

  // ===========================================================================
  // 3. VOLUMETRIC BILLOWING FLAMES, AEROSOL CLOUDS, LIGHTNING & SINGULARITY
  // ===========================================================================
  if (normVol > 0.06 || getDomain(exactId) == 5) {
    float vTot = max(0.0001, wFire + wSmoke + wSteam + wGas + wLight + wVoid);
    float turb = fbm(worldP * 0.55 - vec2(0.0, u_time * 3.8));

    if (wFire > 0.01) {
      float flameDensity = clamp((wFire / 1.8) * (0.65 + 0.65 * turb), 0.0, 1.2);
      vec3 flameCol = mix(
        vec3(1.1, 0.18, 0.02),
         mix(vec3(1.8, 0.72, 0.08), vec3(2.4, 2.2, 1.5), smoothstep(0.45, 0.95, flameDensity)),
        smoothstep(0.15, 0.7, flameDensity)
      );
      finalCol = mix(finalCol, flameCol, clamp(flameDensity * 0.92, 0.0, 1.0));
    }

    if (wSmoke + wSteam + wGas > 0.01) {
      float cloud = fbm(worldP * 0.35 + vec2(u_time * 0.6, -u_time * 0.9));
      float dens = clamp(((wSmoke + wSteam + wGas) / 2.2) * (0.6 + 0.55 * cloud), 0.0, 0.88);
      vec3 smokeAlb = vec3(0.26, 0.29, 0.35) * (giLight + 0.25);
      vec3 steamAlb = vec3(0.78, 0.88, 0.98) * (giLight + 0.45);
      vec3 gasAlb   = vec3(0.68, 0.32, 0.96) * (giLight + 0.45);
      float cSum = max(0.0001, wSmoke + wSteam + wGas);
      vec3 cloudCol = (smokeAlb * wSmoke + steamAlb * wSteam + gasAlb * wGas) / cSum;
      finalCol = mix(finalCol, cloudCol, dens);
    }

    if (wLight > 0.01) {
      finalCol += vec3(1.4, 2.2, 3.2) * clamp(wLight, 0.0, 1.5);
    }

    if (wVoid > 0.01 || exactId == 24) {
      float ring = smoothstep(0.2, 0.55, wVoid) * (1.0 - smoothstep(0.55, 0.95, wVoid));
      finalCol = mix(finalCol, vec3(0.0), clamp(wVoid * 1.4, 0.0, 1.0));
      finalCol += vec3(1.3, 0.35, 2.4) * ring * 2.5;
    }
  }

  // ACES Filmic Tone Mapping & Subtle Cinematic Vignette
  vec3 x = max(vec3(0.0), finalCol);
  vec3 mapped = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  mapped = pow(clamp(mapped, 0.0, 1.0), vec3(0.94));

  float vig = 1.0 - dot((v_uv - 0.5) * 0.85, (v_uv - 0.5) * 0.85);
  mapped *= clamp(vig, 0.72, 1.0);

  fragColor = vec4(mapped, 1.0);
}
`;

export class WebGLRenderer {
  constructor(canvas, sim) {
    this.canvas = canvas;
    this.sim = sim;
    this.gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });

    if (!this.gl) {
      throw new Error("WebGL2 is required for the 100x Ultra Shader Engine.");
    }

    this.renderMode = 0; // 0=ultra, 1=split, 2=thermal, 3=classic
    this.splitX = 0.5;
    this.giIntensity = 1.25;
    this.lightingPreset = 0;
    this.enableMetaballs = 1;
    this.enableGI = 1;
    this.enableRefraction = 1;

    this.cursorUV = [0.5, 0.5];
    this.cursorActive = 0;
    this.startTime = performance.now();

    this.initGL();
  }

  compileShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error("Shader compilation error: " + info);
    }
    return shader;
  }

  createProgram(vsSource, fsSource) {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(prog);
      throw new Error("Shader link error: " + info);
    }
    return prog;
  }

  initGL() {
    const gl = this.gl;

    this.giProgram = this.createProgram(VERTEX_SHADER, GI_FRAGMENT_SHADER);
    this.compProgram = this.createProgram(VERTEX_SHADER, COMPOSITE_FRAGMENT_SHADER);

    // Fullscreen triangle-strip quad
    const quadVerts = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Simulation state texture (RGBA8, NEAREST filtering so shader kernel can do exact texel lookups)
    this.simTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.simTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      this.sim.width,
      this.sim.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.sim.gpuData
    );

    // Raymarched Global Illumination FBO & Texture (LINEAR filtering for buttery smooth light interpolation)
    this.giTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.giTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      this.sim.width,
      this.sim.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null
    );

    this.giFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.giFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.giTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Cache uniform locations
    this.giUniforms = {
      u_simTex: gl.getUniformLocation(this.giProgram, "u_simTex"),
      u_simRes: gl.getUniformLocation(this.giProgram, "u_simRes"),
      u_time: gl.getUniformLocation(this.giProgram, "u_time"),
      u_lightingPreset: gl.getUniformLocation(this.giProgram, "u_lightingPreset"),
      u_cursorUV: gl.getUniformLocation(this.giProgram, "u_cursorUV"),
      u_cursorActive: gl.getUniformLocation(this.giProgram, "u_cursorActive"),
    };

    this.compUniforms = {
      u_simTex: gl.getUniformLocation(this.compProgram, "u_simTex"),
      u_giTex: gl.getUniformLocation(this.compProgram, "u_giTex"),
      u_simRes: gl.getUniformLocation(this.compProgram, "u_simRes"),
      u_canvasRes: gl.getUniformLocation(this.compProgram, "u_canvasRes"),
      u_time: gl.getUniformLocation(this.compProgram, "u_time"),
      u_renderMode: gl.getUniformLocation(this.compProgram, "u_renderMode"),
      u_splitX: gl.getUniformLocation(this.compProgram, "u_splitX"),
      u_giIntensity: gl.getUniformLocation(this.compProgram, "u_giIntensity"),
      u_lightingPreset: gl.getUniformLocation(this.compProgram, "u_lightingPreset"),
      u_enableMetaballs: gl.getUniformLocation(this.compProgram, "u_enableMetaballs"),
      u_enableGI: gl.getUniformLocation(this.compProgram, "u_enableGI"),
      u_enableRefraction: gl.getUniformLocation(this.compProgram, "u_enableRefraction"),
    };
  }

  resize(width, height) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.max(1, Math.floor(width * dpr));
    const targetH = Math.max(1, Math.floor(height * dpr));
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
  }

  render() {
    const gl = this.gl;
    const t = (performance.now() - this.startTime) * 0.001;

    gl.bindVertexArray(this.vao);

    // Upload current simulation state to GPU texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.simTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      this.sim.width,
      this.sim.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.sim.gpuData
    );

    // PASS 1: Render 2D Raymarched Global Illumination & Shadow Field
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.giFbo);
    gl.viewport(0, 0, this.sim.width, this.sim.height);
    gl.useProgram(this.giProgram);
    gl.uniform1i(this.giUniforms.u_simTex, 0);
    gl.uniform2f(this.giUniforms.u_simRes, this.sim.width, this.sim.height);
    gl.uniform1f(this.giUniforms.u_time, t);
    gl.uniform1i(this.giUniforms.u_lightingPreset, this.lightingPreset);
    gl.uniform2f(this.giUniforms.u_cursorUV, this.cursorUV[0], this.cursorUV[1]);
    gl.uniform1i(this.giUniforms.u_cursorActive, this.cursorActive);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // PASS 2: Full-Resolution 2.5D Metaball + PBR + Refraction + Caustics Composite
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.compProgram);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.giTex);

    gl.uniform1i(this.compUniforms.u_simTex, 0);
    gl.uniform1i(this.compUniforms.u_giTex, 1);
    gl.uniform2f(this.compUniforms.u_simRes, this.sim.width, this.sim.height);
    gl.uniform2f(this.compUniforms.u_canvasRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.compUniforms.u_time, t);
    gl.uniform1i(this.compUniforms.u_renderMode, this.renderMode);
    gl.uniform1f(this.compUniforms.u_splitX, this.splitX);
    gl.uniform1f(this.compUniforms.u_giIntensity, this.giIntensity);
    gl.uniform1i(this.compUniforms.u_lightingPreset, this.lightingPreset);
    gl.uniform1i(this.compUniforms.u_enableMetaballs, this.enableMetaballs);
    gl.uniform1i(this.compUniforms.u_enableGI, this.enableGI);
    gl.uniform1i(this.compUniforms.u_enableRefraction, this.enableRefraction);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
