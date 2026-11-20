export class SpatialAudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.waterGain = null;
    this.lavaGain = null;
    this.fireGain = null;
  }

  toggle() {
    if (!this.enabled) {
      this.init();
      this.enabled = true;
      if (this.ctx && this.ctx.state === "suspended") {
        this.ctx.resume();
      }
    } else {
      this.enabled = false;
      if (this.waterGain) this.waterGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
      if (this.lavaGain) this.lavaGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
      if (this.fireGain) this.fireGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
    }
    return this.enabled;
  }

  init() {
    if (this.ctx) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    this.ctx = new AudioCtx();

    // Create 2 seconds of white noise buffer for procedural water, fire & steam synthesis
    const sampleRate = this.ctx.sampleRate;
    const bufferSize = sampleRate * 2;
    this.noiseBuffer = this.ctx.createBuffer(1, bufferSize, sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    // Continuous water stream bandpass node
    const waterNoise = this.ctx.createBufferSource();
    waterNoise.buffer = this.noiseBuffer;
    waterNoise.loop = true;
    const waterFilter = this.ctx.createBiquadFilter();
    waterFilter.type = "bandpass";
    waterFilter.frequency.value = 680;
    waterFilter.Q.value = 2.2;
    this.waterGain = this.ctx.createGain();
    this.waterGain.gain.value = 0;
    waterNoise.connect(waterFilter).connect(this.waterGain).connect(this.ctx.destination);
    waterNoise.start();

    // Continuous deep magma rumble oscillator
    const lavaOsc = this.ctx.createOscillator();
    lavaOsc.type = "triangle";
    lavaOsc.frequency.value = 58;
    this.lavaGain = this.ctx.createGain();
    this.lavaGain.gain.value = 0;
    lavaOsc.connect(this.lavaGain).connect(this.ctx.destination);
    lavaOsc.start();

    // Continuous fire roar filter
    const fireNoise = this.ctx.createBufferSource();
    fireNoise.buffer = this.noiseBuffer;
    fireNoise.loop = true;
    const fireFilter = this.ctx.createBiquadFilter();
    fireFilter.type = "lowpass";
    fireFilter.frequency.value = 340;
    this.fireGain = this.ctx.createGain();
    this.fireGain.gain.value = 0;
    fireNoise.connect(fireFilter).connect(this.fireGain).connect(this.ctx.destination);
    fireNoise.start();
  }

  update(events) {
    if (!this.enabled || !this.ctx) return;
    const now = this.ctx.currentTime;

    const waterLevel = Math.min(0.14, (events.waterFlow / 180) * 0.14);
    this.waterGain.gain.setTargetAtTime(waterLevel, now, 0.08);

    const lavaLevel = Math.min(0.08, (events.lavaCount / 1400) * 0.08);
    this.lavaGain.gain.setTargetAtTime(lavaLevel, now, 0.12);

    const fireLevel = Math.min(0.16, (events.fireCount / 220) * 0.16);
    this.fireGain.gain.setTargetAtTime(fireLevel, now, 0.06);

    if (events.sizzle > 0 || events.acidFizz > 0) {
      this.playOneShotNoise(2400, 0.04, 0.08);
    }
    if (events.explosion > 0) {
      this.playOneShotNoise(140, 0.25, 0.35);
      events.explosion = 0;
    }
    if (events.lightning > 0) {
      this.playOneShotNoise(950, 0.22, 0.28);
      events.lightning = 0;
    }
  }

  playOneShotNoise(freq, volume, duration) {
    if (!this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = freq;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    src.connect(filter).connect(gain).connect(this.ctx.destination);
    src.start(now);
    src.stop(now + duration);
  }
}
