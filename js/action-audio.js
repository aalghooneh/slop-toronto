// js/action-audio.js
// What the shooting sounds like, synthesized into the city's own mix (audio-system.js): the turret's hammering, a
// rocket leaving its tube, explosions (which arrive late and dull from far away, as they do), police pistols and the
// wail of the cruisers on your tail. Nothing here plays until the audio system is up and unmuted.

class ActionAudio {
  constructor(audioSystem) {
    this.audio = audioSystem;
    this.noise = null;
    this.siren = null;
    this.lastShot = 0;
  }

  get context() {
    const a = this.audio;
    return a && a.ready && a.enabled && a.context && a.context.state === 'running' && !document.hidden ? a.context : null;
  }

  noiseBuffer(context) {
    if (!this.noise || this.noise.sampleRate !== context.sampleRate) {
      this.noise = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noise;
  }

  // A burst of filtered noise: [frequency from, to], length, level, starting `when` seconds from now
  burst(context, type, f0, f1, length, level, when = 0, q = 0.8) {
    const t = context.currentTime + when;
    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer(context);
    source.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(f0, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + length);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    source.connect(filter).connect(gain).connect(this.audio.mix);
    source.start(t, Math.random() * 1.5);
    source.stop(t + length + 0.05);
  }

  tone(context, type, f0, f1, length, level, when = 0) {
    const t = context.currentTime + when;
    const osc = context.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + length);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    osc.connect(gain).connect(this.audio.mix);
    osc.start(t);
    osc.stop(t + length + 0.05);
  }

  // The turret: a hard crack over a thump, a little different every round
  gun() {
    const context = this.context;
    if (!context) return;
    const v = 0.9 + Math.random() * 0.2;
    this.burst(context, 'bandpass', 2400 * v, 700, 0.085, 0.34, 0, 0.7);
    this.burst(context, 'lowpass', 900, 160, 0.13, 0.3);
    this.tone(context, 'square', 190 * v, 70, 0.07, 0.1);
  }

  // Somebody else's gun, `distance` metres away
  shot(distance) {
    const context = this.context;
    if (!context || distance > 160) return;
    const now = context.currentTime;
    if (now - this.lastShot < 0.05) return;
    this.lastShot = now;
    const level = 0.2 / (1 + distance / 18);
    const delay = Math.min(0.4, distance / 343);
    this.burst(context, 'bandpass', 1700, 500, 0.09, level, delay, 0.9);
    this.burst(context, 'lowpass', 600, 120, 0.14, level * 0.8, delay);
  }

  rocket() {
    const context = this.context;
    if (!context) return;
    this.burst(context, 'bandpass', 500, 3200, 0.55, 0.3, 0, 0.6);
    this.burst(context, 'lowpass', 1400, 200, 0.7, 0.26);
    this.tone(context, 'sawtooth', 120, 46, 0.3, 0.12);
  }

  // A blast of the given power, `distance` metres from the camera: the thump in the chest, the roar, the debris
  // raining down after it
  explosion(distance, power = 1) {
    const context = this.context;
    if (!context || distance > 500) return;
    const near = 1 / (1 + distance / 30);
    const level = Math.min(1, near * (0.55 + power * 0.35));
    const delay = Math.min(1.2, distance / 343);
    const dull = 1 / (1 + distance / 70); // the air takes the top off a distant bang
    this.tone(context, 'sine', 105, 28, 0.85, level * 0.95, delay);
    this.tone(context, 'triangle', 62, 24, 1.1, level * 0.6, delay);
    this.burst(context, 'lowpass', 300 + 4200 * dull, 60, 1.5, level * 0.9, delay, 0.5);
    this.burst(context, 'bandpass', 1500 * dull + 300, 240, 0.28, level * 0.75, delay, 0.6);
    if (distance < 90) {
      for (let i = 0; i < 5; i++) {
        this.burst(context, 'highpass', 2600 + Math.random() * 2500, 1800, 0.07, level * 0.1, delay + 0.35 + Math.random() * 1.1, 1.5);
      }
    }
  }

  // A short phrase of notes: the wanted level going up, getting away, getting caught
  jingle(notes) {
    const context = this.context;
    if (!context) return;
    for (const [at, frequency, length, level = 0.1, type = 'triangle'] of notes) this.tone(context, type, frequency, frequency, length, level, at);
  }

  // The pursuit's sirens: `nearest` metres to the closest cruiser (Infinity = none), `side` -1 left .. 1 right of the
  // camera, `count` cruisers after you (a second, faster yelp joins in from three)
  setSiren(nearest, side = 0, count = 1) {
    const context = this.context;
    if (!context) {
      if (this.siren) this.stopSiren();
      return;
    }
    const level = Number.isFinite(nearest) ? Math.min(0.11, 0.16 / (1 + nearest / 22)) : 0;
    if (!this.siren) {
      if (level <= 0) return;
      const now = context.currentTime;
      const out = context.createGain();
      out.gain.value = 0;
      const pan = context.createStereoPanner ? context.createStereoPanner() : null;
      const tone = context.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 2400;
      const voice = (base, depth, rate, gainLevel) => {
        const osc = context.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = base;
        const lfo = context.createOscillator();
        lfo.frequency.value = rate;
        const sweep = context.createGain();
        sweep.gain.value = depth;
        lfo.connect(sweep).connect(osc.frequency);
        const gain = context.createGain();
        gain.gain.value = gainLevel;
        osc.connect(gain).connect(tone);
        osc.start(now);
        lfo.start(now);
        return { osc, lfo, gain };
      };
      const wail = voice(980, 380, 0.3, 1);
      const yelp = voice(1150, 330, 3.1, 0);
      tone.connect(out);
      if (pan) out.connect(pan).connect(this.audio.mix);
      else out.connect(this.audio.mix);
      this.siren = { context, out, pan, wail, yelp };
    }
    if (this.siren.context !== context) return this.stopSiren();
    const now = context.currentTime;
    this.siren.out.gain.setTargetAtTime(level, now, 0.25);
    this.siren.yelp.gain.gain.setTargetAtTime(count >= 3 ? 0.55 : 0, now, 0.4);
    if (this.siren.pan) this.siren.pan.pan.setTargetAtTime(Math.max(-0.8, Math.min(0.8, side)), now, 0.2);
  }

  stopSiren() {
    const s = this.siren;
    this.siren = null;
    if (!s) return;
    try {
      for (const v of [s.wail, s.yelp]) {
        v.osc.stop();
        v.lfo.stop();
      }
      s.out.disconnect();
    } catch { /* The context was closed under it. */ }
  }
}

export { ActionAudio };
