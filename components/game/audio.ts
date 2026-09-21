/** Small synthesized arcade tones. No audio network requests; enabled by user gesture. */
export class ArcadeAudio {
  private context: AudioContext | null = null;
  enabled = false;
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (enabled) {
      this.context ??= new AudioContext();
      void this.context.resume();
      this.play("ready");
    }
  }
  play(kind: "hit" | "wall" | "point" | "win" | "boost" | "ready") {
    if (!this.enabled || !this.context) return;
    const context = this.context;
    const notes = {
      hit: [420],
      wall: [210],
      point: [440, 560, 700],
      win: [440, 550, 660, 880],
      boost: [300, 700],
      ready: [480],
    }[kind];
    notes.forEach((frequency, i) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const time = context.currentTime + i * 0.075;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, time);
      gain.gain.setValueAtTime(0, time);
      gain.gain.linearRampToValueAtTime(
        kind === "wall" ? 0.025 : 0.055,
        time + 0.006,
      );
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.11);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(time);
      oscillator.stop(time + 0.12);
    });
  }
  dispose() {
    void this.context?.close();
  }
}
