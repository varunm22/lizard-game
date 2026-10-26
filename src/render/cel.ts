import * as THREE from 'three';

/**
 * The game's look: bold cel shading. Every toon surface shades in two hard bands (the ramp in
 * `toon.ts`), and one screen pass inks dark outlines round silhouettes, fainter ones where the colour
 * jumps, and lifts the saturation.
 */

/** The sky light (which fills the shadow side) and the sun, relative to how `createScene` sets them. */
const SKY = 0.8;
const SUN = 1.1;
/** Outline width in CSS pixels at LINE_AT (below). */
const OUTLINE = 2;

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAGMENT = /* glsl */ `
#include <packing>
// Lines are a fixed width in the world: outline pixels at LINE_AT metres from the camera (about
// where it sits behind the lizard), wider nearer, up to LINE_MAX times that, and narrower further
// off. Under a pixel wide they fade instead, and past LINE_FAR there are none.
#define LINE_AT 0.38
#define LINE_MAX 3.0
#define LINE_FAR 2.5
// How dark lines are, and how much they take the colour under them.
#define INK 1.0
#define INK_TINT 0.3
// Lines where the colour jumps (band edges, markings), as a share of a silhouette's strength.
#define CREASES 0.35
#define SATURATION 1.3
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 resolution;
uniform float cameraNear, cameraFar, fogNear, fogFar, waterY, cameraUnder;
uniform mat4 projectionInverse, cameraWorld;
uniform float outline;
varying vec2 vUv;

float viewDepth(vec2 uv) {
  return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar);
}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 colourAt(vec2 uv) { return texture2D(tColor, uv).rgb; }
// How strongly the pixel at uv (inverse depth inv) lies just inside a silhouette, from the
// Laplacian of inverse depth on a circle of radius o. Inverse depth is linear across any flat
// surface on screen, so this is ~0 on the ground however steeply it is seen, and sharply negative
// on the near side of an edge. Eight taps on a circle rather than four on a cross: with a cross, a
// line several pixels wide steps along diagonals in blocks as wide as itself.
float silhouette(vec2 uv, float inv, vec2 o) {
  vec2 q = o * 0.7071;
  float lap = 0.5 * (1.0 / viewDepth(uv + vec2(o.x, 0.0)) + 1.0 / viewDepth(uv - vec2(o.x, 0.0))
    + 1.0 / viewDepth(uv + vec2(0.0, o.y)) + 1.0 / viewDepth(uv - vec2(0.0, o.y))
    + 1.0 / viewDepth(uv + q) + 1.0 / viewDepth(uv - q)
    + 1.0 / viewDepth(uv + vec2(q.x, -q.y)) + 1.0 / viewDepth(uv - vec2(q.x, -q.y))) - 4.0 * inv;
  return smoothstep(0.025, 0.09, -lap / inv);
}

void main() {
  vec2 uv = vUv;
  vec3 c = colourAt(uv);

  float d = viewDepth(uv);
  // Past LINE_FAR (or the fog, if nearer) there are no lines at all, and the pass skips its
  // neighbour reads there entirely.
  float lineFar = min(fogFar, LINE_FAR);
  // Nothing seen through the sea's surface is outlined: the reef from the shore, or the shore from
  // under water. (The sea writes no depth, so this tells it by the height of what's behind it.)
  vec4 view = projectionInverse * vec4(uv * 2.0 - 1.0, texture2D(tDepth, uv).x * 2.0 - 1.0, 1.0);
  float under = step((cameraWorld * vec4(view.xyz / view.w, 1.0)).y, waterY);
  if (d < lineFar && under == cameraUnder) {
    // How heavy this surface's lines are, written in alpha by its material (lineWeight): 1 for
    // creatures and rocks, lighter for plants, so a meadow isn't all ink.
    float weight = texture2D(tColor, uv).a;
    // So an object's lines keep their size relative to it as it (or the zoomed camera) comes and goes.
    float width = outline * weight * min(LINE_AT / d, LINE_MAX);
    vec2 o = vec2(max(width, 1.0)) / resolution;
    float inv = 1.0 / d;
    // A line several pixels wide has two jagged sides, both crawling as blades sway. Reading it at
    // two radii half a pixel either side softens the inner side to half-tone steps.
    float edge = width > 1.0
      ? 0.5 * (silhouette(uv, inv, o - 0.5 / resolution) + silhouette(uv, inv, o + 0.5 / resolution))
      : silhouette(uv, inv, o);
    // Colour jumps, read no wider than at LINE_AT: four taps far apart see a thin feature (a claw, a
    // band edge) from every pixel that far from it, so a wide reach drew ghost copies when the camera
    // zoomed in. And none on the background just outside a silhouette (where a tap lands on something
    // nearer: the Laplacian of inverse depth turns positive), or every outline got a faint second line.
    vec2 g = vec2(max(min(width, outline * weight), 1.0)) / resolution;
    float gx = luma(colourAt(uv + vec2(g.x, 0.0))) - luma(colourAt(uv - vec2(g.x, 0.0)));
    float gy = luma(colourAt(uv + vec2(0.0, g.y))) - luma(colourAt(uv - vec2(0.0, g.y)));
    float nearer = 0.5 * (1.0 / viewDepth(uv + vec2(g.x, 0.0)) + 1.0 / viewDepth(uv - vec2(g.x, 0.0))
      + 1.0 / viewDepth(uv + vec2(0.0, g.y)) + 1.0 / viewDepth(uv - vec2(0.0, g.y))) - 2.0 * inv;
    float crease = smoothstep(0.12, 0.3, length(vec2(gx, gy))) * (1.0 - smoothstep(0.003, 0.012, nearer / inv));
    edge = max(edge, CREASES * crease);
    edge *= min(width, 1.0) * (1.0 - smoothstep(0.75 * lineFar, lineFar, d));
    vec3 line = mix(vec3(0.07, 0.06, 0.05), c * 0.3, INK_TINT);
    c = mix(c, line, edge * INK);
  }

  c = mix(vec3(luma(c)), c, SATURATION);
  gl_FragColor = vec4(c, 1.0);
}`;

/**
 * Draws a stage in the cel look: the scene into an offscreen target (colour and depth, multisampled
 * like the canvas), then one full-screen pass over it, so a frame costs one extra draw call and a
 * pass over every pixel.
 */
export class CelRenderer {
  private target: THREE.WebGLRenderTarget;
  private pass: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private quadCamera = new THREE.Camera();
  private size = new THREE.Vector2();
  /** The sea's level (m), for keeping lines off what's seen through its surface; none by default. */
  waterY = -Infinity;

  constructor(
    private renderer: THREE.WebGLRenderer,
    sky: THREE.HemisphereLight,
    sun: THREE.DirectionalLight,
  ) {
    sky.intensity *= SKY;
    sun.intensity *= SUN;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      colorSpace: THREE.SRGBColorSpace,
      samples: 4,
      depthTexture: new THREE.DepthTexture(1, 1),
    });
    // Have every material write sRGB into the target, as it would to the canvas, rather than linear
    // light. three.js does that only for the canvas and XR targets, hence the flag. Otherwise the
    // translucent sea blends in linear light, washing out the reef under it.
    (this.target as { isXRRenderTarget?: boolean }).isXRRenderTarget = true;
    // Stored as plain 8-bit values, like the canvas: the values are already sRGB (an sRGB format
    // would encode them twice), and every draw clamps to 0-1. A float target kept the out-of-range
    // colours some shaders write for pixels under the sea, and blending the sea over them left
    // black specks out on the water that the canvas never shows.
    this.target.texture.internalFormat = 'RGBA8';
    this.pass = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        tColor: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        resolution: { value: new THREE.Vector2() },
        cameraNear: { value: 0 },
        cameraFar: { value: 0 },
        projectionInverse: { value: new THREE.Matrix4() },
        cameraWorld: { value: new THREE.Matrix4() },
        waterY: { value: 0 },
        cameraUnder: { value: 0 },
        fogNear: { value: 0 },
        fogFar: { value: 0 },
        outline: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.pass);
    this.quad.frustumCulled = false;
    // Two renders make up a frame here, so the counts are reset once per frame, not per render.
    renderer.info.autoReset = false;
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    const r = this.renderer;
    r.info.reset();
    r.getDrawingBufferSize(this.size);
    if (this.target.width !== this.size.x || this.target.height !== this.size.y) this.target.setSize(this.size.x, this.size.y);
    r.setRenderTarget(this.target);
    r.render(scene, camera);
    r.setRenderTarget(null);
    const u = this.pass.uniforms;
    const fog = scene.fog as THREE.Fog;
    u.resolution.value.copy(this.size);
    u.cameraNear.value = camera.near;
    u.cameraFar.value = camera.far;
    u.projectionInverse.value.copy(camera.projectionMatrixInverse);
    u.cameraWorld.value.copy(camera.matrixWorld);
    u.waterY.value = Math.max(this.waterY, -1e6);
    u.cameraUnder.value = camera.position.y < this.waterY ? 1 : 0;
    u.fogNear.value = fog.near;
    u.fogFar.value = fog.far;
    u.outline.value = OUTLINE * r.getPixelRatio();
    r.render(this.quad, this.quadCamera);
  }
}

/**
 * Give a material lighter outlines (weight 0 to 1, 1 being a creature's or a rock's). It writes the
 * weight into the alpha of what it draws, which the screen pass reads. Keeps any shader patch the
 * material had.
 */
export function lineWeight(material: THREE.Material, weight: number) {
  const patch = material.onBeforeCompile;
  const key = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    patch.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `#include <opaque_fragment>\ngl_FragColor.a = ${weight.toFixed(3)};`);
  };
  material.customProgramCacheKey = () => `${key.call(material)}-line${weight}`;
}
