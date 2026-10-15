import * as THREE from 'three';
import { CLASSIC_RAMP, setToonRamp, type ToonRamp } from './toon';

/**
 * Render styles to compare looks in one build: the light ramp every toon surface shades by, the
 * lights, and an optional screen pass that inks outlines and dithers colour. `?style=<name>` picks
 * one at load, and V (or the button) cycles them while playing.
 */
export const STYLES = ['classic', 'ink', 'bold', 'dither', 'retro'] as const;
export type StyleName = (typeof STYLES)[number];

interface Look {
  label: string;
  ramp: ToonRamp;
  /** Multipliers on the sky light (fills the shadow side) and the sun. */
  sky: number;
  sun: number;
  /** No screen pass at all: drawn straight to the canvas, as the game always was. */
  direct?: boolean;
  /** Outline width in CSS pixels, 0 for none; how dark; and how much the line takes the colour under it. */
  outline: number;
  ink: number;
  inkTint: number;
  /** Lines where the colour jumps (band edges, markings), as a share of a silhouette's strength. */
  creases: number;
  saturation: number;
  /**
   * Brightness levels after an ordered dither, 0 to keep smooth shading. Brightness only: each pixel
   * keeps its hue, so the brown ground doesn't turn red the way a per-channel palette would.
   */
  levels: number;
  /** Size of a screen pixel in CSS pixels, for a chunky low-resolution look. */
  pixel: number;
}

const LOOKS: Record<StyleName, Look> = {
  classic: { label: 'Classic', ramp: CLASSIC_RAMP, sky: 1, sun: 1, direct: true, outline: 0, ink: 0, inkTint: 0, creases: 0, saturation: 1, levels: 0, pixel: 1 },
  // The current bands, inked: dark lines round every silhouette and faint ones at colour edges.
  ink: { label: 'Ink lines', ramp: CLASSIC_RAMP, sky: 1, sun: 1, outline: 1.5, ink: 0.85, inkTint: 0.6, creases: 0.2, saturation: 1.05, levels: 0, pixel: 1 },
  // Two hard bands with deep shadow, punchier colour and thick black lines: comic-book cel shading.
  bold: {
    label: 'Bold cel',
    ramp: { bands: [{ level: 0.22, from: 0 }, { level: 1, from: 0.6 }], dither: 0, cell: 1 },
    sky: 0.8, sun: 1.1, outline: 2, ink: 1, inkTint: 0.3, creases: 0.35, saturation: 1.3, levels: 0, pixel: 1,
  },
  // Band edges stippled by a dither pattern, and colour reduced to a few levels per channel by an
  // ordered dither, at full resolution.
  dither: {
    label: 'Dither',
    ramp: { ...CLASSIC_RAMP, dither: 0.3, cell: 2 },
    sky: 1, sun: 1, outline: 1, ink: 0.8, inkTint: 0.5, creases: 0.2, saturation: 1.1, levels: 8, pixel: 1,
  },
  // The dither in big screen pixels and fewer colours: an old-console look.
  retro: {
    label: 'Retro pixels',
    ramp: { bands: [{ level: 0.3, from: 0 }, { level: 0.65, from: 0.4 }, { level: 1, from: 0.62 }], dither: 0.35, cell: 2 },
    sky: 0.9, sun: 1.05, outline: 1, ink: 0.9, inkTint: 0.4, creases: 0, saturation: 1.2, levels: 6, pixel: 2,
  },
};

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAGMENT = /* glsl */ `
#include <packing>
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 resolution;
uniform float cameraNear, cameraFar, fogNear, fogFar;
uniform float outline, ink, inkTint, creases, saturation, levels, pixel;
varying vec2 vUv;

float viewDepth(vec2 uv) {
  return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar);
}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 colourAt(vec2 uv) { return texture2D(tColor, uv).rgb; }

void main() {
  // Big screen pixels: everything is read at the centre of the block this pixel falls in.
  vec2 block = floor(gl_FragCoord.xy / pixel);
  vec2 uv = (block + 0.5) * pixel / resolution;
  vec3 c = colourAt(uv);

  if (outline > 0.0) {
    vec2 o = vec2(outline) / resolution;
    float d = viewDepth(uv);
    // Inverse depth is linear across any flat surface on screen, so its Laplacian is ~0 on the ground
    // however steeply it is seen, and sharply negative on the near side of a silhouette.
    float inv = 1.0 / d;
    float lap = 1.0 / viewDepth(uv + vec2(o.x, 0.0)) + 1.0 / viewDepth(uv - vec2(o.x, 0.0))
      + 1.0 / viewDepth(uv + vec2(0.0, o.y)) + 1.0 / viewDepth(uv - vec2(0.0, o.y)) - 4.0 * inv;
    float edge = smoothstep(0.025, 0.09, -lap / inv);
    if (creases > 0.0) {
      float gx = luma(colourAt(uv + vec2(o.x, 0.0))) - luma(colourAt(uv - vec2(o.x, 0.0)));
      float gy = luma(colourAt(uv + vec2(0.0, o.y))) - luma(colourAt(uv - vec2(0.0, o.y)));
      edge = max(edge, creases * smoothstep(0.12, 0.3, length(vec2(gx, gy))));
    }
    // Lines are for what's near: past a metre or so they thin out, or the grass beyond turns to scribble.
    edge *= 1.0 - smoothstep(min(fogNear, 0.8), min(fogFar, 3.5), d);
    vec3 line = mix(vec3(0.07, 0.06, 0.05), c * 0.3, inkTint);
    c = mix(c, line, edge * ink);
  }

  c = mix(vec3(luma(c)), c, saturation);

  // The sky stays flat: a dither over it reads as noise, not shading.
  if (levels > 0.0 && texture2D(tDepth, uv).x < 1.0) {
    ivec2 cell = ivec2(mod(block, 4.0));
    int bayer[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
    float t = (float(bayer[cell.x + cell.y * 4]) + 0.5) / 16.0;
    float l = max(luma(c), 1e-3);
    c *= floor(l * (levels - 1.0) + t) / (levels - 1.0) / l;
  }
  gl_FragColor = vec4(c, 1.0);
}`;

/**
 * Draws the island in the chosen style. Classic draws straight to the canvas. The others draw the
 * scene into an offscreen target (colour and depth, multisampled like the canvas) and then one
 * full-screen pass over it, so a style costs one extra draw call and a pass over every pixel.
 */
export class StyleRenderer {
  style: StyleName;
  private target: THREE.WebGLRenderTarget;
  private pass: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private quadCamera = new THREE.Camera();
  private size = new THREE.Vector2();
  private base: { sky: number; sun: number };
  private translucent: THREE.Material[] = [];

  constructor(
    private renderer: THREE.WebGLRenderer,
    private sky: THREE.HemisphereLight,
    private sun: THREE.DirectionalLight,
    style: StyleName = 'classic',
  ) {
    this.base = { sky: sky.intensity, sun: sun.intensity };
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.SRGBColorSpace,
      samples: 4,
      depthTexture: new THREE.DepthTexture(1, 1),
    });
    // Have every material write sRGB into the target, as it would to the canvas, rather than linear
    // light. three.js does that only for the canvas and XR targets, hence the flag. Otherwise the
    // translucent sea blends in linear light, washing out the reef under it compared with classic.
    (this.target as { isXRRenderTarget?: boolean }).isXRRenderTarget = true;
    this.pass = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        tColor: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        resolution: { value: new THREE.Vector2() },
        cameraNear: { value: 0 },
        cameraFar: { value: 0 },
        fogNear: { value: 0 },
        fogFar: { value: 0 },
        outline: { value: 0 },
        ink: { value: 0 },
        inkTint: { value: 0 },
        creases: { value: 0 },
        saturation: { value: 1 },
        levels: { value: 0 },
        pixel: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.pass);
    this.quad.frustumCulled = false;
    // Two renders make up a frame here, so the counts are reset once per frame, not per render.
    renderer.info.autoReset = false;
    this.style = style;
    this.set(style);
  }

  get label() {
    return LOOKS[this.style].label;
  }

  set(style: StyleName) {
    this.style = style;
    const look = LOOKS[style];
    setToonRamp(look.ramp);
    this.sky.intensity = this.base.sky * look.sky;
    this.sun.intensity = this.base.sun * look.sun;
    for (const m of this.translucent) m.depthWrite = !look.direct;
  }

  /**
   * A see-through surface (the sea) that writes depth in the styles with outlines, so what lies
   * under it isn't outlined through it. Classic leaves it as it was, not writing depth.
   */
  addTranslucent(material: THREE.Material) {
    this.translucent.push(material);
    material.depthWrite = !LOOKS[this.style].direct;
  }

  next() {
    this.set(STYLES[(STYLES.indexOf(this.style) + 1) % STYLES.length]);
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    const r = this.renderer;
    r.info.reset();
    const look = LOOKS[this.style];
    if (look.direct) {
      r.render(scene, camera);
      return;
    }
    r.getDrawingBufferSize(this.size);
    if (this.target.width !== this.size.x || this.target.height !== this.size.y) this.target.setSize(this.size.x, this.size.y);
    r.setRenderTarget(this.target);
    r.render(scene, camera);
    r.setRenderTarget(null);
    const u = this.pass.uniforms;
    const dpr = r.getPixelRatio();
    const fog = scene.fog as THREE.Fog;
    u.resolution.value.copy(this.size);
    u.cameraNear.value = camera.near;
    u.cameraFar.value = camera.far;
    u.fogNear.value = fog.near;
    u.fogFar.value = fog.far;
    u.outline.value = look.outline * dpr;
    u.ink.value = look.ink;
    u.inkTint.value = look.inkTint;
    u.creases.value = look.creases;
    u.saturation.value = look.saturation;
    u.levels.value = look.levels;
    u.pixel.value = Math.max(1, Math.round(look.pixel * dpr));
    r.render(this.quad, this.quadCamera);
  }
}

/** The style named by `?style=`, or classic. */
export function styleFromUrl(): StyleName {
  const name = new URLSearchParams(location.search).get('style');
  return (STYLES as readonly string[]).includes(name ?? '') ? (name as StyleName) : 'classic';
}

/** A button under "Select stage" naming the style, which cycles it, as V does. */
export function styleButton(styles: StyleRenderer) {
  const button = document.createElement('button');
  button.className = 'stage-button';
  button.style.top = '52px';
  const show = () => (button.textContent = `Style: ${styles.label}`);
  const cycle = () => {
    styles.next();
    show();
  };
  show();
  button.addEventListener('click', () => {
    button.blur();
    cycle();
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyV' && !e.repeat) cycle();
  });
  document.body.appendChild(button);
  return show;
}
