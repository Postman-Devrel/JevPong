import { GAME } from "./constants";

/** Reflect an unfolded trajectory against both walls, including multiple bounces. */
export function reflectY(
  y: number,
  height: number = GAME.height,
  radius: number = GAME.ballRadius,
): number {
  const span = height - radius * 2;
  const folded = (((y - radius) % (span * 2)) + span * 2) % (span * 2);
  return radius + (folded <= span ? folded : span * 2 - folded);
}

export function predictIntercept(
  ball: { x: number; y: number; vx: number; vy: number },
  targetX: number = GAME.aiX - GAME.paddleWidth / 2 - GAME.ballRadius,
  height: number = GAME.height,
  radius: number = GAME.ballRadius,
): { interceptY: number | null; timeToImpactMs: number | null } {
  if (Math.abs(ball.vx) < 0.001)
    return { interceptY: null, timeToImpactMs: null };
  const seconds = (targetX - ball.x) / ball.vx;
  if (seconds < 0) return { interceptY: null, timeToImpactMs: null };
  return {
    interceptY: reflectY(ball.y + ball.vy * seconds, height, radius),
    timeToImpactMs: seconds * 1000,
  };
}
