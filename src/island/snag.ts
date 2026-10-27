import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { toonGradient } from '../render/toon';
import { terrainHeight } from '../world/terrain';
import { hull, type Obstacle } from '../world/obstacles';
import { crackHalf, crackX } from './crack';

/** The dead tree: length, trunk radius (the collider's; the drawn trunk tapers a little) and how far it already leans out over the crack (radians). */
const LENGTH = 0.78;
const RADIUS = 0.036;
const LEAN = 0.2;
/** Knocked, it starts over at this rate (rad/s) and falls like a rod pivoting on its foot. */
const NUDGE = 0.35;
const GRAVITY = 9.81;
/** Bleached dead wood. */
const WOOD = 0xb3a894;

export type SnagState = 'standing' | 'falling' | 'fallen';

/**
 * A dead tree standing on the east rim of the crack, leaning out over it. The lizard can't move it,
 * but something heavy bumping it (the tortoise, reaching for a fig at its foot) knocks it over: it
 * topples west and comes to rest across the crack, a log bridge to the far side. The fall is scripted,
 * a rod pivoting on its foot, on a kinematic body; once down it stays put.
 */
export class Snag {
  state: SnagState = 'standing';
  readonly obstacle: Obstacle;
  readonly body: RAPIER.RigidBody;
  /** How far over from upright it is (radians), how fast it's going over, and where it comes to rest. */
  angle = LEAN;
  private spin = 0;
  readonly restAngle: number;
  private foot: THREE.Vector3;
  private mesh: THREE.Mesh;
  private rot = new THREE.Quaternion();
  private prevRot = new THREE.Quaternion();
  /** Called once it has come down across the crack. */
  onFallen: (() => void) | null = null;

  constructor(scene: THREE.Scene, world: RAPIER.World, at: { x: number; z: number }) {
    // It lies on the ground once down, so it turns about a point a trunk's radius up.
    this.foot = new THREE.Vector3(at.x, terrainHeight(at.x, at.z) + RADIUS, at.z);
    this.restAngle = restingAngle(this.foot);
    // Drawn from a little below its foot (its broken-off root end) to the tip, with two snapped-off limbs.
    const trunk = new THREE.CylinderGeometry(RADIUS * 0.75, RADIUS * 1.15, LENGTH + 0.06, 9, 4).translate(0, (LENGTH + 0.06) / 2 - 0.06, 0);
    const pos = trunk.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      // Knobbly and a little bent.
      const y = pos.getY(i);
      const k = 1 + 0.12 * Math.sin(y * 31 + pos.getX(i) * 90) * Math.cos(pos.getZ(i) * 70);
      pos.setXYZ(i, pos.getX(i) * k + 0.012 * Math.sin(y * 5), y, pos.getZ(i) * k);
    }
    trunk.computeVertexNormals();
    const material = new THREE.MeshToonMaterial({ color: WOOD, gradientMap: toonGradient() });
    this.mesh = new THREE.Mesh(trunk, material);
    for (const [y, a, l] of [
      [0.42, 1.1, 0.09],
      [0.6, -2.2, 0.06],
    ] as const) {
      const limb = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.014, l, 6).translate(0, l / 2, 0), material);
      limb.position.set(0, y, 0);
      limb.rotation.set(Math.sin(a) * 0.9, 0, Math.cos(a) * 0.9);
      this.mesh.add(limb);
    }
    this.mesh.name = 'snag';
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    this.mesh.position.copy(this.foot);
    scene.add(this.mesh);

    // The solid trunk: straight, with a flat face up once it lies down, from its foot to its tip.
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.foot.x, this.foot.y, this.foot.z));
    const shape = new THREE.CylinderGeometry(RADIUS, RADIUS, LENGTH, 14).translate(0, LENGTH / 2, 0);
    const collider = world.createCollider(hull(shape).setFriction(0.9), this.body);
    this.pose(LEAN);
    this.prevRot.copy(this.rot);
    this.body.setRotation(this.rot, true);
    this.obstacle = { name: 'snag', kind: 'tree', position: this.mesh.position, height: LENGTH, radius: RADIUS, mesh: this.mesh, collider };
  }

  /** Where its foot stands. */
  get position() {
    return this.foot;
  }

  /** Its tip, where it is now. */
  get tip(): THREE.Vector3 {
    return new THREE.Vector3(0, LENGTH, 0).applyQuaternion(this.rot).add(this.foot);
  }

  /** Something heavy bumps it: over it goes. */
  knock() {
    if (this.state !== 'standing') return;
    this.state = 'falling';
    this.spin = NUDGE;
  }

  step(dt: number) {
    this.prevRot.copy(this.rot);
    if (this.state !== 'falling') return;
    // A rod pivoting on its end: angular acceleration 3g sin(angle) / 2L.
    this.spin += ((3 * GRAVITY) / (2 * LENGTH)) * Math.sin(this.angle) * dt;
    this.angle += this.spin * dt;
    if (this.angle >= this.restAngle) {
      this.angle = this.restAngle;
      this.state = 'fallen';
      // Lying down, it's a log across the crack.
      const half = new THREE.Vector3(0, LENGTH / 2, 0).applyQuaternion(this.rot.setFromAxisAngle(Z, this.angle));
      this.obstacle.kind = 'log';
      this.obstacle.axis = new THREE.Vector3(half.x, 0, half.z);
      this.obstacle.position = this.foot.clone().add(half);
      this.obstacle.height = 2 * RADIUS;
      this.onFallen?.();
    }
    this.pose(this.angle);
    this.body.setNextKinematicRotation(this.rot);
  }

  private pose(angle: number) {
    // Over toward -X: about +Z, so its up turns west.
    this.rot.setFromAxisAngle(Z, angle);
  }

  /** Draw it between the last two steps. */
  update(alpha: number) {
    this.mesh.quaternion.slerpQuaternions(this.prevRot, this.rot, alpha);
  }
}

const Z = new THREE.Vector3(0, 0, 1);

/** How far over it is once its tip rests on the crack's far rim (radians). */
function restingAngle(foot: THREE.Vector3): number {
  const far = crackX(foot.z) - crackHalf(foot.z);
  for (let a = LEAN; a < Math.PI / 2 + 0.3; a += 0.002) {
    const tx = foot.x - Math.sin(a) * LENGTH;
    const ty = foot.y + Math.cos(a) * LENGTH;
    if (tx < far && ty - RADIUS <= terrainHeight(tx, foot.z)) return a;
  }
  throw new Error('the dead tree does not reach across the crack');
}
