/** Signed angle in [-pi, pi], preserving the direction at the half-turn boundary. */
export function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}
