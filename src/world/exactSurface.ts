import RAPIER from '@dimforge/rapier3d-compat';

/**
 * Exact stand-ins for small convex colliders, for the queries that fit the drawn lizard to what it's
 * on. At game scale (a 0.24 m tortoise shell) Rapier's queries against a convex hull are only good to
 * several millimetres: a ray down onto the shell's crown can land 7 mm low at one spot and not beside
 * it, and a point just inside can project out through the far side. The physics is fine with that,
 * but as the shell bobs under a still rider it set the feet and tail twitching. A registered
 * collider is still what bodies collide with; these queries test the same hull as an oriented
 * triangle mesh instead, which is exact and still knows inside from out.
 */
const exact = new Map<number, RAPIER.TriMesh>();

/** Answer surface queries against `collider` (a convex hull) with its hull as a triangle mesh. */
export function registerExactSurface(collider: RAPIER.Collider) {
  const indices = collider.indices();
  if (!indices) return;
  exact.set(collider.handle, new RAPIER.TriMesh(collider.vertices(), indices, RAPIER.TriMeshFlags.ORIENTED));
}

/** The exact shape to query in place of `collider`'s own, if it has one. */
export function exactShape(collider: RAPIER.Collider): RAPIER.TriMesh | undefined {
  return exact.get(collider.handle);
}

/**
 * Like `world.castRayAndGetNormal`, but registered colliders are hit on their exact shape. Returns
 * the time of impact and normal of the nearest hit, or null.
 */
export function castSurfaceRay(
  world: RAPIER.World,
  ray: RAPIER.Ray,
  maxToi: number,
  groups: number,
  exclude: RAPIER.RigidBody,
): { timeOfImpact: number; normal: RAPIER.Vector } | null {
  const hit = world.castRayAndGetNormal(ray, maxToi, true, undefined, groups, undefined, exclude, (c) => !exact.has(c.handle));
  let best: { timeOfImpact: number; normal: RAPIER.Vector } | null = hit && { timeOfImpact: hit.timeOfImpact, normal: hit.normal };
  for (const [handle, shape] of exact) {
    const c = world.getCollider(handle);
    if (!c || c.parent()?.handle === exclude.handle || !passes(c.collisionGroups(), groups)) continue;
    const s = shape.castRayAndGetNormal(ray, c.translation(), c.rotation(), best ? best.timeOfImpact : maxToi, true);
    if (s && (!best || s.timeOfImpact < best.timeOfImpact)) best = { timeOfImpact: s.timeOfImpact, normal: s.normal };
  }
  return best;
}

/** Whether a query with filter `groups` sees a collider in `colliderGroups`, as Rapier decides it. */
function passes(colliderGroups: number, groups: number): boolean {
  return ((colliderGroups >>> 16) & groups & 0xffff) !== 0 && ((groups >>> 16) & colliderGroups & 0xffff) !== 0;
}
