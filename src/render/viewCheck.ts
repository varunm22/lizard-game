import * as THREE from 'three';

/**
 * Where the camera was looking when it was last placed, so drawn-only work (animating a crab,
 * fitting an iguana's feet to the rock) can be skipped or done more cheaply for what is off screen
 * or far off. Never consulted by the simulation.
 */
export class ViewCheck {
  readonly eye = new THREE.Vector3();
  private frustum = new THREE.Frustum();
  private m = new THREE.Matrix4();
  private sphere = new THREE.Sphere();

  update(camera: THREE.Camera) {
    camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(this.m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    this.eye.setFromMatrixPosition(camera.matrixWorld);
  }

  /** Whether a sphere of radius r at p is at least partly in view. */
  sees(p: THREE.Vector3Like, r: number): boolean {
    this.sphere.center.set(p.x, p.y, p.z);
    this.sphere.radius = r;
    return this.frustum.intersectsSphere(this.sphere);
  }

  /** Whether p is in view (with radius r) and within `near` of the camera. */
  close(p: THREE.Vector3Like, r: number, near: number): boolean {
    return this.sees(p, r) && this.eye.distanceToSquared(this.sphere.center) < near * near;
  }
}
