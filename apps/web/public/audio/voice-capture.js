/*
 * Voice chat's microphone tap (apps/web/src/voice/capture.ts): an AudioWorklet that hands the main
 * thread 20 ms of mono samples at a time (960 at 48 kHz), so the game's own frame rate never decides
 * when the mic is read. Served from this site (the page's CSP allows only its own scripts).
 */
/* global AudioWorkletProcessor, registerProcessor */
class VoiceCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = (options && options.processorOptions && options.processorOptions.frame) || 960;
    this.buf = new Float32Array(this.size);
    this.at = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.at++] = ch[i];
      if (this.at === this.size) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(this.size);
        this.at = 0;
      }
    }
    return true;
  }
}

registerProcessor('mf-voice-capture', VoiceCapture);
