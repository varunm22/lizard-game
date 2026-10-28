import * as THREE from 'three';

/** Radius (m) of the cut where it reaches the lizard; it narrows to a point at the camera. */
const RADIUS = 0.09;
/** The cut stops this far short of the lizard (m). */
const SHORT = 0.05;
/** How much of the rock shows through the cut. */
const GHOST_OPACITY = 0.22;

/**
 * Keeps the lizard in view without pulling the camera in: the camera holds its distance (its arm
 * passes through the rock), and any rock inside a cone from the camera to the lizard, floors below
 * it aside, is drawn as a faint ghost instead of solid. The solid rock discards those fragments; a
 * second draw of the same geometry shows only them, see-through and writing no depth (so the
 * outline pass draws the cut's edge and nothing behind is hidden). The lizard's own tube wall seen
 * from outside is a back face, already culled, so this only has to deal with rock that really is
 * in the way.
 */
export class RockCutaway {
  private uniforms = {
    cutFrom: { value: new THREE.Vector3() },
    cutTo: { value: new THREE.Vector3() },
  };

  constructor(rock: THREE.Mesh, scene: THREE.Scene) {
    const solid = rock.material as THREE.MeshBasicMaterial;
    this.patch(solid, false);
    const ghost = solid.clone();
    ghost.transparent = true;
    ghost.depthWrite = false;
    ghost.opacity = GHOST_OPACITY;
    // Blend the colour only: the alpha the solid rock wrote is its line weight for the outline pass.
    ghost.blending = THREE.CustomBlending;
    ghost.blendSrc = THREE.SrcAlphaFactor;
    ghost.blendDst = THREE.OneMinusSrcAlphaFactor;
    ghost.blendSrcAlpha = THREE.ZeroFactor;
    ghost.blendDstAlpha = THREE.OneFactor;
    this.patch(ghost, true);
    const mesh = new THREE.Mesh(rock.geometry, ghost);
    mesh.name = 'rock-ghost';
    mesh.renderOrder = 1;
    scene.add(mesh);
  }

  /** Where the camera is and the point on the lizard it looks at (each frame). */
  update(camera: THREE.Vector3, target: THREE.Vector3) {
    this.uniforms.cutFrom.value.copy(camera);
    this.uniforms.cutTo.value.copy(target);
  }

  /** Discard fragments inside the cone (the solid rock) or outside it (the ghost). */
  private patch(material: THREE.Material, ghost: boolean) {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vCutWorld;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvCutWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vCutWorld;\nuniform vec3 cutFrom;\nuniform vec3 cutTo;')
        .replace(
          'void main() {',
          `void main() {
  vec3 cutAxis = cutTo - cutFrom;
  float cutLength = length(cutAxis);
  cutAxis /= max(cutLength, 1e-5);
  vec3 cutRel = vCutWorld - cutFrom;
  float cutT = dot(cutRel, cutAxis);
  bool cutIn = cutT > 0.0 && cutT < cutLength - ${SHORT.toFixed(3)} && length(cutRel - cutAxis * cutT) < ${RADIUS.toFixed(3)} * cutT / cutLength;
  // Floors below the lizard stay: they're under the view of it, not in front.
  vec3 cutNormal = normalize(cross(dFdx(vCutWorld), dFdy(vCutWorld)));
  if (abs(cutNormal.y) > 0.6 && vCutWorld.y < cutTo.y - 0.015) cutIn = false;
  if (${ghost ? '!cutIn' : 'cutIn'}) discard;`,
        );
    };
    material.customProgramCacheKey = () => (ghost ? 'rock-cut-ghost' : 'rock-cut-solid');
  }
}
