const bounded = (value, fallback, min, max) => Math.max(min, Math.min(max, Number(value) || fallback));

/** Linear mono resampling performed once per complete utterance. */
export function resampleMono(samples, inputRate, outputRate = 16000) {
  if (!(samples instanceof Float32Array) || !Number.isFinite(inputRate) || inputRate < 8000 || inputRate > 192000 || !Number.isFinite(outputRate) || outputRate < 8000 || outputRate > 48000) throw new TypeError('Use bounded mono PCM and supported sample rates.');
  if (inputRate === outputRate) return samples.slice();
  const output = new Float32Array(Math.floor(samples.length * outputRate / inputRate));
  const ratio = inputRate / outputRate;
  for (let i = 0; i < output.length; i++) {
    const offset = i * ratio, left = Math.floor(offset), fraction = offset - left;
    output[i] = samples[left] * (1 - fraction) + (samples[Math.min(left + 1, samples.length - 1)] || 0) * fraction;
  }
  return output;
}

/** WAV PCM16, mono. Raw microphone PCM is never written to persistent storage. */
export function encodePcmWav(samples, sampleRate = 16000) {
  if (!(samples instanceof Float32Array) || ![16000, 24000, 48000].includes(sampleRate) || samples.length > sampleRate * 60) throw new TypeError('WAV must be mono, supported-rate PCM, at most 60 seconds.');
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
  const write = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0;
    view.setInt16(44 + i * 2, value < 0 ? Math.round(value * 32768) : Math.round(value * 32767), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Energy VAD with bounded pre-roll, hesitant endpointing and optional PCM echo reference.
 * Browser echo cancellation and this energy/correlation safeguard are not a
 * certified separation of phone loudspeaker audio from a learner's speech.
 */
export function createLocalVad({ sampleRate = 16000, preRollMs = 500, silenceMs = 1100,
  minSpeechMs = 180, attackMs = 60, maxDurationMs = 60000, threshold = 0.018,
  outputThresholdMultiplier = 2.2, onSpeechStart = () => {}, onUtterance = () => {},
  onState = () => {}, onWarning = () => {},
} = {}) {
  const rate = bounded(sampleRate, 16000, 8000, 192000);
  const preRollLimit = Math.round(rate * bounded(preRollMs, 500, 100, 1000) / 1000);
  const silenceLimit = Math.round(rate * bounded(silenceMs, 1100, 500, 3000) / 1000);
  const minSpeech = Math.round(rate * bounded(minSpeechMs, 180, 120, 1000) / 1000);
  const attackLimit = Math.round(rate * bounded(attackMs, 60, 20, 200) / 1000);
  const captureLimit = Math.round(rate * bounded(maxDurationMs, 60000, 1000, 60000) / 1000);
  const baseThreshold = bounded(threshold, 0.018, 0.005, 0.2);
  const outputMultiplier = bounded(outputThresholdMultiplier, 2.2, 1.2, 5);
  let ring = [], ringCount = 0, captured = [], capturedCount = 0;
  let active = false, voicedCount = 0, silentCount = 0, attackCount = 0, noiseFloor = baseThreshold / 4;
  let outputActive = false, outputTail = 0, reference = null, locked = false;
  function resetCapture() { captured = []; capturedCount = 0; active = false; voicedCount = 0; silentCount = 0; attackCount = 0; }
  function reset() { resetCapture(); ring = []; ringCount = 0; reference = null; locked = false; }
  function addRing(frame) {
    ring.push(frame); ringCount += frame.length;
    while (ringCount > preRollLimit && ring.length) {
      const excess = ringCount - preRollLimit;
      if (ring[0].length <= excess) ringCount -= ring.shift().length;
      else { ring[0] = ring[0].slice(excess); ringCount -= excess; }
    }
  }
  function finish(reason) {
    const enoughSpeech = voicedCount >= minSpeech;
    const samples = enoughSpeech ? new Float32Array(capturedCount) : null;
    if (samples) { let offset = 0; for (const frame of captured) { samples.set(frame, offset); offset += frame.length; } }
    resetCapture(); ring = []; ringCount = 0;
    onState({ phase: 'monitoring' });
    if (samples) onUtterance({ samples, sampleRate: rate, durationMs: samples.length * 1000 / rate, reason });
    return enoughSpeech;
  }
  function echoLike(frame) {
    if (!reference || reference.length !== frame.length) return false;
    let dot = 0, left = 0, right = 0;
    for (let i = 0; i < frame.length; i++) { dot += frame[i] * reference[i]; left += frame[i] ** 2; right += reference[i] ** 2; }
    return left > 0 && right > 0 && Math.abs(dot / Math.sqrt(left * right)) >= 0.92;
  }
  function process(samples) {
    if (!(samples instanceof Float32Array) || !samples.length || samples.length > rate) return;
    const frame = samples.slice(); let energy = 0;
    for (let i = 0; i < frame.length; i++) { if (!Number.isFinite(frame[i])) frame[i] = 0; frame[i] = Math.max(-1, Math.min(1, frame[i])); energy += frame[i] ** 2; }
    const rms = Math.sqrt(energy / frame.length), output = outputActive || outputTail > 0;
    outputTail = Math.max(0, outputTail - frame.length);
    const cutoff = Math.max(baseThreshold, noiseFloor * 3) * (output ? outputMultiplier : 1);
    const speech = rms >= cutoff && !(output && echoLike(frame));
    if (!speech && !active && !output) noiseFloor = Math.min(baseThreshold * 1.5, noiseFloor * 0.98 + rms * 0.02);
    if (locked) {
      silentCount = speech ? 0 : silentCount + frame.length;
      if (silentCount >= silenceLimit) { locked = false; silentCount = 0; }
      return;
    }
    if (!active) {
      addRing(frame);
      attackCount = speech ? attackCount + frame.length : 0;
      if (attackCount < attackLimit) return;
      active = true; captured = ring.slice(); capturedCount = ringCount;
      voicedCount = attackCount; silentCount = 0; ring = []; ringCount = 0;
      onSpeechStart(); onState({ phase: 'capturing' });
    } else {
      const available = captureLimit - capturedCount;
      if (available > 0) { const accepted = frame.length <= available ? frame : frame.slice(0, available); captured.push(accepted); capturedCount += accepted.length; }
      voicedCount += speech ? frame.length : 0;
      silentCount = speech ? 0 : silentCount + frame.length;
    }
    if (capturedCount >= captureLimit) {
      locked = finish('limit');
      if (locked) onWarning('Capture reached its time limit. Pause before your next message.');
    } else if (silentCount >= silenceLimit) finish('silence');
  }
  return { process, reset, setOutputActive(value) { const wasActive = outputActive; outputActive = Boolean(value); if (wasActive && !outputActive) outputTail = Math.round(rate * 0.3); },
    setOutputReference(value) { reference = value instanceof Float32Array ? value.slice(0, rate) : null; },
    state: () => ({ active, bufferedSamples: ringCount + capturedCount, sampleRate: rate, outputActive, locked }),
  };
}

/** Browser PCM capture. Microphone permission is requested only by start(). */
export function createBrowserAudioInput({ windowImpl = globalThis.window, navigatorImpl = globalThis.navigator,
  documentImpl = globalThis.document, AudioContextImpl = windowImpl?.AudioContext || windowImpl?.webkitAudioContext,
  sampleRate = 16000, preRollMs = 500, silenceMs = 1100, maxDurationMs = 60000,
  createId = () => windowImpl?.crypto?.randomUUID?.() ?? globalThis.crypto?.randomUUID?.(),
} = {}) {
  let generation = 0, destroyed = false, muted = false, callbacks = null, resources = null, outputActive = false;
  const targetRate = [16000, 24000, 48000].includes(sampleRate) ? sampleRate : 16000;
  function release(value) {
    if (!value) return;
    value.vad?.reset();
    if (value.processor) { value.processor.onaudioprocess = null; if (value.processor.port) { value.processor.port.onmessage = null; value.processor.port.close?.(); } }
    for (const node of [value.source, value.processor, value.silentGain]) { try { node?.disconnect?.(); } catch {} }
    for (const track of value.stream?.getTracks?.() || []) { track.onended = null; try { track.stop(); } catch {} }
    try { Promise.resolve(value.context?.close?.()).catch(() => {}); } catch {}
  }
  function stop() { generation++; const previous = resources; resources = null; release(previous); callbacks?.onState?.({ phase: 'off' }); }
  async function start(options = callbacks) {
    if (destroyed) throw new Error('The microphone input is closed.');
    if (!options) throw new Error('Microphone callbacks are required.');
    stop(); callbacks = options; muted = false;
    if (documentImpl?.hidden) throw new Error('Keep the page visible to use its microphone.');
    if (!windowImpl?.isSecureContext || typeof navigatorImpl?.mediaDevices?.getUserMedia !== 'function' || !AudioContextImpl) throw new Error('Microphone capture needs HTTPS and browser audio support. Use typing instead.');
    const epoch = generation;
    const value = { context: new AudioContextImpl(), stream: null, source: null, processor: null, silentGain: null, vad: null };
    resources = value; callbacks.onState?.({ phase: 'starting' });
    const valid = () => !destroyed && !muted && generation === epoch && resources === value && !documentImpl?.hidden;
    // Resume before awaiting the permission request, within the initiating gesture.
    const resume = Promise.resolve(value.context.resume?.()).then(() => null, error => error);
    try {
      const stream = await navigatorImpl.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (!valid()) { for (const track of stream.getTracks()) track.stop(); release(value); return; }
      value.stream = stream; const resumeError = await resume; if (resumeError) throw resumeError;
      if (!valid()) { release(value); return; }
      const settings = stream.getAudioTracks?.()[0]?.getSettings?.() || {};
      if (settings.echoCancellation === false) callbacks.onWarning?.('Browser echo cancellation is unavailable. Use headphones or the Interrupt button if playback triggers the microphone.');
      value.vad = createLocalVad({ sampleRate: value.context.sampleRate, preRollMs, silenceMs, maxDurationMs,
        onSpeechStart: () => { if (valid()) callbacks.onSpeechStart?.(); },
        onState: state => { if (valid()) callbacks.onState?.(state); },
        onWarning: warning => { if (valid()) callbacks.onWarning?.(warning); },
        onUtterance({ samples, sampleRate: sourceRate, durationMs }) {
          if (!valid()) return;
          const pcm = resampleMono(samples, sourceRate, targetRate);
          const utteranceId = createId();
          if (!utteranceId) { callbacks.onWarning?.('A secure request identifier is unavailable. Use typing instead.'); return; }
          callbacks.onUtterance?.({ audio: encodePcmWav(pcm, targetRate), mimeType: 'audio/wav', durationMs, utteranceId });
        },
      });
      value.vad.setOutputActive(outputActive);
      value.source = value.context.createMediaStreamSource(stream);
      value.silentGain = value.context.createGain(); value.silentGain.gain.value = 0;
      if (value.context.audioWorklet && windowImpl.AudioWorkletNode) {
        await value.context.audioWorklet.addModule(new URL('./browser-audio.js', import.meta.url).href);
        if (!valid()) { release(value); return; }
        value.processor = new windowImpl.AudioWorkletNode(value.context, 'conversation-agent-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        value.processor.port.onmessage = event => { if (valid() && event.data instanceof Float32Array) value.vad.process(event.data); };
      } else {
        value.processor = value.context.createScriptProcessor(2048, 1, 1);
        value.processor.onaudioprocess = event => { if (valid()) value.vad.process(event.inputBuffer.getChannelData(0)); };
      }
      value.source.connect(value.processor); value.processor.connect(value.silentGain); value.silentGain.connect(value.context.destination);
      for (const track of stream.getTracks()) track.onended = () => { if (valid()) { stop(); callbacks.onState?.({ phase: 'unavailable' }); callbacks.onWarning?.('The microphone disconnected. Use typing or start again.'); } };
      callbacks.onState?.({ phase: 'monitoring' });
    } catch (error) {
      release(value); if (resources === value) resources = null;
      if (generation !== epoch || destroyed || muted) return;
      throw new Error(error?.name === 'NotAllowedError' ? 'Microphone permission was denied. Use typing or allow it in browser settings.' : 'Microphone capture could not start. Use typing instead.');
    }
  }
  const onHidden = () => { if (documentImpl?.hidden) stop(); };
  documentImpl?.addEventListener?.('visibilitychange', onHidden);
  return { start, stop,
    setMuted(value) { muted = Boolean(value); if (muted) stop(); else if (callbacks && !resources) void start(callbacks).catch(error => { callbacks?.onState?.({ phase: 'unavailable' }); callbacks?.onWarning?.(error.message); }); },
    setOutputActive(value) { outputActive = Boolean(value); resources?.vad?.setOutputActive(outputActive); },
    setOutputReference(value) { resources?.vad?.setOutputReference(value); },
    state: () => ({ active: Boolean(resources?.stream), muted, sampleRate: resources?.context?.sampleRate || null }),
    destroy() { stop(); destroyed = true; callbacks = null; documentImpl?.removeEventListener?.('visibilitychange', onHidden); },
  };
}

// The same self-hosted module can be loaded in an AudioWorklet; no blob scripts.
if (typeof globalThis.AudioWorkletProcessor === 'function' && typeof globalThis.registerProcessor === 'function') {
  class ConversationCapture extends globalThis.AudioWorkletProcessor {
    process(inputs, outputs) {
      const channel = inputs[0]?.[0];
      if (channel?.length) { const frame = channel.slice(); this.port.postMessage(frame, [frame.buffer]); }
      for (const output of outputs) for (const channel of output) channel.fill(0);
      return true;
    }
  }
  globalThis.registerProcessor('conversation-agent-capture', ConversationCapture);
}
