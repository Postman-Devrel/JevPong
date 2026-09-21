import type { GameEvent, GameState } from "@/lib/game/engine";
import { GAME } from "@/lib/game/constants";

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
};
export class CourtRenderer {
  private trail: { x: number; y: number }[] = [];
  private particles: Particle[] = [];
  private roundId = 0;
  private width = 0;
  private height = 0;
  private reducedMotion = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.round(rect.width * dpr);
    this.height = Math.round(rect.height * dpr);
    if (
      this.canvas.width !== this.width ||
      this.canvas.height !== this.height
    ) {
      this.canvas.width = this.width;
      this.canvas.height = this.height;
    }
  }

  draw(state: GameState, events: GameEvent[], dt: number) {
    const context = this.canvas.getContext("2d");
    if (!context || !this.width || !this.height) return;
    const c = context;
    c.setTransform(
      this.width / GAME.width,
      0,
      0,
      this.height / GAME.height,
      0,
      0,
    );
    c.clearRect(0, 0, GAME.width, GAME.height);
    if (this.roundId !== state.roundId) {
      this.trail = [];
      this.roundId = state.roundId;
    }
    c.fillStyle = "#10160f";
    c.fillRect(0, 0, GAME.width, GAME.height);
    c.fillStyle = "rgba(158,185,143,0.105)";
    for (let x = 20; x < GAME.width; x += 24)
      for (let y = 12; y < GAME.height; y += 24) c.fillRect(x, y, 1, 1);
    const glow = c.createRadialGradient(480, 300, 10, 480, 300, 470);
    glow.addColorStop(0, "rgba(150,193,110,0.025)");
    glow.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = glow;
    c.fillRect(0, 0, 960, 600);
    c.strokeStyle = "rgba(168,189,154,.1)";
    c.lineWidth = 1;
    c.strokeRect(18.5, 18.5, 923, 563);
    c.setLineDash([6, 12]);
    c.strokeStyle = "rgba(183,205,169,.22)";
    c.beginPath();
    c.moveTo(480, 20);
    c.lineTo(480, 580);
    c.stroke();
    c.setLineDash([]);
    c.strokeStyle = "rgba(183,205,169,.10)";
    c.beginPath();
    c.arc(480, 300, 78, 0, Math.PI * 2);
    c.stroke();

    if (state.phase === "playing" && !this.reducedMotion) {
      this.trail.unshift({ x: state.ball.x, y: state.ball.y });
      this.trail.length = Math.min(12, this.trail.length);
    } else if (state.phase === "ready" || state.phase === "countdown")
      this.trail = [];
    this.trail.forEach((point, i) => {
      c.fillStyle = `rgba(238,239,229,${(1 - i / 12) * 0.16})`;
      const size = Math.max(2, 7 - i * 0.35);
      c.beginPath();
      c.arc(point.x, point.y, size, 0, Math.PI * 2);
      c.fill();
    });
    for (const side of ["human", "ai"] as const) {
      const paddle = state.paddles[side];
      const boosted = state.elapsed < paddle.boostUntil;
      c.fillStyle = boosted
        ? "#ff8a4c"
        : side === "human"
          ? "#eeefe5"
          : "#c4f46e";
      c.shadowColor = boosted
        ? "#ff8a4c"
        : side === "human"
          ? "#eeefe5"
          : "#c4f46e";
      c.shadowBlur = this.reducedMotion ? 0 : boosted ? 22 : 9;
      c.beginPath();
      c.roundRect(
        paddle.x - 7,
        paddle.y - paddle.height / 2,
        14,
        paddle.height,
        3,
      );
      c.fill();
      c.shadowBlur = 0;
      c.fillStyle = "rgba(255,255,255,.35)";
      c.fillRect(
        paddle.x - 3,
        paddle.y - paddle.height / 2 + 8,
        2,
        paddle.height - 16,
      );
    }
    if (state.phase !== "countdown" || state.countdown < 0.35) {
      c.fillStyle = "#eeefe5";
      c.shadowColor = "#eeefe5";
      c.shadowBlur = this.reducedMotion ? 0 : 14;
      c.beginPath();
      c.roundRect(state.ball.x - 7, state.ball.y - 7, 14, 14, 3);
      c.fill();
      c.shadowBlur = 0;
    }

    if (!this.reducedMotion) {
      for (const event of events) {
        if (!["hit", "wall", "boost"].includes(event.type)) continue;
        for (let i = 0; i < (event.type === "wall" ? 4 : 10); i++) {
          const angle = (i / 10) * Math.PI * 2;
          this.particles.push({
            x: event.x,
            y: event.y,
            vx: Math.cos(angle) * (45 + i * 12),
            vy: Math.sin(angle) * (45 + i * 12),
            life: 0.4,
            color:
              event.type === "boost"
                ? "#ff8a4c"
                : event.side === "ai"
                  ? "#c4f46e"
                  : "#eeefe5",
          });
        }
      }
      this.particles = this.particles.filter((p) => p.life > 0).slice(-120);
      for (const p of this.particles) {
        p.life -= dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        c.globalAlpha = Math.max(0, p.life / 0.4);
        c.fillStyle = p.color;
        c.fillRect(p.x, p.y, 3, 3);
      }
      c.globalAlpha = 1;
    }
    // Court corner marks orient the player without competing with the ball.
    c.font = '10px "IBM Plex Mono", monospace';
    c.fillStyle = "#65725d";
    c.textAlign = "left";
    c.fillText("YOU", 64, 44);
    c.textAlign = "right";
    c.fillStyle = "#809569";
    c.fillText("JEV", 896, 44);
  }
}
