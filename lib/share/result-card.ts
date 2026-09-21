export interface ResultCardData {
  playerName: string;
  humanScore: number;
  agentScore: number;
  winner: "human" | "ai" | null;
  longestRally: number;
  decisions: number;
  fallbackRate: number;
  latencyP50Ms: number | null;
  model: string;
}

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;

export function normalizePlayerName(value: string): string {
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18);
  return clean || "PLAYER 01";
}

export function resultHeadline(data: ResultCardData): string {
  return data.winner === "human" ? "I BEAT JEV." : "I TOOK ON JEV.";
}

export function resultShareText(data: ResultCardData): string {
  const name = normalizePlayerName(data.playerName);
  const result =
    data.winner === "human"
      ? `beat Jev ${data.humanScore}–${data.agentScore}`
      : `took on Jev and scored ${data.humanScore}`;
  return `${name} ${result}. Can you beat the machine?`;
}

export function resultFilename(data: ResultCardData): string {
  const slug = normalizePlayerName(data.playerName)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 28);
  return `jev-pong-${slug || "player"}-${data.humanScore}-${data.agentScore}.png`;
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function fitText(
  context: CanvasRenderingContext2D,
  value: string,
  maxWidth: number,
  startSize: number,
  family: string,
  weight = 600,
) {
  let size = startSize;
  do {
    context.font = `${weight} ${size}px ${family}`;
    size -= 2;
  } while (context.measureText(value).width > maxWidth && size > 28);
}

function metric(
  context: CanvasRenderingContext2D,
  label: string,
  value: string,
  x: number,
  width: number,
) {
  context.fillStyle = "#8c9585";
  context.font = '500 17px "IBM Plex Mono", monospace';
  context.fillText(label, x, 479);
  context.fillStyle = "#eeefe5";
  context.font = '500 28px "IBM Plex Mono", monospace';
  context.fillText(value, x, 521, width);
}

export async function createResultCardBlob(
  data: ResultCardData,
): Promise<Blob> {
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");

  context.fillStyle = "#10120f";
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  // A faint logical-court grid ties the receipt to the match without becoming
  // a decorative illustration.
  context.fillStyle = "rgba(196,244,110,.075)";
  for (let x = 36; x < CARD_WIDTH; x += 34) {
    for (let y = 34; y < CARD_HEIGHT; y += 34) context.fillRect(x, y, 2, 2);
  }

  context.strokeStyle = "#303629";
  context.lineWidth = 2;
  roundedRect(context, 35, 34, 1130, 562, 24);
  context.stroke();

  context.fillStyle = "#171b14";
  roundedRect(context, 62, 61, 86, 508, 12);
  context.fill();
  context.save();
  context.translate(107, 525);
  context.rotate(-Math.PI / 2);
  context.fillStyle = "#c4f46e";
  context.font = '500 18px "IBM Plex Mono", monospace';
  context.letterSpacing = "4px";
  context.fillText("MATCH RECEIPT  /  VERIFIED PLAY", 0, 0);
  context.restore();

  context.fillStyle = "#c4f46e";
  context.fillRect(184, 78, 7, 30);
  context.fillRect(216, 70, 7, 30);
  context.fillStyle = "#ff8a4c";
  context.fillRect(199, 86, 8, 8);
  context.fillStyle = "#eeefe5";
  context.font = '700 31px "Space Grotesk", sans-serif';
  context.fillText("jev", 239, 99);
  context.fillStyle = "#8c9585";
  context.font = '400 31px "Space Grotesk", sans-serif';
  context.fillText("pong", 286, 99);

  context.textAlign = "right";
  context.fillStyle = "#8c9585";
  context.font = '500 15px "IBM Plex Mono", monospace';
  context.fillText("HUMAN INSTINCT  /  MACHINE INTELLIGENCE", 1118, 96);
  context.textAlign = "left";

  const headline = resultHeadline(data);
  context.fillStyle = data.winner === "human" ? "#c4f46e" : "#ff8a4c";
  context.font = '500 20px "IBM Plex Mono", monospace';
  context.fillText(headline, 184, 173);

  const player = normalizePlayerName(data.playerName).toUpperCase();
  context.fillStyle = "#eeefe5";
  fitText(context, player, 480, 65, '"Space Grotesk", sans-serif', 600);
  context.fillText(player, 184, 248);
  context.fillStyle = "#8c9585";
  context.font = '500 16px "IBM Plex Mono", monospace';
  context.fillText("PLAYER", 186, 278);

  context.fillStyle = "#eeefe5";
  context.font = '600 106px "Space Grotesk", sans-serif';
  context.fillText(String(data.humanScore).padStart(2, "0"), 664, 270);
  context.fillStyle = "#586052";
  context.font = '400 48px "IBM Plex Mono", monospace';
  context.fillText("—", 793, 249);
  context.fillStyle = "#c4f46e";
  context.font = '600 106px "Space Grotesk", sans-serif';
  context.fillText(String(data.agentScore).padStart(2, "0"), 877, 270);
  context.fillStyle = "#8c9585";
  context.font = '500 16px "IBM Plex Mono", monospace';
  context.fillText("JEV", 891, 299);

  context.fillStyle = "#20251c";
  roundedRect(context, 184, 339, 934, 1, 0);
  context.fill();

  metric(context, "BEST RALLY", `${data.longestRally} HITS`, 184, 180);
  metric(context, "JEV DECISIONS", String(data.decisions), 410, 180);
  metric(
    context,
    "FALLBACK RATE",
    `${Math.round(data.fallbackRate * 100)}%`,
    665,
    170,
  );
  metric(
    context,
    "LATENCY P50",
    data.latencyP50Ms == null ? "—" : `${Math.round(data.latencyP50Ms)} MS`,
    890,
    190,
  );

  context.fillStyle = "#8c9585";
  context.font = '400 17px "Space Grotesk", sans-serif';
  context.fillText("Can you beat the machine?", 184, 561);
  context.textAlign = "right";
  context.fillStyle = "#c4f46e";
  context.font = '500 16px "IBM Plex Mono", monospace';
  context.fillText("PLAY  /  WATCH  /  INSPECT", 1118, 561);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Image generation failed")),
      "image/png",
      1,
    );
  });
}

export function downloadResultCard(blob: Blob, data: ResultCardData) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = resultFilename(data);
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
