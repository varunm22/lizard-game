import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PALETTE } from '../render/scene';
import { toonGradient } from '../render/toon';
import { terrainHeight } from './terrain';

export interface Obstacle {
  name: string;
  position: THREE.Vector3;
  /** Height of its top above the ground beneath its centre (m). */
  height: number;
}

/**
 * Placeholder obstacles until the props step: a few rocks and a fallen log, fixed in place and sunk
 * a little into the terrain. Sized against the controller: the pebble can be stepped onto, the rest
 * need a jump (0.08 m).
 */
export function buildObstacles(scene: THREE.Scene, world: RAPIER.World): Obstacle[] {
  const obstacles: Obstacle[] = [];
  const stone = new THREE.MeshToonMaterial({ color: PALETTE.stone, gradientMap: toonGradient() });
  const bark = new THREE.MeshToonMaterial({ color: PALETTE.bark, gradientMap: toonGradient() });

  const place = (
    name: string,
    mesh: THREE.Mesh,
    collider: RAPIER.ColliderDesc,
    x: number,
    z: number,
    lift: number,
    rot = new THREE.Quaternion(),
  ) => {
    const pos = new THREE.Vector3(x, terrainHeight(x, z) + lift, z);
    mesh.position.copy(pos);
    mesh.quaternion.copy(rot);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = name;
    scene.add(mesh);
    world.createCollider(collider.setTranslation(pos.x, pos.y, pos.z).setRotation(rot).setFriction(0.9));
    return pos;
  };

  for (const [name, x, z, r, sink] of [
    ['rock-big', -0.45, -0.35, 0.09, 0.045],
    ['rock-mid', 0.4, -0.5, 0.05, 0.015],
    ['pebble', 0.25, 0.3, 0.025, 0.012],
  ] as const) {
    const lift = r - sink;
    const pos = place(name, new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), stone), RAPIER.ColliderDesc.ball(r), x, z, lift);
    obstacles.push({ name, position: pos, height: lift + r });
  }

  const logR = 0.035;
  const logLen = 0.6;
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4);
  const lay = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  const logRot = yaw.clone().multiply(lay);
  const logPos = place(
    'log',
    new THREE.Mesh(new THREE.CylinderGeometry(logR, logR, logLen, 14), bark),
    RAPIER.ColliderDesc.capsule(logLen / 2 - logR, logR),
    0,
    -0.6,
    logR - 0.004,
    logRot,
  );
  obstacles.push({ name: 'log', position: logPos, height: 2 * logR - 0.004 });

  return obstacles;
}
