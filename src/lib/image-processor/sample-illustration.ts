import type { LoadedImageResult } from "./image-loader";

/**
 * Generates a synthetic 2D die-cut sticker illustration directly on an offscreen canvas
 * (100% client-side, zero network) so users can immediately test Corner Flood-Fill
 * against a light-gray exterior background and a white die-cut border.
 */
export function createSampleStickerImage(size: number = 960): LoadedImageResult {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  if (!ctx) {
    throw new Error("Browser gagal membuat konteks kanvas contoh.");
  }

  // 1. Light-gray studio background (similar to exported mockups / screenshots)
  ctx.fillStyle = "#DFE2E8";
  ctx.fillRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2 + 20;

  // 2. White die-cut outer sticker border (#FFFFFF) that must stay intact
  ctx.save();
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath();
  ctx.arc(cx, cy - 10, size * 0.34, 0, Math.PI * 2);
  ctx.arc(cx - size * 0.16, cy - size * 0.27, size * 0.12, 0, Math.PI * 2);
  ctx.arc(cx + size * 0.16, cy - size * 0.27, size * 0.12, 0, Math.PI * 2);
  ctx.roundRect(cx - size * 0.28, cy + size * 0.14, size * 0.56, size * 0.21, 56);
  ctx.fill();
  ctx.restore();

  // 3. Cute character illustration with bold dark outline (#1E1E24)
  const outline = "#1E1E24";

  // Cat ears
  ctx.fillStyle = "#FCE7C8";
  ctx.strokeStyle = outline;
  ctx.lineWidth = 18;
  ctx.lineJoin = "round";

  ctx.beginPath();
  ctx.moveTo(cx - 175, cy - 130);
  ctx.lineTo(cx - 210, cy - 285);
  ctx.lineTo(cx - 65, cy - 210);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx + 175, cy - 130);
  ctx.lineTo(cx + 210, cy - 285);
  ctx.lineTo(cx + 65, cy - 210);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Head
  ctx.fillStyle = "#FCE7C8";
  ctx.beginPath();
  ctx.ellipse(cx, cy - 55, 200, 175, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Pastel beanie / hat (#C8A2C8)
  ctx.fillStyle = "#C8A2C8";
  ctx.beginPath();
  ctx.ellipse(cx, cy - 195, 130, 82, 0, Math.PI, Math.PI * 2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Hat brim (#A982AB)
  ctx.fillStyle = "#A982AB";
  ctx.beginPath();
  ctx.roundRect(cx - 142, cy - 212, 284, 44, 22);
  ctx.fill();
  ctx.stroke();

  // Star pin on hat (#FFD166)
  drawStar(ctx, cx + 68, cy - 228, 5, 32, 14, "#FFD166", outline, 10);

  // Scarf (#FF6B6B)
  ctx.fillStyle = "#FF6B6B";
  ctx.beginPath();
  ctx.roundRect(cx - 155, cy + 90, 310, 84, 34);
  ctx.fill();
  ctx.stroke();

  // Sunglasses frames (#1E1E24) + lenses (#56CFE1)
  ctx.fillStyle = "#56CFE1";
  ctx.lineWidth = 16;
  ctx.beginPath();
  ctx.roundRect(cx - 145, cy - 102, 118, 72, 24);
  ctx.roundRect(cx + 27, cy - 102, 118, 72, 24);
  ctx.fill();
  ctx.stroke();

  // Sunglasses bridge
  ctx.beginPath();
  ctx.moveTo(cx - 27, cy - 72);
  ctx.lineTo(cx + 27, cy - 72);
  ctx.stroke();

  // Smile
  ctx.lineWidth = 12;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(cx, cy + 10, 34, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();

  const imageData = ctx.getImageData(0, 0, size, size);

  return {
    kind: "raster",
    imageData,
    width: size,
    height: size,
    originalWidth: size,
    originalHeight: size,
    wasDownscaled: false,
    fileName: "contoh-stiker-kucing.png",
    fileSizeBytes: imageData.data.byteLength,
    mimeType: "image/png",
  };
}

function drawStar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  spikes: number,
  outerRadius: number,
  innerRadius: number,
  fill: string,
  stroke: string,
  lineWidth: number,
) {
  let rot = (Math.PI / 2) * 3;
  const step = Math.PI / spikes;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx, cy - outerRadius);

  for (let i = 0; i < spikes; i++) {
    ctx.lineTo(
      cx + Math.cos(rot) * outerRadius,
      cy + Math.sin(rot) * outerRadius,
    );
    rot += step;
    ctx.lineTo(
      cx + Math.cos(rot) * innerRadius,
      cy + Math.sin(rot) * innerRadius,
    );
    rot += step;
  }

  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = stroke;
  ctx.stroke();
  ctx.restore();
}

/**
 * Generates a synthetic 3D glossy/clay mascot render with radial highlights,
 * deep shadows, and a neutral white ceramic base to test Mode 3D recoloring.
 */
export function createSample3DRenderImage(size: number = 840): LoadedImageResult {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  if (!ctx) {
    throw new Error("Browser gagal membuat konteks kanvas 3D contoh.");
  }

  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2 + 24;

  // Soft drop shadow on transparent floor
  const floorShadow = ctx.createRadialGradient(
    cx,
    cy + 250,
    20,
    cx,
    cy + 250,
    220,
  );
  floorShadow.addColorStop(0, "rgba(15, 23, 42, 0.32)");
  floorShadow.addColorStop(1, "rgba(15, 23, 42, 0)");
  ctx.fillStyle = floorShadow;
  ctx.beginPath();
  ctx.ellipse(cx, cy + 250, 210, 44, 0, 0, Math.PI * 2);
  ctx.fill();

  // Neutral white/silver 3D clay base collar (tests neutral multiply/tint)
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(cx - 175, cy + 95, 350, 140, 70);
  const collarGrad = ctx.createRadialGradient(
    cx - 55,
    cy + 120,
    18,
    cx + 15,
    cy + 165,
    220,
  );
  collarGrad.addColorStop(0, "#FFFFFF");
  collarGrad.addColorStop(0.45, "#E2E8F0");
  collarGrad.addColorStop(0.85, "#94A3B8");
  collarGrad.addColorStop(1, "#64748B");
  ctx.fillStyle = collarGrad;
  ctx.fill();
  ctx.restore();

  // Glossy blue 3D clay head sphere
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy - 25, 195, 0, Math.PI * 2);
  const headGrad = ctx.createRadialGradient(
    cx - 72,
    cy - 105,
    18,
    cx + 10,
    cy - 10,
    240,
  );
  headGrad.addColorStop(0, "#E0F2FE");
  headGrad.addColorStop(0.25, "#38BDF8");
  headGrad.addColorStop(0.68, "#0284C7");
  headGrad.addColorStop(1, "#0C3559");
  ctx.fillStyle = headGrad;
  ctx.fill();

  // Specular glossy highlight oval
  ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
  ctx.beginPath();
  ctx.ellipse(cx - 75, cy - 115, 38, 22, -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Glossy coral-red 3D beanie hat
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy - 175, 142, 92, 0, Math.PI, Math.PI * 2);
  ctx.closePath();
  const hatGrad = ctx.createRadialGradient(
    cx - 48,
    cy - 235,
    12,
    cx,
    cy - 190,
    160,
  );
  hatGrad.addColorStop(0, "#FFE4E6");
  hatGrad.addColorStop(0.32, "#FB7185");
  hatGrad.addColorStop(0.75, "#E11D48");
  hatGrad.addColorStop(1, "#7F1D1D");
  ctx.fillStyle = hatGrad;
  ctx.fill();
  ctx.restore();

  // Glossy yellow/gold 3D star badge
  ctx.save();
  const starCx = cx + 62;
  const starCy = cy - 210;
  let rot = (Math.PI / 2) * 3;
  const step = Math.PI / 5;
  ctx.beginPath();
  ctx.moveTo(starCx, starCy - 44);
  for (let i = 0; i < 5; i++) {
    ctx.lineTo(starCx + Math.cos(rot) * 44, starCy + Math.sin(rot) * 44);
    rot += step;
    ctx.lineTo(starCx + Math.cos(rot) * 20, starCy + Math.sin(rot) * 20);
    rot += step;
  }
  ctx.closePath();
  const starGrad = ctx.createRadialGradient(
    starCx - 12,
    starCy - 14,
    4,
    starCx,
    starCy,
    48,
  );
  starGrad.addColorStop(0, "#FEF9C3");
  starGrad.addColorStop(0.4, "#FACC15");
  starGrad.addColorStop(1, "#A16207");
  ctx.fillStyle = starGrad;
  ctx.fill();
  ctx.restore();

  // Glossy dark visor/glasses
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(cx - 120, cy - 68, 240, 74, 37);
  const visorGrad = ctx.createLinearGradient(cx, cy - 68, cx, cy + 6);
  visorGrad.addColorStop(0, "#475569");
  visorGrad.addColorStop(0.35, "#1E293B");
  visorGrad.addColorStop(1, "#090D16");
  ctx.fillStyle = visorGrad;
  ctx.fill();
  ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
  ctx.beginPath();
  ctx.roundRect(cx - 95, cy - 58, 130, 14, 7);
  ctx.fill();
  ctx.restore();

  const imageData = ctx.getImageData(0, 0, size, size);

  return {
    kind: "raster",
    imageData,
    width: size,
    height: size,
    originalWidth: size,
    originalHeight: size,
    wasDownscaled: false,
    fileName: "contoh-maskot-3d.png",
    fileSizeBytes: imageData.data.byteLength,
    mimeType: "image/png",
  };
}
