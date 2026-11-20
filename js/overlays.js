import { MAT, MATERIALS } from "./materials.js";

export class OverlayRenderer {
  constructor(canvas, sim) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.sim = sim;
    this.enableSubpixel = true;

    this.cursor = {
      active: false,
      simX: 0,
      simY: 0,
      radius: 8,
      toolMode: "paint",
      matId: MAT.WATER,
    };
  }

  resize(width, height) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.max(1, Math.floor(width * dpr));
    const targetH = Math.max(1, Math.floor(height * dpr));
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
  }

  render(renderMode, splitX) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    const sx = W / this.sim.width;
    const sy = H / this.sim.height;
    const scale = Math.min(sx, sy);

    // In Classic mode, only draw the brush cursor reticle
    if (renderMode !== 3 && this.enableSubpixel) {
      ctx.save();
      // If in Split-Screen Compare mode, clip the sub-pixel continuum overlays to the right (100x Ultra) side!
      if (renderMode === 1) {
        const clipX = splitX * W;
        ctx.beginPath();
        ctx.rect(clipX, 0, W - clipX, H);
        ctx.clip();
      }

      this.renderBotanicalAndCritterDetails(ctx, sx, sy, scale);
      this.renderBubbles(ctx, sx, sy, scale);
      this.renderSparks(ctx, sx, sy, scale);
      this.renderShockwaves(ctx, sx, sy, scale);
      this.renderLightningArcs(ctx, sx, sy, scale);

      ctx.restore();
    }

    this.renderCursorReticle(ctx, sx, sy, scale);
  }

  renderBotanicalAndCritterDetails(ctx, sx, sy, scale) {
    const sim = this.sim;
    const sW = sim.width;
    const sH = sim.height;
    const tArr = sim.type;
    const mArr = sim.meta;
    const seedArr = sim.seed;
    const time = sim.tickCount * 0.05;

    // Scan for surface botanical blossoms, mushroom caps, and living mites
    for (let y = 2; y < sH - 2; y++) {
      const rowOffset = y * sW;
      for (let x = 2; x < sW - 2; x++) {
        const i = rowOffset + x;
        const id = tArr[i];

        if (id === MAT.MITE) {
          // Draw articulated glowing micro-critter with legs and firefly abdomen
          const px = (x + 0.5) * sx;
          const py = (y + 0.5) * sy;
          const dir = (mArr[i] & 1) === 0 ? 1 : -1;

          ctx.save();
          ctx.translate(px, py);
          // Firefly glow aura
          const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, scale * 3.2);
          grad.addColorStop(0, "rgba(254, 240, 138, 0.95)");
          grad.addColorStop(0.45, "rgba(245, 158, 11, 0.45)");
          grad.addColorStop(1, "rgba(245, 158, 11, 0)");
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(0, 0, scale * 3.2, 0, Math.PI * 2);
          ctx.fill();

          // Tiny legs & antennae
          ctx.strokeStyle = "rgba(254, 243, 199, 0.9)";
          ctx.lineWidth = Math.max(1, scale * 0.25);
          const legWiggle = Math.sin(time * 5 + x) * scale * 0.4;
          ctx.beginPath();
          ctx.moveTo(-scale * 0.8, 0);
          ctx.lineTo(-scale * 1.3, scale * 0.9 + legWiggle);
          ctx.moveTo(scale * 0.8, 0);
          ctx.lineTo(scale * 1.3, scale * 0.9 - legWiggle);
          // Antenna
          ctx.moveTo(dir * scale * 0.6, -scale * 0.3);
          ctx.lineTo(dir * scale * 1.5, -scale * 1.2 + legWiggle * 0.5);
          ctx.stroke();

          // Glowing thorax
          ctx.fillStyle = "#fef08a";
          ctx.beginPath();
          ctx.ellipse(0, 0, scale * 1.1, scale * 0.75, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        } else if (id === MAT.PLANT && mArr[i] === 99 && (seedArr[i] & 3) === 0) {
          // Blooming botanical flower with swaying petals on top of plant canopy
          if (tArr[i - sW] === MAT.EMPTY) {
            const px = (x + 0.5) * sx;
            const py = (y + 0.2) * sy;
            const wi = ((y >> 2) * sim.wWidth) + (x >> 2);
            const sway = Math.sin(time * 1.6 + x * 0.5) * 0.22 + (sim.windX[wi] || 0) * 0.08;
            const hue = (seedArr[i] % 2 === 0) ? "#f472b6" : "#fbbf24";

            ctx.save();
            ctx.translate(px + sway * scale * 2, py);
            ctx.fillStyle = hue;
            const r = scale * 1.15;
            for (let p = 0; p < 5; p++) {
              const ang = (p / 5) * Math.PI * 2 + sway;
              ctx.beginPath();
              ctx.arc(Math.cos(ang) * r * 0.75, Math.sin(ang) * r * 0.75, r * 0.55, 0, Math.PI * 2);
              ctx.fill();
            }
            ctx.fillStyle = "#fef08a";
            ctx.beginPath();
            ctx.arc(0, 0, r * 0.42, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        } else if (id === MAT.FUNGUS && (seedArr[i] & 15) === 0) {
          // Bioluminescent translucent mushroom cap on surface fungus cells
          if (tArr[i - sW] === MAT.EMPTY) {
            const px = (x + 0.5) * sx;
            const py = (y + 0.3) * sy;
            const isViolet = (seedArr[i] & 16) !== 0;
            const capRadius = scale * (1.2 + (seedArr[i] % 5) * 0.18);

            ctx.save();
            ctx.translate(px, py);
            ctx.fillStyle = isViolet
              ? "rgba(192, 132, 252, 0.78)"
              : "rgba(103, 232, 249, 0.78)";
            ctx.beginPath();
            ctx.arc(0, 0, capRadius, Math.PI, 0);
            ctx.fill();
            ctx.restore();
          }
        }
      }
    }
  }

  renderBubbles(ctx, sx, sy, scale) {
    const bubbles = this.sim.bubbles;
    if (!bubbles.length) return;

    ctx.save();
    for (let i = 0; i < bubbles.length; i++) {
      const b = bubbles[i];
      const px = b.x * sx;
      const py = b.y * sy;
      const r = b.radius * scale * 0.85;

      ctx.strokeStyle = b.color;
      ctx.lineWidth = Math.max(1, scale * 0.28);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.stroke();

      // Specular glint on top-left of bubble
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(px - r * 0.35, py - r * 0.35, Math.max(0.7, r * 0.25), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  renderSparks(ctx, sx, sy, scale) {
    const sparks = this.sim.sparks;
    if (!sparks.length) return;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";

    for (let i = 0; i < sparks.length; i++) {
      const s = sparks[i];
      const alpha = Math.max(0, s.life / s.maxLife);
      const x0 = s.ox * sx;
      const y0 = s.oy * sy;
      const x1 = s.x * sx;
      const y1 = s.y * sy;

      ctx.globalAlpha = alpha;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size * scale * 0.75;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    ctx.restore();
  }

  renderShockwaves(ctx, sx, sy, scale) {
    const waves = this.sim.shockwaves;
    if (!waves.length) return;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < waves.length; i++) {
      const sw = waves[i];
      const px = sw.x * sx;
      const py = sw.y * sy;
      const r = sw.radius * scale;

      ctx.globalAlpha = Math.max(0, sw.life * 0.65);
      ctx.strokeStyle = "#fde047";
      ctx.lineWidth = Math.max(1.5, scale * 1.4 * sw.life);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  renderLightningArcs(ctx, sx, sy, scale) {
    const arcs = this.sim.lightningArcs;
    if (!arcs.length) return;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const strokePath = (pts) => {
      if (pts.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(pts[0].x * sx, pts[0].y * sy);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x * sx, pts[i].y * sy);
      }
      ctx.stroke();
    };

    for (let i = 0; i < arcs.length; i++) {
      const arc = arcs[i];
      ctx.globalAlpha = Math.max(0, arc.life);

      // Outer electric bloom
      ctx.strokeStyle = "rgba(56, 189, 248, 0.55)";
      ctx.lineWidth = scale * 3.8;
      strokePath(arc.points);

      // Core plasma filament
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = scale * 1.25;
      strokePath(arc.points);

      // Branches
      ctx.strokeStyle = "rgba(125, 211, 252, 0.85)";
      ctx.lineWidth = scale * 0.9;
      for (let b = 0; b < arc.branches.length; b++) {
        strokePath(arc.branches[b]);
      }
    }
    ctx.restore();
  }

  renderCursorReticle(ctx, sx, sy, scale) {
    if (!this.cursor.active) return;

    const px = (this.cursor.simX + 0.5) * sx;
    const py = (this.cursor.simY + 0.5) * sy;
    const r = Math.max(scale * 0.8, this.cursor.radius * scale);

    ctx.save();
    let ringColor = "rgba(56, 189, 248, 0.85)";
    if (this.cursor.toolMode === "heat") ringColor = "rgba(251, 146, 60, 0.95)";
    else if (this.cursor.toolMode === "freeze") ringColor = "rgba(125, 211, 252, 0.95)";
    else if (this.cursor.toolMode === "erase") ringColor = "rgba(244, 63, 94, 0.9)";
    else if (this.cursor.toolMode === "wind") ringColor = "rgba(192, 132, 252, 0.9)";
    else if (MATERIALS[this.cursor.matId]) {
      const [cr, cg, cb] = MATERIALS[this.cursor.matId].color;
      ringColor = `rgba(${cr}, ${cg}, ${cb}, 0.92)`;
    }

    ctx.strokeStyle = ringColor;
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.stroke();

    // Inner precision crosshair dot
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(px, py, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
