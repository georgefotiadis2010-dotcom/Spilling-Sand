import { MAT, MATERIALS } from "./materials.js";

export class Simulation {
  constructor(width = 320, height = 200) {
    this.width = width;
    this.height = height;
    this.size = width * height;

    // Cellular state arrays
    this.type = new Uint8Array(this.size);
    this.meta = new Uint8Array(this.size);   // Material sub-variant / cloner memory / life timer
    this.seed = new Uint8Array(this.size);   // Persistent per-cell visual noise seed (0..255)
    this.temp = new Float32Array(this.size); // Continuous temperature in °C
    this.tempNext = new Float32Array(this.size);
    this.vx = new Float32Array(this.size);
    this.vy = new Float32Array(this.size);
    this.stamp = new Uint8Array(this.size);  // Tick parity stamp to prevent double-updates

    // Packed GPU upload buffer (RGBA8: R=type, G=seed, B=normalized temp, A=meta/life)
    this.gpuData = new Uint8Array(this.size * 4);

    // Coarse Navier-Stokes / Eulerian aerodynamic wind & vorticity grid (1/4 resolution)
    this.wWidth = Math.ceil(width / 4);
    this.wHeight = Math.ceil(height / 4);
    this.wSize = this.wWidth * this.wHeight;
    this.windX = new Float32Array(this.wSize);
    this.windY = new Float32Array(this.wSize);
    this.windXNext = new Float32Array(this.wSize);
    this.windYNext = new Float32Array(this.wSize);

    // Sub-pixel continuous visual entities (for "not just particles" high-DPI rendering)
    this.sparks = [];        // Glowing motion-blurred embers & splashes
    this.bubbles = [];       // Smooth refractive underwater bubbles & acid fizz
    this.lightningArcs = []; // Multi-branching vector plasma arcs
    this.shockwaves = [];    // Radial refractive blast waves

    // Undo history ring buffer
    this.undoStack = [];
    this.maxUndo = 10;

    // Simulation parameters
    this.tickCount = 0;
    this.gravity = 1.0;
    this.activeCellCount = 0;

    // Acoustic telemetry counters per frame (drives optional WebAudio synthesizer)
    this.audioEvents = {
      waterFlow: 0,
      fireCount: 0,
      lavaCount: 0,
      sizzle: 0,
      explosion: 0,
      lightning: 0,
      acidFizz: 0,
    };

    this.clear();
  }

  idx(x, y) {
    return y * this.width + x;
  }

  inBounds(x, y) {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  saveUndoSnapshot() {
    this.undoStack.push({
      type: new Uint8Array(this.type),
      meta: new Uint8Array(this.meta),
      seed: new Uint8Array(this.seed),
      temp: new Float32Array(this.temp),
    });
    if (this.undoStack.length > this.maxUndo) {
      this.undoStack.shift();
    }
  }

  popUndoSnapshot() {
    const snap = this.undoStack.pop();
    if (!snap) return false;
    this.type.set(snap.type);
    this.meta.set(snap.meta);
    this.seed.set(snap.seed);
    this.temp.set(snap.temp);
    this.vx.fill(0);
    this.vy.fill(0);
    this.packGPUData();
    return true;
  }

  clear() {
    this.type.fill(MAT.EMPTY);
    this.meta.fill(0);
    this.temp.fill(22);
    this.vx.fill(0);
    this.vy.fill(0);
    this.windX.fill(0);
    this.windY.fill(0);
    for (let i = 0; i < this.size; i++) {
      this.seed[i] = (Math.random() * 255) | 0;
    }
    this.sparks.length = 0;
    this.bubbles.length = 0;
    this.lightningArcs.length = 0;
    this.shockwaves.length = 0;
    this.packGPUData();
  }

  setCell(x, y, matId, customMeta = 0, customTemp = null) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const i = y * this.width + x;
    const mat = MATERIALS[matId] || MATERIALS[MAT.EMPTY];
    this.type[i] = matId;
    this.seed[i] = (Math.random() * 255) | 0;
    this.temp[i] = customTemp !== null ? customTemp : mat.defaultTemp;
    this.vx[i] = 0;
    this.vy[i] = 0;

    if (matId === MAT.FIRE) {
      this.meta[i] = customMeta || (45 + ((Math.random() * 55) | 0));
    } else if (matId === MAT.SMOKE || matId === MAT.STEAM) {
      this.meta[i] = customMeta || (90 + ((Math.random() * 90) | 0));
    } else if (matId === MAT.LIGHTNING) {
      this.meta[i] = 10;
    } else {
      this.meta[i] = customMeta;
    }
  }

  swapCells(i, j) {
    const t = this.type[i];
    this.type[i] = this.type[j];
    this.type[j] = t;

    const m = this.meta[i];
    this.meta[i] = this.meta[j];
    this.meta[j] = m;

    const s = this.seed[i];
    this.seed[i] = this.seed[j];
    this.seed[j] = s;

    const tp = this.temp[i];
    this.temp[i] = this.temp[j];
    this.temp[j] = tp;

    const vx = this.vx[i];
    this.vx[i] = this.vx[j];
    this.vx[j] = vx;

    const vy = this.vy[i];
    this.vy[i] = this.vy[j];
    this.vy[j] = vy;

    const parity = this.tickCount & 1;
    this.stamp[i] = parity;
    this.stamp[j] = parity;
  }

  // Inject wind velocity at grid coordinates
  addWindImpulse(x, y, dx, dy, radius = 14) {
    const wxCenter = (x / 4) | 0;
    const wyCenter = (y / 4) | 0;
    const wRad = Math.max(2, (radius / 3) | 0);
    for (let dyOff = -wRad; dyOff <= wRad; dyOff++) {
      const wy = wyCenter + dyOff;
      if (wy < 0 || wy >= this.wHeight) continue;
      for (let dxOff = -wRad; dxOff <= wRad; dxOff++) {
        const wx = wxCenter + dxOff;
        if (wx < 0 || wx >= this.wWidth) continue;
        const d2 = dxOff * dxOff + dyOff * dyOff;
        if (d2 > wRad * wRad) continue;
        const falloff = 1 - Math.sqrt(d2) / (wRad + 0.5);
        const wi = wy * this.wWidth + wx;
        this.windX[wi] = Math.max(-18, Math.min(18, this.windX[wi] + dx * falloff));
        this.windY[wi] = Math.max(-18, Math.min(18, this.windY[wi] + dy * falloff));
      }
    }
  }

  // Paint brush stroke with interpolation between (x0, y0) and (x1, y1)
  applyBrushSegment(x0, y0, x1, y1, radius, toolMode, matId) {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, radius * 0.35)));
    const vxStroke = (x1 - x0) * 0.35;
    const vyStroke = (y1 - y0) * 0.35;

    for (let s = 0; s <= steps; s++) {
      const t = steps === 0 ? 1 : s / steps;
      const cx = Math.round(x0 + (x1 - x0) * t);
      const cy = Math.round(y0 + (y1 - y0) * t);
      this.applyBrushAt(cx, cy, radius, toolMode, matId, vxStroke, vyStroke);
    }
  }

  applyBrushAt(cx, cy, radius, toolMode, matId, vxStroke = 0, vyStroke = 0) {
    this.addWindImpulse(cx, cy, vxStroke * 0.6, vyStroke * 0.6, radius);

    if (toolMode === "wind") {
      this.addWindImpulse(cx, cy, vxStroke * 2.2, vyStroke * 2.2, radius * 1.8);
      // Also push movable particles directly
      const r = Math.ceil(radius * 1.5);
      for (let dy = -r; dy <= r; dy++) {
        const y = cy + dy;
        if (y <= 1 || y >= this.height - 2) continue;
        for (let dx = -r; dx <= r; dx++) {
          const x = cx + dx;
          if (x <= 1 || x >= this.width - 2) continue;
          if (dx * dx + dy * dy > r * r) continue;
          const i = y * this.width + x;
          const id = this.type[i];
          if (id !== MAT.EMPTY && id !== MAT.WALL && id !== MAT.CLONER) {
            const tx = Math.max(1, Math.min(this.width - 2, Math.round(x + vxStroke * 0.45)));
            const ty = Math.max(1, Math.min(this.height - 2, Math.round(y + vyStroke * 0.45)));
            const ti = ty * this.width + tx;
            if (this.type[ti] === MAT.EMPTY) {
              this.swapCells(i, ti);
            }
          }
        }
      }
      return;
    }

    if (toolMode === "paint" && matId === MAT.LIGHTNING) {
      if (Math.random() < 0.45) {
        this.triggerLightningBolt(cx, cy);
      }
      return;
    }

    const r2 = radius * radius;
    const isGranularOrFluid =
      matId === MAT.SAND ||
      matId === MAT.SNOW ||
      matId === MAT.GUNPOWDER ||
      matId === MAT.SEED ||
      matId === MAT.WATER ||
      matId === MAT.OIL ||
      matId === MAT.LAVA ||
      matId === MAT.ACID ||
      matId === MAT.FIRE ||
      matId === MAT.GAS ||
      matId === MAT.STEAM ||
      matId === MAT.SMOKE ||
      matId === MAT.MITE;

    for (let dy = -radius; dy <= radius; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= this.height) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= this.width) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const i = y * this.width + x;

        if (toolMode === "erase") {
          this.setCell(x, y, MAT.EMPTY);
        } else if (toolMode === "heat") {
          const falloff = 1 - Math.sqrt(d2) / (radius + 1);
          this.temp[i] = Math.min(3000, this.temp[i] + 190 * falloff);
          if (Math.random() < 0.04 * falloff) {
            this.spawnSpark(x, y, (Math.random() - 0.5) * 1.5, -Math.random() * 1.8, "#ff9e44", 18);
          }
        } else if (toolMode === "freeze") {
          const falloff = 1 - Math.sqrt(d2) / (radius + 1);
          this.temp[i] = Math.max(-180, this.temp[i] - 120 * falloff);
        } else if (toolMode === "paint") {
          if (matId === MAT.MITE && Math.random() > 0.08) continue;
          if (matId === MAT.SEED && Math.random() > 0.14) continue;
          if (isGranularOrFluid && radius > 2 && Math.random() > 0.62) continue;

          // Don't overwrite solid walls with soft fluids unless painting Wall/Empty/Void
          const cur = this.type[i];
          if (
            cur !== MAT.EMPTY &&
            isGranularOrFluid &&
            (cur === MAT.WALL || cur === MAT.STONE || cur === MAT.WOOD || cur === MAT.GLASS || cur === MAT.GOLD)
          ) {
            continue;
          }
          this.setCell(x, y, matId);
        }
      }
    }
  }

  spawnSpark(x, y, vx, vy, color = "#ffaa33", life = 26, size = 1.6) {
    if (this.sparks.length > 420) return;
    this.sparks.push({ x, y, ox: x, oy: y, vx, vy, color, life, maxLife: life, size });
  }

  spawnBubble(x, y, color = "rgba(185, 240, 255, 0.75)", radius = 1.4) {
    if (this.bubbles.length > 260) return;
    this.bubbles.push({
      x,
      y,
      vx: (Math.random() - 0.5) * 0.25,
      vy: -0.45 - Math.random() * 0.35,
      radius,
      color,
      life: 45 + ((Math.random() * 35) | 0),
    });
  }

  triggerExplosion(cx, cy, radius = 14) {
    this.audioEvents.explosion += 1;
    this.shockwaves.push({
      x: cx,
      y: cy,
      radius: 1,
      maxRadius: radius * 2.6,
      life: 1.0,
    });

    const r2 = radius * radius;
    for (let dy = -radius; dy <= radius; dy++) {
      const y = cy + dy;
      if (y < 1 || y >= this.height - 1) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        if (x < 1 || x >= this.width - 1) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const i = y * this.width + x;
        const id = this.type[i];
        if (id === MAT.WALL || id === MAT.VOID) continue;

        const dist = Math.sqrt(d2);
        const norm = 1 - dist / (radius + 0.5);
        this.temp[i] += 1400 * norm;

        if (dist < radius * 0.65) {
          this.setCell(x, y, Math.random() < 0.72 ? MAT.FIRE : MAT.SMOKE, 0, 1400);
        } else if (Math.random() < 0.55) {
          if (id === MAT.SAND) {
            this.setCell(x, y, MAT.GLASS, 0, 900);
          } else {
            this.setCell(x, y, MAT.FIRE, 0, 950);
          }
        }
      }
    }

    // Sub-pixel supersonic ember burst
    for (let k = 0; k < 36; k++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 1.2 + Math.random() * 3.8;
      this.spawnSpark(
        cx,
        cy,
        Math.cos(ang) * spd,
        Math.sin(ang) * spd,
        k % 3 === 0 ? "#ffffff" : k % 2 === 0 ? "#fde047" : "#fb923c",
        24 + ((Math.random() * 24) | 0),
        2.1
      );
    }

    this.addWindImpulse(cx, cy, 0, -6, radius * 2);
  }

  triggerLightningBolt(startX, startY) {
    this.audioEvents.lightning += 1;
    const points = [{ x: startX, y: startY }];
    let cx = startX;
    let cy = startY;
    const branches = [];

    for (let step = 0; step < 36; step++) {
      cx += (Math.random() - 0.5) * 9;
      cy += 3.5 + Math.random() * 4.5;
      cx = Math.max(2, Math.min(this.width - 3, cx));
      cy = Math.max(2, Math.min(this.height - 3, cy));
      points.push({ x: cx, y: cy });

      const ix = cx | 0;
      const iy = cy | 0;
      const idx = iy * this.width + ix;
      const hit = this.type[idx];

      // Paint brief plasma cells along the path so the WebGL GI shader illuminates the cavern!
      for (let by = -1; by <= 1; by++) {
        for (let bx = -1; bx <= 1; bx++) {
          const px = ix + bx;
          const py = iy + by;
          if (!this.inBounds(px, py)) continue;
          const pi = py * this.width + px;
          this.temp[pi] = Math.max(this.temp[pi], 2200);
          if (this.type[pi] === MAT.EMPTY) {
            this.setCell(px, py, MAT.LIGHTNING, 8, 2400);
          }
        }
      }

      // Branch occasionally
      if (Math.random() < 0.28 && branches.length < 4) {
        const bPts = [{ x: cx, y: cy }];
        let bx = cx;
        let by = cy;
        const dir = Math.random() < 0.5 ? -1 : 1;
        for (let b = 0; b < 8; b++) {
          bx += dir * (2 + Math.random() * 4);
          by += 2 + Math.random() * 3.5;
          bPts.push({ x: bx, y: by });
        }
        branches.push(bPts);
      }

      if (hit !== MAT.EMPTY && hit !== MAT.LIGHTNING && hit !== MAT.SMOKE && hit !== MAT.STEAM) {
        // Impact reaction!
        if (hit === MAT.SAND) {
          // Vitrify sand into branching Fulgurite Glass!
          for (let ry = -4; ry <= 4; ry++) {
            for (let rx = -4; rx <= 4; rx++) {
              if (rx * rx + ry * ry > 18) continue;
              const tx = ix + rx;
              const ty = iy + ry;
              if (!this.inBounds(tx, ty)) continue;
              const ti = ty * this.width + tx;
              if (this.type[ti] === MAT.SAND) {
                this.setCell(tx, ty, MAT.GLASS, 0, 1100);
              }
            }
          }
        } else if (hit === MAT.GUNPOWDER || hit === MAT.GAS || hit === MAT.OIL) {
          this.triggerExplosion(ix, iy, 15);
        } else if (hit === MAT.WATER) {
          // Electrify pool & boil surface splash
          for (let k = 0; k < 14; k++) {
            this.spawnSpark(ix, iy, (Math.random() - 0.5) * 3, -1 - Math.random() * 2.5, "#7dd3fc", 18);
          }
        }
        for (let k = 0; k < 18; k++) {
          this.spawnSpark(
            ix,
            iy,
            (Math.random() - 0.5) * 3.4,
            -0.8 - Math.random() * 2.8,
            k % 2 === 0 ? "#e0f2fe" : "#38bdf8",
            20
          );
        }
        break;
      }
    }

    this.lightningArcs.push({
      points,
      branches,
      life: 1.0,
    });
  }

  updateWindField() {
    const wW = this.wWidth;
    const wH = this.wHeight;
    for (let y = 0; y < wH; y++) {
      for (let x = 0; x < wW; x++) {
        const i = y * wW + x;
        let sx = this.windX[i] * 0.56;
        let sy = this.windY[i] * 0.56;
        let neighbors = 0;
        if (x > 0) {
          sx += this.windX[i - 1] * 0.1;
          sy += this.windY[i - 1] * 0.1;
          neighbors++;
        }
        if (x < wW - 1) {
          sx += this.windX[i + 1] * 0.1;
          sy += this.windY[i + 1] * 0.1;
          neighbors++;
        }
        if (y > 0) {
          sx += this.windX[i - wW] * 0.1;
          sy += this.windY[i - wW] * 0.1;
          neighbors++;
        }
        if (y < wH - 1) {
          sx += this.windX[i + wW] * 0.1;
          sy += this.windY[i + wW] * 0.1;
          neighbors++;
        }
        this.windXNext[i] = sx * 0.96;
        this.windYNext[i] = sy * 0.96;
      }
    }
    this.windX.set(this.windXNext);
    this.windY.set(this.windYNext);
  }

  step() {
    this.tickCount++;
    const parity = this.tickCount & 1;
    const W = this.width;
    const H = this.height;

    // Reset frame acoustic telemetry
    this.audioEvents.waterFlow = 0;
    this.audioEvents.fireCount = 0;
    this.audioEvents.lavaCount = 0;
    this.audioEvents.sizzle = 0;
    this.audioEvents.acidFizz = 0;

    this.updateWindField();

    const gDir = this.gravity >= 0 ? 1 : -1;
    let activeCount = 0;

    // Scan bottom-to-top (or top-to-bottom if negative gravity) with alternating X scan
    const yStart = gDir >= 0 ? H - 1 : 0;
    const yEnd = gDir >= 0 ? -1 : H;
    const yStep = gDir >= 0 ? -1 : 1;

    for (let y = yStart; y !== yEnd; y += yStep) {
      const leftToRight = ((y + this.tickCount) & 1) === 0;
      const xStart = leftToRight ? 0 : W - 1;
      const xEnd = leftToRight ? W : -1;
      const xStep = leftToRight ? 1 : -1;

      for (let x = xStart; x !== xEnd; x += xStep) {
        const i = y * W + x;
        const id = this.type[i];

        // Passive thermal relaxation toward room temperature (22°C)
        const curTemp = this.temp[i];
        if (id === MAT.EMPTY) {
          this.temp[i] = curTemp + (22 - curTemp) * 0.04;
          continue;
        }

        activeCount++;
        if (this.stamp[i] === parity) continue;
        this.stamp[i] = parity;

        // Thermal diffusion with random cardinal neighbor
        const nDir = (this.tickCount + x + y) & 3;
        const nx = x + (nDir === 0 ? 1 : nDir === 1 ? -1 : 0);
        const ny = y + (nDir === 2 ? 1 : nDir === 3 ? -1 : 0);
        if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
          const ni = ny * W + nx;
          const nid = this.type[ni];
          const cond = id === MAT.GOLD || nid === MAT.GOLD ? 0.35 : 0.08;
          const avg = (this.temp[i] + this.temp[ni]) * 0.5;
          this.temp[i] += (avg - this.temp[i]) * cond;
          this.temp[ni] += (avg - this.temp[ni]) * cond;
        }

        // Local wind sample
        const wi = ((y >> 2) * this.wWidth) + (x >> 2);
        const wx = this.windX[wi] || 0;

        // Dispatch element behavior
        switch (id) {
          case MAT.SAND:
          case MAT.SNOW:
          case MAT.GUNPOWDER:
          case MAT.SEED:
            this.updateGranular(x, y, i, id, gDir, wx);
            break;

          case MAT.WATER:
          case MAT.OIL:
          case MAT.LAVA:
          case MAT.ACID:
            this.updateFluid(x, y, i, id, gDir, wx);
            break;

          case MAT.FIRE:
          case MAT.SMOKE:
          case MAT.STEAM:
          case MAT.GAS:
          case MAT.LIGHTNING:
            this.updateVolumetric(x, y, i, id, gDir, wx);
            break;

          case MAT.PLANT:
          case MAT.FUNGUS:
          case MAT.WOOD:
          case MAT.ICE:
          case MAT.STONE:
          case MAT.GOLD:
          case MAT.GLASS:
            this.updateSolidOrOrganic(x, y, i, id, gDir);
            break;

          case MAT.MITE:
            this.updateMite(x, y, i);
            break;

          case MAT.CLONER:
            this.updateCloner(x, y, i);
            break;

          case MAT.VOID:
            this.updateVoid(x, y, i);
            break;
        }
      }
    }

    this.activeCellCount = activeCount;
    this.updateSubpixelEntities();
    this.packGPUData();
  }

  canDisplace(moverId, targetId) {
    if (targetId === MAT.EMPTY) return true;
    if (
      targetId === MAT.WALL ||
      targetId === MAT.STONE ||
      targetId === MAT.WOOD ||
      targetId === MAT.ICE ||
      targetId === MAT.GLASS ||
      targetId === MAT.GOLD ||
      targetId === MAT.PLANT ||
      targetId === MAT.FUNGUS ||
      targetId === MAT.CLONER ||
      targetId === MAT.VOID
    ) {
      return false;
    }
    return MATERIALS[moverId].density > MATERIALS[targetId].density;
  }

  updateGranular(x, y, i, id, gDir, wx) {
    const W = this.width;
    const H = this.height;
    const t = this.temp[i];

    // Phase transitions
    if (id === MAT.SAND && t > 850) {
      // Vitrify superheated Sand into refractive Glass!
      this.setCell(x, y, MAT.GLASS, 0, t);
      return;
    }
    if (id === MAT.SNOW && t > 4) {
      this.setCell(x, y, MAT.WATER, 0, 2);
      return;
    }
    if (id === MAT.GUNPOWDER && t > 320) {
      this.triggerExplosion(x, y, 13);
      return;
    }

    // Seed germination when touching moist or fertile substrate
    if (id === MAT.SEED) {
      if (t > 280) {
        this.setCell(x, y, MAT.FIRE, 40, 600);
        return;
      }
      if (y + 1 < H) {
        const below = this.type[(y + 1) * W + x];
        if (
          below === MAT.SAND ||
          below === MAT.WOOD ||
          below === MAT.PLANT ||
          below === MAT.STONE
        ) {
          // Sprout into an upward-growing botanical stem!
          this.setCell(x, y, MAT.PLANT, 18 + ((Math.random() * 16) | 0), 22);
          return;
        }
      }
    }

    // Snow flutters with wind
    const windDrift = id === MAT.SNOW && Math.random() < 0.45
      ? Math.sign(wx + (Math.random() - 0.5) * 0.8)
      : Math.abs(wx) > 1.5 && Math.random() < 0.25
      ? Math.sign(wx)
      : 0;

    const ny = y + gDir;
    if (ny >= 0 && ny < H) {
      const bx = Math.max(0, Math.min(W - 1, x + windDrift));
      const bi = ny * W + bx;
      if (this.canDisplace(id, this.type[bi])) {
        this.swapCells(i, bi);
        return;
      }

      // Diagonal slide
      const dir1 = Math.random() < 0.5 ? -1 : 1;
      const dir2 = -dir1;
      const x1 = x + dir1;
      if (x1 >= 0 && x1 < W && this.canDisplace(id, this.type[ny * W + x1])) {
        this.swapCells(i, ny * W + x1);
        return;
      }
      const x2 = x + dir2;
      if (x2 >= 0 && x2 < W && this.canDisplace(id, this.type[ny * W + x2])) {
        this.swapCells(i, ny * W + x2);
        return;
      }
    }
  }

  updateFluid(x, y, i, id, gDir, wx) {
    const W = this.width;
    const H = this.height;
    const t = this.temp[i];

    if (id === MAT.WATER) {
      if (t > 105) {
        this.setCell(x, y, MAT.STEAM, 110, 120);
        this.audioEvents.sizzle++;
        return;
      }
      if (t < -6 && Math.random() < 0.08) {
        this.setCell(x, y, MAT.ICE, 0, -12);
        return;
      }
    } else if (id === MAT.OIL) {
      if (t > 240) {
        this.setCell(x, y, MAT.FIRE, 75, 880);
        if (Math.random() < 0.25) {
          this.spawnSpark(x, y, (Math.random() - 0.5) * 2, -1.5, "#fb923c", 22);
        }
        return;
      }
    } else if (id === MAT.LAVA) {
      this.audioEvents.lavaCount++;
      this.temp[i] = Math.max(this.temp[i], 1250);
      if (t < 650) {
        this.setCell(x, y, MAT.STONE, 0, 500);
        return;
      }
      // Occasional incandescent magma spark
      if (Math.random() < 0.0025 && y > 1 && this.type[(y - 1) * W + x] === MAT.EMPTY) {
        this.spawnSpark(
          x,
          y - 1,
          (Math.random() - 0.5) * 1.4,
          -0.9 - Math.random() * 1.4,
          Math.random() < 0.5 ? "#fef08a" : "#ff5500",
          28,
          1.5
        );
      }

      // Check neighbors for water quenching or flammability
      const dirs = [
        [0, -1],
        [0, 1],
        [-1, 0],
        [1, 0],
      ];
      for (let d = 0; d < 4; d++) {
        const nx = x + dirs[d][0];
        const ny = y + dirs[d][1];
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const ni = ny * W + nx;
        const nid = this.type[ni];
        if (nid === MAT.WATER || nid === MAT.ICE || nid === MAT.SNOW) {
          this.setCell(x, y, MAT.STONE, 0, 420);
          this.setCell(nx, ny, MAT.STEAM, 120, 160);
          this.audioEvents.sizzle += 2;
          this.spawnSpark(x, y, (Math.random() - 0.5) * 2, -1.5, "#fde047", 18);
          return;
        } else if (nid === MAT.SAND && Math.random() < 0.05) {
          this.setCell(nx, ny, MAT.GLASS, 0, 950);
        } else if (MATERIALS[nid] && MATERIALS[nid].flammable > 0 && Math.random() < 0.18) {
          this.temp[ni] += 550;
        }
      }
    } else if (id === MAT.ACID) {
      // Acid corrodes adjacent materials
      if (Math.random() < 0.004 && y > 1 && this.type[(y - 1) * W + x] === MAT.EMPTY) {
        this.spawnBubble(x, y, "rgba(134, 239, 172, 0.85)", 1.3);
      }
      const nDir = (this.tickCount + x * 3 + y) & 3;
      const nx = x + (nDir === 0 ? 1 : nDir === 1 ? -1 : 0);
      const ny = y + (nDir === 2 ? 1 : nDir === 3 ? -1 : 0);
      if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
        const ni = ny * W + nx;
        const nid = this.type[ni];
        if (
          nid !== MAT.EMPTY &&
          nid !== MAT.ACID &&
          nid !== MAT.WALL &&
          nid !== MAT.GLASS &&
          nid !== MAT.CLONER &&
          nid !== MAT.VOID
        ) {
          if (Math.random() < 0.09) {
            this.audioEvents.acidFizz++;
            this.setCell(nx, ny, MAT.GAS, 60, 45);
            if (Math.random() < 0.65) {
              this.setCell(x, y, MAT.SMOKE, 50, 50);
            }
            this.spawnBubble(nx, ny, "rgba(74, 222, 128, 0.9)", 1.6);
            return;
          }
        }
      }
    }

    // Fluid kinematics: fall down, slide diagonally, or disperse horizontally
    const ny = y + gDir;
    const viscositySkip = id === MAT.LAVA && (this.tickCount & 1) === 1;
    if (!viscositySkip && ny >= 0 && ny < H) {
      const bi = ny * W + x;
      if (this.canDisplace(id, this.type[bi])) {
        this.swapCells(i, bi);
        if (id === MAT.WATER) {
          this.audioEvents.waterFlow++;
          if (Math.random() < 0.015) {
            this.spawnBubble(x, ny, "rgba(224, 242, 254, 0.72)", 1.2);
          }
        }
        return;
      }

      const dir = Math.random() < 0.5 ? -1 : 1;
      for (const s of [dir, -dir]) {
        const dx = x + s;
        if (dx >= 0 && dx < W && this.canDisplace(id, this.type[ny * W + dx])) {
          this.swapCells(i, ny * W + dx);
          if (id === MAT.WATER) this.audioEvents.waterFlow++;
          return;
        }
      }
    }

    // Horizontal leveling / dispersion (higher reach for water/oil, lower for viscous lava)
    const maxSpread = id === MAT.LAVA ? 2 : id === MAT.OIL ? 5 : 6;
    const prefDir = Math.abs(wx) > 0.6 ? Math.sign(wx) : Math.random() < 0.5 ? -1 : 1;
    for (const dir of [prefDir, -prefDir]) {
      let targetX = -1;
      for (let step = 1; step <= maxSpread; step++) {
        const tx = x + dir * step;
        if (tx < 0 || tx >= W) break;
        const tid = this.type[y * W + tx];
        if (this.canDisplace(id, tid)) {
          targetX = tx;
        } else {
          break;
        }
      }
      if (targetX !== -1) {
        this.swapCells(i, y * W + targetX);
        return;
      }
    }
  }

  updateVolumetric(x, y, i, id, gDir, wx) {
    const W = this.width;
    const H = this.height;

    if (id === MAT.LIGHTNING) {
      if (this.meta[i] <= 1) {
        this.setCell(x, y, MAT.EMPTY);
      } else {
        this.meta[i]--;
      }
      return;
    }

    if (id === MAT.FIRE) {
      this.audioEvents.fireCount++;
      this.temp[i] = Math.max(this.temp[i], 750);
      // Upward thermal draft in wind grid
      const wi = ((y >> 2) * this.wWidth) + (x >> 2);
      this.windY[wi] = Math.max(-6, this.windY[wi] - 0.12);

      // Ignite or heat neighbors
      const nDir = (this.tickCount + x + y * 3) & 3;
      const nx = x + (nDir === 0 ? 1 : nDir === 1 ? -1 : 0);
      const ny = y + (nDir === 2 ? 1 : nDir === 3 ? -1 : 0);
      if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
        const ni = ny * W + nx;
        const nid = this.type[ni];
        this.temp[ni] += 85;
        if (nid === MAT.WATER) {
          this.setCell(x, y, MAT.STEAM, 80, 120);
          this.audioEvents.sizzle++;
          return;
        } else if (nid === MAT.GUNPOWDER) {
          this.triggerExplosion(nx, ny, 14);
          return;
        } else if (nid === MAT.GAS) {
          this.setCell(nx, ny, MAT.FIRE, 65, 980);
          if (Math.random() < 0.25) {
            this.triggerExplosion(nx, ny, 8);
          }
        } else if (MATERIALS[nid] && MATERIALS[nid].flammable > 0) {
          if (Math.random() * 100 < MATERIALS[nid].flammable) {
            this.setCell(nx, ny, MAT.FIRE, 65, 820);
            if (Math.random() < 0.12) {
              this.spawnSpark(nx, ny, (Math.random() - 0.5) * 1.5, -1.5, "#fb923c", 22);
            }
          }
        }
      }

      if (this.meta[i] <= 1) {
        this.setCell(x, y, Math.random() < 0.28 ? MAT.SMOKE : MAT.EMPTY, 75, 180);
        return;
      }
      this.meta[i]--;
    } else if (id === MAT.SMOKE || id === MAT.STEAM) {
      if (this.meta[i] <= 1) {
        if (id === MAT.STEAM && (y < 14 || this.temp[i] < 55) && Math.random() < 0.38) {
          this.setCell(x, y, MAT.WATER, 0, 24);
        } else {
          this.setCell(x, y, MAT.EMPTY);
        }
        return;
      }
      this.meta[i]--;
    } else if (id === MAT.GAS) {
      if (this.temp[i] > 280) {
        this.setCell(x, y, MAT.FIRE, 55, 950);
        return;
      }
    }

    // Buoyant upward rise + turbulent curl
    const riseY = y - gDir;
    const jitter = Math.round(wx * 0.4 + (Math.random() - 0.5) * 2.2);
    const tx = Math.max(0, Math.min(W - 1, x + Math.sign(jitter)));
    const ty = id === MAT.GAS && Math.random() < 0.45 ? y : riseY;

    if (ty >= 0 && ty < H) {
      const ti = ty * W + tx;
      const tid = this.type[ti];
      if (tid === MAT.EMPTY || (id === MAT.FIRE && (tid === MAT.SMOKE || tid === MAT.GAS))) {
        this.swapCells(i, ti);
      }
    }
  }

  updateSolidOrOrganic(x, y, i, id, gDir) {
    const W = this.width;
    const H = this.height;
    const t = this.temp[i];

    if (id === MAT.STONE && t > 1180) {
      this.setCell(x, y, MAT.LAVA, 0, 1300);
      return;
    }
    if (id === MAT.ICE) {
      this.temp[i] = Math.min(this.temp[i], -10);
      if (t > 3) {
        this.setCell(x, y, MAT.WATER, 0, 1);
        return;
      }
      // Chill & freeze adjacent water
      if (Math.random() < 0.015) {
        const nDir = (this.tickCount + x + y) & 3;
        const nx = x + (nDir === 0 ? 1 : nDir === 1 ? -1 : 0);
        const ny = y + (nDir === 2 ? 1 : nDir === 3 ? -1 : 0);
        if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
          const ni = ny * W + nx;
          if (this.type[ni] === MAT.WATER && this.temp[ni] < 0) {
            this.setCell(nx, ny, MAT.ICE, 0, -10);
          }
        }
      }
      return;
    }

    if (id === MAT.WOOD && t > 360) {
      this.setCell(x, y, MAT.FIRE, 85, 800);
      return;
    }

    if (id === MAT.PLANT) {
      if (t > 260) {
        this.setCell(x, y, MAT.FIRE, 55, 720);
        return;
      }
      // Drink adjacent water to grow lush foliage!
      const nDir = (this.tickCount + x * 5 + y) & 3;
      const nx = x + (nDir === 0 ? 1 : nDir === 1 ? -1 : 0);
      const ny = y + (nDir === 2 ? 1 : nDir === 3 ? -1 : 0);
      if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
        const ni = ny * W + nx;
        if (this.type[ni] === MAT.WATER) {
          this.setCell(nx, ny, MAT.PLANT, Math.min(30, this.meta[i] + 4), 22);
          return;
        }
      }
      // Procedural upward shoot growth if meta > 0
      if (this.meta[i] > 0 && Math.random() < 0.14) {
        const gx = x + (Math.random() < 0.35 ? (Math.random() < 0.5 ? -1 : 1) : 0);
        const gy = y - gDir;
        if (gx >= 0 && gx < W && gy >= 0 && gy < H) {
          const gi = gy * W + gx;
          if (this.type[gi] === MAT.EMPTY) {
            const nextEnergy = this.meta[i] - 1;
            this.meta[i] = 0;
            // meta=99 denotes a blooming flower bud at the tip!
            this.setCell(gx, gy, MAT.PLANT, nextEnergy === 0 ? 99 : nextEnergy, 22);
          }
        }
      }
      return;
    }

    if (id === MAT.FUNGUS) {
      if (t > 240) {
        this.setCell(x, y, MAT.FIRE, 45, 680);
        return;
      }
      // Bioluminescent fungus slowly colonizes damp wood/plant or sprouts small caps
      if (Math.random() < 0.015) {
        const dx = ((Math.random() * 3) | 0) - 1;
        const dy = ((Math.random() * 3) | 0) - 1;
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
          const ni = ny * W + nx;
          const nid = this.type[ni];
          if (nid === MAT.WATER || (nid === MAT.PLANT && Math.random() < 0.35)) {
            this.setCell(nx, ny, MAT.FUNGUS, (Math.random() * 255) | 0, 20);
          }
        }
      }
    }
  }

  updateMite(x, y, i) {
    const W = this.width;
    const H = this.height;
    if (this.temp[i] > 140) {
      this.setCell(x, y, MAT.FIRE, 25, 600);
      return;
    }

    // Mites crawl or hop along surfaces
    const dir = (this.meta[i] & 1) === 0 ? 1 : -1;
    const belowY = Math.min(H - 1, y + 1);
    const hasFloor = this.type[belowY * W + x] !== MAT.EMPTY;

    if (!hasFloor && Math.random() < 0.82) {
      // Fall gently
      const bi = belowY * W + x;
      if (this.type[bi] === MAT.EMPTY) {
        this.swapCells(i, bi);
        return;
      }
    }

    const dx = Math.random() < 0.85 ? dir : -dir;
    const dy = hasFloor && Math.random() < 0.32 ? -1 : Math.random() < 0.4 ? 1 : 0;
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 1 && nx < W - 1 && ny >= 1 && ny < H - 1) {
      const ni = ny * W + nx;
      const nid = this.type[ni];
      if (nid === MAT.EMPTY) {
        this.swapCells(i, ni);
      } else if (nid === MAT.PLANT || nid === MAT.FUNGUS || nid === MAT.SEED) {
        if (Math.random() < 0.12) {
          this.setCell(nx, ny, MAT.EMPTY);
          this.swapCells(i, ni);
        } else {
          this.meta[i] ^= 1;
        }
      } else {
        this.meta[i] ^= 1;
      }
    } else {
      this.meta[i] ^= 1;
    }
  }

  updateCloner(x, y, i) {
    const W = this.width;
    const H = this.height;
    let cloneMat = this.meta[i];

    const dirs = [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ];

    if (cloneMat === 0) {
      // Learn first adjacent non-empty, non-cloner material
      for (let d = 0; d < 4; d++) {
        const nx = x + dirs[d][0];
        const ny = y + dirs[d][1];
        if (!this.inBounds(nx, ny)) continue;
        const nid = this.type[ny * W + nx];
        if (nid !== MAT.EMPTY && nid !== MAT.CLONER && nid !== MAT.WALL && nid !== MAT.VOID) {
          this.meta[i] = nid;
          cloneMat = nid;
          break;
        }
      }
    }

    if (cloneMat !== 0 && Math.random() < 0.28) {
      const d = dirs[(this.tickCount + x + y) & 3];
      const nx = x + d[0];
      const ny = y + d[1];
      if (this.inBounds(nx, ny) && this.type[ny * W + nx] === MAT.EMPTY) {
        if (cloneMat === MAT.LIGHTNING) {
          if (Math.random() < 0.04) this.triggerLightningBolt(nx, ny);
        } else {
          this.setCell(nx, ny, cloneMat);
        }
      }
    }
  }

  updateVoid(x, y, i) {
    const W = this.width;
    const H = this.height;
    // Pull and consume surrounding matter within radius 3
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (!this.inBounds(nx, ny)) continue;
        const ni = ny * W + nx;
        const nid = this.type[ni];
        if (nid !== MAT.EMPTY && nid !== MAT.VOID && nid !== MAT.WALL) {
          if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
            this.setCell(nx, ny, MAT.EMPTY);
          } else if (Math.random() < 0.35) {
            const stepX = x + Math.sign(dx);
            const stepY = y + Math.sign(dy);
            const si = stepY * W + stepX;
            if (this.type[si] === MAT.EMPTY) {
              this.swapCells(ni, si);
            }
          }
        }
      }
    }
  }

  updateSubpixelEntities() {
    // Update sparks
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.ox = s.x;
      s.oy = s.y;
      s.x += s.vx;
      s.y += s.vy;
      s.vy += 0.055 * this.gravity;
      s.vx *= 0.97;
      s.life--;
      if (s.life <= 0 || !this.inBounds(s.x | 0, s.y | 0)) {
        this.sparks.splice(i, 1);
      }
    }

    // Update bubbles (only survive inside liquid cells)
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      b.x += b.vx + Math.sin(this.tickCount * 0.15 + i) * 0.08;
      b.y += b.vy;
      b.life--;
      const ix = b.x | 0;
      const iy = b.y | 0;
      if (!this.inBounds(ix, iy) || b.life <= 0) {
        this.bubbles.splice(i, 1);
        continue;
      }
      const cid = this.type[iy * this.width + ix];
      if (cid !== MAT.WATER && cid !== MAT.ACID && cid !== MAT.OIL) {
        this.bubbles.splice(i, 1);
      }
    }

    // Update lightning arcs
    for (let i = this.lightningArcs.length - 1; i >= 0; i--) {
      this.lightningArcs[i].life -= 0.085;
      if (this.lightningArcs[i].life <= 0) {
        this.lightningArcs.splice(i, 1);
      }
    }

    // Update shockwaves
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const sw = this.shockwaves[i];
      sw.radius += (sw.maxRadius - sw.radius) * 0.22;
      sw.life -= 0.055;
      if (sw.life <= 0) {
        this.shockwaves.splice(i, 1);
      }
    }
  }

  packGPUData() {
    const out = this.gpuData;
    const tArr = this.type;
    const sArr = this.seed;
    const tempArr = this.temp;
    const mArr = this.meta;

    for (let i = 0, j = 0; i < this.size; i++, j += 4) {
      out[j] = tArr[i];
      out[j + 1] = sArr[i];
      // Map temperature (-100°C .. 1500°C) into 0..255
      const normT = Math.max(0, Math.min(255, ((tempArr[i] + 100) / 1600) * 255));
      out[j + 2] = normT | 0;
      out[j + 3] = mArr[i];
    }
  }

  // Helper drawing primitives for Sculpted World Dioramas
  fillCircle(cx, cy, r, matId, meta = 0) {
    const r2 = r * r;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r2) {
          this.setCell(Math.round(cx + dx), Math.round(cy + dy), matId, meta);
        }
      }
    }
  }

  fillCapsule(x0, y0, x1, y1, r, matId, meta = 0) {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      this.fillCircle(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, matId, meta);
    }
  }

  loadPreset(name) {
    this.clear();
    const W = this.width;
    const H = this.height;

    if (name === "cavern") {
      // Sculpted Magma & Bioluminescent Cavern with Refractive Waterfall
      // Outer cavern ceiling & stalactites
      for (let x = 0; x < W; x++) {
        const ceilH = 14 + Math.sin(x * 0.045) * 8 + Math.cos(x * 0.13) * 5;
        for (let y = 0; y < ceilH; y++) {
          this.setCell(x, y, MAT.STONE);
        }
        const floorH = H - 22 + Math.sin(x * 0.038 + 1.4) * 11 + Math.cos(x * 0.11) * 4;
        for (let y = Math.floor(floorH); y < H; y++) {
          this.setCell(x, y, MAT.STONE);
        }
      }

      // Upper-left waterfall basin & cloner spring
      this.fillCapsule(18, 52, 95, 62, 7, MAT.STONE);
      this.fillCapsule(82, 62, 138, 108, 6, MAT.STONE);
      this.fillCircle(32, 34, 3, MAT.CLONER, MAT.WATER);

      // Lower-left crystal lagoon basin
      this.fillCapsule(14, 152, 155, 162, 8, MAT.STONE);
      this.fillCapsule(152, 134, 162, 165, 7, MAT.STONE);
      for (let y = 122; y < 146; y++) {
        for (let x = 28; x < 142; x++) {
          if (this.type[y * W + x] === MAT.EMPTY) {
            this.setCell(x, y, MAT.WATER);
          }
        }
      }
      // Sandy riverbed under the lagoon
      for (let y = 140; y < 149; y++) {
        for (let x = 35; x < 135; x++) {
          if (this.type[y * W + x] === MAT.WATER) {
            this.setCell(x, y, MAT.SAND);
          }
        }
      }

      // Central natural bridge & wooden arch with glowing Bioluminescent Fungus & Lush Foliage
      this.fillCapsule(125, 92, 198, 86, 5, MAT.WOOD);
      for (let x = 132; x < 192; x += 3) {
        this.fillCircle(x, 82, 4, MAT.PLANT, x % 6 === 0 ? 99 : 6);
        if (x % 9 === 0) {
          this.fillCircle(x, 96, 4, MAT.FUNGUS, (Math.random() * 255) | 0);
        }
      }

      // Stalactite bioluminescent fungus clusters on ceiling
      for (const fx of [58, 118, 176, 232, 278]) {
        this.fillCapsule(fx, 12, fx, 28 + (fx % 11), 4, MAT.STONE);
        this.fillCircle(fx, 30 + (fx % 11), 5, MAT.FUNGUS, (Math.random() * 255) | 0);
      }

      // Lower-right Incandescent Magma Chamber
      this.fillCapsule(188, 132, 196, 175, 8, MAT.STONE);
      this.fillCapsule(195, 166, 304, 164, 9, MAT.STONE);
      this.fillCapsule(298, 122, 306, 168, 8, MAT.STONE);
      for (let y = 136; y < 158; y++) {
        for (let x = 205; x < 292; x++) {
          if (this.type[y * W + x] === MAT.EMPTY) {
            this.setCell(x, y, MAT.LAVA);
          }
        }
      }
      // Slow magma vent cloner above magma chamber
      this.fillCircle(262, 72, 6, MAT.STONE);
      this.fillCircle(262, 78, 2, MAT.CLONER, MAT.LAVA);

      // Golden silica sand shelf & mites
      for (let x = 148; x < 185; x++) {
        for (let y = 74; y < 80; y++) {
          if (this.type[y * W + x] === MAT.EMPTY) this.setCell(x, y, MAT.SAND);
        }
      }
      for (let m = 0; m < 10; m++) {
        this.setCell(140 + m * 4, 70, MAT.MITE);
      }
    } else if (name === "lagoon") {
      // Crystal Lagoon & Botanical Glass Terrarium
      // Large curved fused-glass botanical dome in the center
      for (let a = 0; a < Math.PI * 2; a += 0.015) {
        if (a > Math.PI * 1.35 && a < Math.PI * 1.65) continue; // Top opening
        const gx = Math.round(W * 0.5 + Math.cos(a) * 68);
        const gy = Math.round(H * 0.52 + Math.sin(a) * 56);
        this.fillCircle(gx, gy, 3, MAT.GLASS);
      }
      // Inside terrarium: sand bed, water pool, glowing plants & seeds
      for (let y = 128; y < 148; y++) {
        for (let x = 108; x < 212; x++) {
          const dx = x - W * 0.5;
          const dy = (y - H * 0.52) * (68 / 56);
          if (dx * dx + dy * dy < 62 * 62) {
            this.setCell(x, y, y > 136 ? MAT.SAND : MAT.WATER);
          }
        }
      }
      for (let x = 125; x <= 195; x += 14) {
        this.setCell(x, 118, MAT.SEED);
      }

      // Left glacier ice shelf & alpine snow
      this.fillCapsule(16, 85, 82, 102, 7, MAT.ICE);
      for (let x = 22; x < 74; x++) {
        for (let y = 66; y < 78; y++) {
          this.setCell(x, y, MAT.SNOW);
        }
      }

      // Right timber terrace with glowing fungus & oil slick basin
      this.fillCapsule(238, 118, 302, 102, 6, MAT.WOOD);
      this.fillCapsule(235, 104, 240, 120, 5, MAT.WOOD);
      for (let x = 248; x < 292; x++) {
        for (let y = 92; y < 102; y++) {
          if (this.type[y * W + x] === MAT.EMPTY) this.setCell(x, y, MAT.OIL);
        }
      }
      this.fillCircle(160, 22, 2, MAT.CLONER, MAT.WATER);
    } else if (name === "alchemy") {
      // Alchemist's Reactor & Cloner Forge
      // Outer obsidian frame
      this.fillCapsule(14, 184, W - 15, 184, 5, MAT.WALL);

      // Left Fluoro-Acid Vat
      this.fillCapsule(28, 110, 32, 165, 4, MAT.GLASS);
      this.fillCapsule(32, 165, 108, 165, 4, MAT.GLASS);
      this.fillCapsule(108, 110, 108, 165, 4, MAT.GLASS);
      for (let y = 126; y < 159; y++) {
        for (let x = 38; x < 102; x++) {
          this.setCell(x, y, MAT.ACID);
        }
      }
      this.fillCircle(68, 42, 2, MAT.CLONER, MAT.ACID);
      this.fillCapsule(52, 85, 86, 85, 3, MAT.WOOD);

      // Center Aurum Gold Crucible & Molten Glass Foundry
      this.fillCapsule(132, 115, 140, 165, 5, MAT.GOLD);
      this.fillCapsule(140, 165, 195, 165, 5, MAT.GOLD);
      this.fillCapsule(195, 165, 203, 115, 5, MAT.GOLD);
      for (let y = 142; y < 158; y++) {
        for (let x = 146; x < 189; x++) {
          this.setCell(x, y, MAT.LAVA);
        }
      }
      this.fillCircle(167, 42, 2, MAT.CLONER, MAT.SAND);

      // Right Aether Gas & Pyrotechnic Chamber
      this.fillCapsule(228, 125, 294, 125, 4, MAT.STONE);
      this.fillCapsule(228, 125, 228, 165, 4, MAT.STONE);
      this.fillCapsule(294, 125, 294, 165, 4, MAT.STONE);
      for (let y = 145; y < 168; y++) {
        for (let x = 236; x < 286; x++) {
          this.setCell(x, y, MAT.GUNPOWDER);
        }
      }
      this.fillCircle(262, 52, 3, MAT.VOID);
    } else if (name === "storm") {
      // Thunderstorm & Fulgurite Glass Dunes
      for (let x = 0; x < W; x++) {
        const duneH =
          H -
          38 +
          Math.sin(x * 0.032) * 18 +
          Math.cos(x * 0.075 + 0.8) * 9;
        for (let y = Math.floor(duneH); y < H; y++) {
          this.setCell(x, y, y > H - 12 ? MAT.STONE : MAT.SAND);
        }
      }

      // Conductive Gold Lightning Rods on the dune peaks
      this.fillCapsule(64, 102, 64, 145, 3, MAT.GOLD);
      this.fillCapsule(232, 95, 232, 140, 3, MAT.GOLD);

      // Desert oasis pool in the valley
      for (let y = 145; y < 168; y++) {
        for (let x = 115; x < 185; x++) {
          if (this.type[y * W + x] === MAT.EMPTY) {
            this.setCell(x, y, MAT.WATER);
          }
        }
      }
      this.fillCircle(112, 142, 5, MAT.PLANT, 12);
      this.fillCircle(188, 140, 5, MAT.PLANT, 12);

      // Storm cloud lightning cloners at top
      this.fillCircle(64, 18, 2, MAT.CLONER, MAT.LIGHTNING);
      this.fillCircle(152, 18, 2, MAT.CLONER, MAT.LIGHTNING);
      this.fillCircle(232, 18, 2, MAT.CLONER, MAT.LIGHTNING);
      this.triggerLightningBolt(152, 22);
    }

    this.undoStack.length = 0;
    this.packGPUData();
  }
}
