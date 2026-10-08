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
/**
 * How far each registered hull reaches from its collider's origin (m). Every ray cast onto a Rapier
 * shape copies the whole mesh into the physics engine first, which made those casts most of a
 * step's cost; a ray that passes wide of this sphere can't hit the hull and skips the cast.
 */
const reach = new Map<number, number>();

export interface SurfaceHit {
  timeOfImpact: number;
  normal: RAPIER.Vector;
  /** On a registered collider (the tortoise shell). */
  exact: boolean;
}
/** Where each registered collider is drawn this frame, when that differs from its physics pose. */
const drawn = new Map<number, { pos: RAPIER.Vector; rot: RAPIER.Rotation }>();

/** Answer surface queries against `collider` (a convex hull) with its hull as a triangle mesh. */
export function registerExactSurface(collider: RAPIER.Collider) {
  const indices = collider.indices();
  if (!indices) return;
  const vertices = collider.vertices();
  exact.set(collider.handle, builtOnce(new RAPIER.TriMesh(vertices, indices, RAPIER.TriMeshFlags.ORIENTED)));
  let r = 0;
  for (let i = 0; i < vertices.length; i += 3) r = Math.max(r, Math.hypot(vertices[i], vertices[i + 1], vertices[i + 2]));
  reach.set(collider.handle, r);
}

/**
 * Every query on a Rapier shape builds the shape afresh inside the physics engine (for a mesh, its
 * bounding tree too) and frees it afterwards: for the shell, 2 to 3 ms a query, which made each step
 * with the lizard on it take ~16 ms. Build the mesh's engine copy once and keep it.
 */
function builtOnce(mesh: RAPIER.TriMesh): RAPIER.TriMesh {
  const raw = mesh.intoRaw();
  raw.free = () => {};
  mesh.intoRaw = () => raw;
  return mesh;
}

/** Whether the ray's first `length` metres pass within `r` of `c`. */
function nearRay(ray: RAPIER.Ray, length: number, c: RAPIER.Vector, r: number): boolean {
  const { origin: o, dir: d } = ray;
  const t = Math.max(0, Math.min(length, (c.x - o.x) * d.x + (c.y - o.y) * d.y + (c.z - o.z) * d.z));
  return Math.hypot(o.x + d.x * t - c.x, o.y + d.y * t - c.y, o.z + d.z * t - c.z) <= r;
}

/**
 * Query `collider` where it is drawn this frame rather than where the last physics step left it. A
 * moving collider is drawn between its last two steps, and so is a lizard riding it: fitting the
 * drawn lizard to the collider's step pose instead puts the two a little out of step every frame.
 */
export function setDrawnPose(collider: RAPIER.Collider, pos: RAPIER.Vector, rot: RAPIER.Rotation) {
  drawn.set(collider.handle, { pos: { x: pos.x, y: pos.y, z: pos.z }, rot: { x: rot.x, y: rot.y, z: rot.z, w: rot.w } });
}

/** The pose to query `collider`'s exact shape at: where it's drawn, else its physics pose. */
export function surfacePose(collider: RAPIER.Collider): { pos: RAPIER.Vector; rot: RAPIER.Rotation } {
  return drawn.get(collider.handle) ?? { pos: collider.translation(), rot: collider.rotation() };
}

/** The exact shape to query in place of `collider`'s own, if it has one. */
export function exactShape(collider: RAPIER.Collider): RAPIER.TriMesh | undefined {
  return exact.get(collider.handle);
}

/**
 * Like `world.castRayAndGetNormal`, but registered colliders are hit on their exact shape, where
 * they're drawn. Returns the time of impact and normal of the nearest hit, and whether it was on a
 * registered collider, or null.
 */
export function castSurfaceRay(
  world: RAPIER.World,
  ray: RAPIER.Ray,
  maxToi: number,
  groups: number,
  exclude: RAPIER.RigidBody,
): SurfaceHit | null {
  const hit = world.castRayAndGetNormal(ray, maxToi, true, undefined, groups, undefined, exclude, (c) => !exact.has(c.handle));
  let best: SurfaceHit | null = hit && { timeOfImpact: hit.timeOfImpact, normal: hit.normal, exact: false };
  for (const [handle, shape] of exact) {
    const c = world.getCollider(handle);
    if (!c || c.parent()?.handle === exclude.handle || !passes(c.collisionGroups(), groups)) continue;
    const { pos, rot } = surfacePose(c);
    if (!nearRay(ray, best ? best.timeOfImpact : maxToi, pos, reach.get(handle)!)) continue;
    const s = shape.castRayAndGetNormal(ray, pos, rot, best ? best.timeOfImpact : maxToi, true);
    if (s && (!best || s.timeOfImpact < best.timeOfImpact)) best = { timeOfImpact: s.timeOfImpact, normal: s.normal, exact: true };
  }
  return best;
}

/** Whether a query with filter `groups` sees a collider in `colliderGroups`, as Rapier decides it. */
function passes(colliderGroups: number, groups: number): boolean {
  return ((colliderGroups >>> 16) & groups & 0xffff) !== 0 && ((groups >>> 16) & colliderGroups & 0xffff) !== 0;
}
