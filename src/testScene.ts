import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PALETTE } from './render/scene';

/** A physics body paired with the mesh that draws it, plus its previous pose for interpolation. */
export interface Synced {
  body: RAPIER.RigidBody;
  mesh: THREE.Mesh;
  prevPos: THREE.Vector3;
  prevRot: THREE.Quaternion;
}

/**
 * Placeholder scene for the scaffold: a flat ground and a few lizard-scale rocks and a log
 * dropped onto it, proving Rapier and the render interpolation work. Replaced by real terrain next.
 */
export function buildTestScene(scene: THREE.Scene, world: RAPIER.World): Synced[] {
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(3, 48).rotateX(-Math.PI / 2),
    new THREE.MeshToonMaterial({ color: PALETTE.ground }),
  );
  ground.receiveShadow = true;
  scene.add(ground);
  world.createCollider(RAPIER.ColliderDesc.cuboid(3, 0.05, 3).setTranslation(0, -0.05, 0));

  const synced: Synced[] = [];
  const add = (mesh: THREE.Mesh, collider: RAPIER.ColliderDesc, pos: THREE.Vector3, rot = new THREE.Quaternion()) => {
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).setRotation(rot),
    );
    world.createCollider(collider, body);
    mesh.position.copy(pos);
    mesh.quaternion.copy(rot);
    synced.push({ body, mesh, prevPos: pos.clone(), prevRot: rot.clone() });
  };

  const stone = new THREE.MeshToonMaterial({ color: PALETTE.stone });
  for (const [x, z, r, y] of [
    [-0.2, -0.1, 0.06, 0.3],
    [0.15, -0.25, 0.04, 0.5],
    [0.05, 0.15, 0.03, 0.7],
  ]) {
    add(
      new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), stone),
      RAPIER.ColliderDesc.ball(r).setFriction(0.9),
      new THREE.Vector3(x, y, z),
    );
  }

  const log = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 0.5, 12).rotateZ(Math.PI / 2),
    new THREE.MeshToonMaterial({ color: PALETTE.bark }),
  );
  add(
    log,
    RAPIER.ColliderDesc.capsule(0.215, 0.035).setRotation(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2),
    ),
    new THREE.Vector3(0, 0.4, -0.05),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4),
  );

  return synced;
}

export function snapshotPoses(synced: Synced[]) {
  for (const s of synced) {
    const t = s.body.translation();
    const r = s.body.rotation();
    s.prevPos.set(t.x, t.y, t.z);
    s.prevRot.set(r.x, r.y, r.z, r.w);
  }
}

const tmpPos = new THREE.Vector3();
const tmpRot = new THREE.Quaternion();

/** Draw each mesh between its previous and current physics pose. */
export function interpolatePoses(synced: Synced[], alpha: number) {
  for (const s of synced) {
    const t = s.body.translation();
    const r = s.body.rotation();
    s.mesh.position.lerpVectors(s.prevPos, tmpPos.set(t.x, t.y, t.z), alpha);
    s.mesh.quaternion.slerpQuaternions(s.prevRot, tmpRot.set(r.x, r.y, r.z, r.w), alpha);
  }
}
