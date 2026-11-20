import { MAT, MATERIALS, MATERIAL_CATEGORIES } from "./materials.js";
import { Simulation } from "./simulation.js";
import { WebGLRenderer } from "./renderer.js";
import { OverlayRenderer } from "./overlays.js";
import { SpatialAudioEngine } from "./audio.js";

class AetherSandApp {
  constructor() {
    this.sim = new Simulation(320, 200);
    this.glCanvas = document.getElementById("gl-canvas");
    this.fxCanvas = document.getElementById("fx-canvas");
    this.renderer = new WebGLRenderer(this.glCanvas, this.sim);
    this.overlays = new OverlayRenderer(this.fxCanvas, this.sim);
    this.audio = new SpatialAudioEngine();

    this.paused = false;
    this.activeMaterial = MAT.WATER;
    this.toolMode = "paint";
    this.brushRadius = 8;

    this.isDrawing = false;
    this.activePointerButton = 0;
    this.lastSimPos = { x: 0, y: 0 };
    this.isDraggingSplit = false;

    this.fpsFrames = 0;
    this.fpsLastTime = performance.now();

    this.srStatus = document.getElementById("sr-status");

    this.buildMaterialPalette();
    this.bindUIControls();
    this.bindCanvasInteractions();
    this.installModernWebFallbacks();

    // Load the flagship Magma & Bioluminescent Cavern diorama immediately
    this.sim.loadPreset("cavern");
    this.selectMaterial(MAT.WATER);
    this.handleResize();

    window.addEventListener("resize", () => this.handleResize());
    requestAnimationFrame((t) => this.loop(t));
  }

  announceStatus(message) {
    if (this.srStatus) {
      this.srStatus.textContent = message;
    }
  }

  buildMaterialPalette() {
    const container = document.getElementById("material-palette");
    container.innerHTML = "";

    for (const cat of MATERIAL_CATEGORIES) {
      const section = document.createElement("div");
      section.className = "panel-section";
      section.setAttribute("role", "group");
      section.setAttribute("aria-label", cat.title);

      const heading = document.createElement("h2");
      heading.className = "mat-category-title";
      heading.textContent = cat.title;
      section.appendChild(heading);

      const grid = document.createElement("div");
      grid.className = "mat-grid";

      for (const matId of cat.items) {
        const mat = MATERIALS[matId];
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "mat-btn";
        btn.dataset.matId = String(matId);
        btn.setAttribute("aria-pressed", matId === this.activeMaterial ? "true" : "false");
        btn.setAttribute("aria-label", `${mat.name}: ${mat.sub}`);
        btn.title = `${mat.name} — ${mat.desc}`;

        btn.innerHTML = `
          <span class="mat-orb" style="background: ${mat.swatch}" aria-hidden="true"></span>
          <span class="mat-meta">
            <span class="mat-name">${mat.name}</span>
            <span class="mat-sub">${mat.sub}</span>
          </span>
        `;

        btn.addEventListener("click", () => {
          this.selectMaterial(matId);
          if (this.toolMode === "erase") {
            this.selectToolMode("paint");
          }
        });

        grid.appendChild(btn);
      }

      section.appendChild(grid);
      container.appendChild(section);
    }
  }

  selectMaterial(matId) {
    this.activeMaterial = matId;
    this.overlays.cursor.matId = matId;

    document.querySelectorAll(".mat-btn").forEach((btn) => {
      const isSelected = Number(btn.dataset.matId) === matId;
      btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
    });

    const mat = MATERIALS[matId];
    if (mat) {
      document.getElementById("active-mat-swatch").style.background = mat.swatch;
      document.getElementById("active-mat-name").textContent = mat.name;
      document.getElementById("active-mat-tag").textContent = mat.tag;
      document.getElementById("active-mat-desc").textContent = mat.desc;
    }
  }

  selectToolMode(mode) {
    this.toolMode = mode;
    this.overlays.cursor.toolMode = mode;
    document.querySelectorAll(".v-tool-btn").forEach((btn) => {
      btn.setAttribute("aria-pressed", btn.dataset.tool === mode ? "true" : "false");
    });
  }

  setRenderMode(modeStr) {
    const map = { ultra: 0, split: 1, thermal: 2, classic: 3 };
    const modeInt = map[modeStr] ?? 0;
    this.renderer.renderMode = modeInt;

    document.querySelectorAll(".mode-btn").forEach((btn) => {
      btn.setAttribute("aria-pressed", btn.dataset.renderMode === modeStr ? "true" : "false");
    });

    const splitHandle = document.getElementById("split-handle");
    splitHandle.hidden = modeStr !== "split";

    const hudPipeline = document.getElementById("hud-pipeline");
    if (modeStr === "ultra") {
      hudPipeline.textContent = "WebGL2 2.5D PBR + Raymarched GI";
    } else if (modeStr === "split") {
      hudPipeline.textContent = "Split Comparison: Classic Pixels vs 100x Ultra GI";
    } else if (modeStr === "thermal") {
      hudPipeline.textContent = "Infrared Blackbody Thermal Field";
    } else {
      hudPipeline.textContent = "Classic 8-Bit Flat Pixels";
    }
  }

  bindUIControls() {
    // Play / Pause Toggle (keeps constant aria-label per modern-web-guidance)
    const playPauseBtn = document.getElementById("btn-play-pause");
    playPauseBtn.addEventListener("click", () => {
      this.paused = !this.paused;
      playPauseBtn.setAttribute("aria-pressed", this.paused ? "true" : "false");
    });

    // Step 1 frame
    document.getElementById("btn-step").addEventListener("click", () => {
      this.paused = true;
      playPauseBtn.setAttribute("aria-pressed", "true");
      this.sim.step();
      this.announceStatus("Advanced simulation by one frame");
    });

    // Undo
    document.getElementById("btn-undo").addEventListener("click", () => {
      const ok = this.sim.popUndoSnapshot();
      this.announceStatus(ok ? "Undid last brush stroke" : "Nothing to undo");
    });

    // Clear
    document.getElementById("btn-clear").addEventListener("click", () => {
      this.sim.saveUndoSnapshot();
      this.sim.clear();
      document.querySelectorAll(".world-pill").forEach((b) => b.classList.remove("active"));
      this.announceStatus("Cleared sandbox canvas");
    });

    // Render Mode Buttons
    document.querySelectorAll(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.setRenderMode(btn.dataset.renderMode);
      });
    });

    // Lighting Environment Cycle
    const lightingNames = ["Cavern GI", "Sunset GI", "Daylight GI"];
    document.getElementById("btn-lighting-cycle").addEventListener("click", () => {
      this.renderer.lightingPreset = (this.renderer.lightingPreset + 1) % 3;
      const name = lightingNames[this.renderer.lightingPreset];
      document.getElementById("lighting-label").textContent = name;
      this.announceStatus(`Switched lighting environment to ${name}`);
    });

    // Spatial Audio Toggle
    const audioBtn = document.getElementById("btn-audio");
    audioBtn.addEventListener("click", () => {
      const on = this.audio.toggle();
      audioBtn.setAttribute("aria-pressed", on ? "true" : "false");
    });

    // Brush Tool Mode Buttons
    document.querySelectorAll(".v-tool-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.selectToolMode(btn.dataset.tool);
      });
    });

    // Brush Size Slider & Quick Chips
    const sizeSlider = document.getElementById("brush-size");
    const sizeOut = document.getElementById("brush-size-val");
    const updateSize = (val) => {
      this.brushRadius = Number(val);
      this.overlays.cursor.radius = this.brushRadius;
      sizeSlider.value = String(this.brushRadius);
      sizeOut.textContent = String(this.brushRadius);
    };
    sizeSlider.addEventListener("input", () => updateSize(sizeSlider.value));
    document.querySelectorAll(".chip-btn").forEach((chip) => {
      chip.addEventListener("click", () => updateSize(chip.dataset.size));
    });

    // Gravity Slider
    const gravSlider = document.getElementById("gravity-slider");
    const gravOut = document.getElementById("gravity-val");
    gravSlider.addEventListener("input", () => {
      this.sim.gravity = Number(gravSlider.value);
      gravOut.textContent = `${this.sim.gravity.toFixed(2).replace(/\.00$/, ".0")}G`;
    });

    // GI Intensity Slider
    const giSlider = document.getElementById("gi-intensity");
    const giOut = document.getElementById("gi-intensity-val");
    giSlider.addEventListener("input", () => {
      const pct = Number(giSlider.value);
      this.renderer.giIntensity = pct / 100;
      giOut.textContent = `${pct}%`;
    });

    // Quick World Pills & Dialog Preset Cards
    const loadWorld = (preset) => {
      this.sim.loadPreset(preset);
      document.querySelectorAll(".world-pill").forEach((pill) => {
        pill.classList.toggle("active", pill.dataset.preset === preset);
      });
      this.announceStatus(`Loaded ${preset} physics diorama`);
    };

    document.querySelectorAll(".world-pill").forEach((pill) => {
      pill.addEventListener("click", () => loadWorld(pill.dataset.preset));
    });

    const dialog = document.getElementById("presets-dialog");
    document.querySelectorAll("[data-load-preset]").forEach((card) => {
      card.addEventListener("click", () => {
        loadWorld(card.dataset.loadPreset);
        dialog.close("preset-loaded");
      });
    });

    // Reset dialog.returnValue on close per modern-web-guidance
    dialog.addEventListener("close", () => {
      dialog.returnValue = "";
    });

    // Shader Pipeline Checkboxes inside Modal Dialog
    document.getElementById("chk-metaballs").addEventListener("change", (e) => {
      this.renderer.enableMetaballs = e.target.checked ? 1 : 0;
    });
    document.getElementById("chk-gi").addEventListener("change", (e) => {
      this.renderer.enableGI = e.target.checked ? 1 : 0;
    });
    document.getElementById("chk-refraction").addEventListener("change", (e) => {
      this.renderer.enableRefraction = e.target.checked ? 1 : 0;
    });
    document.getElementById("chk-subpixel").addEventListener("change", (e) => {
      this.overlays.enableSubpixel = e.target.checked;
    });

    // Split-Screen Comparison Drag Handle
    const splitHandle = document.getElementById("split-handle");
    const splitPill = splitHandle.querySelector(".split-pill");
    splitPill.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.isDraggingSplit = true;
      splitPill.setPointerCapture(e.pointerId);
    });
    splitPill.addEventListener("pointermove", (e) => {
      if (!this.isDraggingSplit) return;
      const rect = this.fxCanvas.getBoundingClientRect();
      const normX = Math.max(0.05, Math.min(0.95, (e.clientX - rect.left) / rect.width));
      this.renderer.splitX = normX;
      splitHandle.style.left = `${normX * 100}%`;
    });
    splitPill.addEventListener("pointerup", () => {
      this.isDraggingSplit = false;
    });

    // Global Keyboard Shortcuts
    window.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT" || document.getElementById("presets-dialog").open) return;
      if (e.code === "Space") {
        e.preventDefault();
        playPauseBtn.click();
      } else if (e.key === ".") {
        document.getElementById("btn-step").click();
      } else if (e.key === "z" || e.key === "Z") {
        document.getElementById("btn-undo").click();
      } else if (e.key === "m" || e.key === "M") {
        audioBtn.click();
      } else if (e.key === "[") {
        updateSize(Math.max(1, this.brushRadius - 2));
      } else if (e.key === "]") {
        updateSize(Math.min(32, this.brushRadius + 2));
      }
    });
  }

  clientToSimCoords(clientX, clientY) {
    const rect = this.fxCanvas.getBoundingClientRect();
    const u = Math.max(0, Math.min(0.9999, (clientX - rect.left) / rect.width));
    const v = Math.max(0, Math.min(0.9999, (clientY - rect.top) / rect.height));
    return {
      x: Math.floor(u * this.sim.width),
      y: Math.floor(v * this.sim.height),
      u,
      v,
    };
  }

  updateProbeHUD(simX, simY) {
    if (!this.sim.inBounds(simX, simY)) return;
    const i = simY * this.sim.width + simX;
    const id = this.sim.type[i];
    const temp = Math.round(this.sim.temp[i]);
    const mat = MATERIALS[id] || MATERIALS[MAT.EMPTY];
    document.getElementById("probe-element").textContent = mat.name;
    document.getElementById("probe-temp").textContent = `${temp}°C`;
  }

  bindCanvasInteractions() {
    const canvas = this.fxCanvas;

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      const pos = this.clientToSimCoords(e.clientX, e.clientY);

      this.sim.saveUndoSnapshot();
      this.isDrawing = true;
      this.activePointerButton = e.button;
      this.lastSimPos = { x: pos.x, y: pos.y };

      this.overlays.cursor.active = true;
      this.overlays.cursor.simX = pos.x;
      this.overlays.cursor.simY = pos.y;
      this.renderer.cursorUV = [pos.u, pos.v];
      this.renderer.cursorActive = 1;

      const effectiveTool = e.button === 2 ? "erase" : this.toolMode;
      this.sim.applyBrushAt(pos.x, pos.y, this.brushRadius, effectiveTool, this.activeMaterial);
      this.updateProbeHUD(pos.x, pos.y);
    });

    canvas.addEventListener("pointermove", (e) => {
      const pos = this.clientToSimCoords(e.clientX, e.clientY);
      this.overlays.cursor.active = true;
      this.overlays.cursor.simX = pos.x;
      this.overlays.cursor.simY = pos.y;
      this.renderer.cursorUV = [pos.u, pos.v];
      this.renderer.cursorActive = 1;

      this.updateProbeHUD(pos.x, pos.y);

      if (this.isDrawing) {
        const effectiveTool = this.activePointerButton === 2 ? "erase" : this.toolMode;
        this.sim.applyBrushSegment(
          this.lastSimPos.x,
          this.lastSimPos.y,
          pos.x,
          pos.y,
          this.brushRadius,
          effectiveTool,
          this.activeMaterial
        );
        this.lastSimPos = { x: pos.x, y: pos.y };
      }
    });

    const endStroke = () => {
      this.isDrawing = false;
    };

    canvas.addEventListener("pointerup", endStroke);
    canvas.addEventListener("pointercancel", endStroke);
    canvas.addEventListener("pointerleave", () => {
      this.overlays.cursor.active = false;
      this.renderer.cursorActive = 0;
    });

    // Mouse wheel adjusts brush radius smoothly
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 1 : -1;
        this.brushRadius = Math.max(1, Math.min(32, this.brushRadius + delta));
        this.overlays.cursor.radius = this.brushRadius;
        document.getElementById("brush-size").value = String(this.brushRadius);
        document.getElementById("brush-size-val").textContent = String(this.brushRadius);
      },
      { passive: false }
    );
  }

  installModernWebFallbacks() {
    // 1. Roving-tabindex fallback for focusgroup="toolbar wrap" when native focusGroup is absent
    if (!("focusGroup" in HTMLElement.prototype)) {
      document.querySelectorAll('[role="toolbar"][focusgroup]').forEach((bar) => {
        const items = Array.from(bar.querySelectorAll("button"));
        if (!items.length) return;
        items.forEach((b, i) => {
          b.tabIndex = i === 0 ? 0 : -1;
        });

        bar.addEventListener("focusin", ({ target }) => {
          if (items.includes(target)) {
            items.forEach((b) => {
              b.tabIndex = b === target ? 0 : -1;
            });
          }
        });

        bar.addEventListener("keydown", (e) => {
          const vertical = bar.getAttribute("aria-orientation") === "vertical";
          const rtl = getComputedStyle(bar).direction === "rtl";
          const steps = vertical
            ? { ArrowDown: 1, ArrowUp: -1 }
            : { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 };

          const curIdx = items.indexOf(document.activeElement);
          if (curIdx === -1) return;

          let nextIdx = -1;
          if (e.key in steps) {
            nextIdx = (curIdx + steps[e.key] + items.length) % items.length;
          } else if (e.key === "Home") {
            nextIdx = 0;
          } else if (e.key === "End") {
            nextIdx = items.length - 1;
          }

          if (nextIdx !== -1) {
            e.preventDefault();
            items[nextIdx].focus();
          }
        });
      });
    }

    // 2. Declarative Invoker Commands fallback (`command="show-modal"` / `commandfor`)
    if (!("commandForElement" in HTMLButtonElement.prototype)) {
      document.querySelectorAll("button[command][commandfor]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const target = document.getElementById(btn.getAttribute("commandfor"));
          const cmd = btn.getAttribute("command");
          if (target && cmd === "show-modal" && typeof target.showModal === "function") {
            target.showModal();
          } else if (target && cmd === "close" && typeof target.close === "function") {
            target.close();
          }
        });
      });
    }

    // 3. <dialog closedby="any"> light-dismiss fallback testing pointer coordinates
    if (!("closedBy" in HTMLDialogElement.prototype)) {
      const outside = (e, dialog) => {
        const r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
        let pressedOutside = false;
        dialog.addEventListener("pointerdown", (e) => {
          pressedOutside = outside(e, dialog);
        });
        dialog.addEventListener("pointerup", (e) => {
          if (pressedOutside && outside(e, dialog)) dialog.close();
        });
      }
    }
  }

  handleResize() {
    const frame = document.getElementById("canvas-frame");
    const rect = frame.getBoundingClientRect();
    this.renderer.resize(rect.width, rect.height);
    this.overlays.resize(rect.width, rect.height);
  }

  loop(now) {
    // Hold-to-paint continuous stream if pointer is stationary and held down
    if (this.isDrawing) {
      const effectiveTool = this.activePointerButton === 2 ? "erase" : this.toolMode;
      this.sim.applyBrushAt(
        this.lastSimPos.x,
        this.lastSimPos.y,
        this.brushRadius,
        effectiveTool,
        this.activeMaterial
      );
    }

    if (!this.paused) {
      this.sim.step();
      this.audio.update(this.sim.audioEvents);
    }

    this.renderer.render();
    this.overlays.render(this.renderer.renderMode, this.renderer.splitX);

    // Update FPS & Active Cell HUD
    this.fpsFrames++;
    if (now - this.fpsLastTime >= 450) {
      const fps = Math.min(120, Math.round((this.fpsFrames * 1000) / (now - this.fpsLastTime)));
      document.getElementById("hud-fps").textContent = String(fps);
      document.getElementById("hud-cells").textContent = this.sim.activeCellCount.toLocaleString();
      this.fpsFrames = 0;
      this.fpsLastTime = now;
    }

    requestAnimationFrame((t) => this.loop(t));
  }
}

window.addEventListener("DOMContentLoaded", () => {
  new AetherSandApp();
});
