/** On-device listening for the conversation controller.
 *
 * Microphone audio is converted to 16 kHz and handed to a Web Worker running
 * sherpa-onnx: Silero voice detection decides when a turn starts and ends, and a
 * streaming recognizer turns it into words. Nothing is uploaded and no
 * transcription service is called; the controller receives final text directly.
 */
const RATE = 16000;
export const SHERPA_SENSITIVITIES = Object.freeze(['low', 'normal', 'high']);
const DEFAULT_CACHE = 'conversation-agent-sherpa-v1';

/** Streaming linear resampler that keeps its phase between microphone frames. */
export function createStreamResampler(inputRate, outputRate = RATE) {
  if (!Number.isFinite(inputRate) || inputRate < 8000 || inputRate > 192000) throw new TypeError('Use a supported microphone sample rate.');
  const step = inputRate / outputRate;
  let position = 0, previous = 0, primed = false;
  return function resample(frame) {
    if (!(frame instanceof Float32Array) || !frame.length) return new Float32Array(0);
    if (inputRate === outputRate) return frame.slice();
    // Index -1 refers to the last sample of the previous frame; a point needing the
    // next frame's first sample waits for it.
    const at = index => index < 0 ? previous : frame[index];
    if (!primed) { primed = true; previous = frame[0]; }
    const output = [];
    while (position < frame.length - 1) {
      const left = Math.floor(position), fraction = position - left;
      output.push(at(left) * (1 - fraction) + at(left + 1) * fraction);
      position += step;
    }
    position -= frame.length; previous = frame[frame.length - 1];
    return Float32Array.from(output);
  };
}

/** Reads the manifest written by scripts/fetch-sherpa-assets.mjs. */
export async function loadSherpaManifest(assetBaseUrl, fetchImpl = globalThis.fetch) {
  const base = new URL(assetBaseUrl, globalThis.location?.href);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const response = await fetchImpl(new URL('manifest.json', base).href, { cache: 'no-cache' });
  if (!response.ok) throw new Error('On-device speech files were not found. Run the Sherpa asset script and serve its output folder.');
  const manifest = await response.json();
  const file = key => {
    const entry = manifest?.files?.[key];
    if (!entry?.path) throw new Error(`The on-device speech manifest is missing "${key}".`);
    return { url: new URL(entry.path, base).href, integrity: entry.integrity || undefined };
  };
  const glue = file('glue');
  return {
    version: manifest.version || null,
    runtime: { glue: glue.url, vad: file('vadApi').url, asr: file('asrApi').url, wasmBase: new URL('.', glue.url).href },
    models: { vad: file('vad'), encoder: file('encoder'), decoder: file('decoder'), joiner: file('joiner'), tokens: file('tokens') },
  };
}

/** Same interface as createBrowserAudioInput, but utterances arrive as text. */
export function createSherpaAudioInput({ assetBaseUrl = null, manifest = null,
  windowImpl = globalThis.window, navigatorImpl = globalThis.navigator, documentImpl = globalThis.document,
  AudioContextImpl = windowImpl?.AudioContext || windowImpl?.webkitAudioContext,
  WorkerImpl = windowImpl?.Worker || globalThis.Worker,
  workerUrl = new URL('./sherpa-speech-worker.js', import.meta.url),
  captureModuleUrl = new URL('./browser-audio.js', import.meta.url),
  fetchImpl = globalThis.fetch?.bind(globalThis), cacheName = DEFAULT_CACHE,
  sensitivity = 'normal', pauseMs = 700, maxDurationMs = 60000,
  onLoadProgress = () => {},
} = {}) {
  let generation = 0, session = 0, destroyed = false, muted = false, callbacks = null, resources = null, outputActive = false, outputText = null;
  let settings = { sensitivity: SHERPA_SENSITIVITIES.includes(sensitivity) ? sensitivity : 'normal', pauseMs, maxDurationMs };
  let worker = null, ready = null, loadState = { phase: 'idle', loadedBytes: 0, totalBytes: 0 };

  function onWorkerMessage(event) {
    const message = event.data || {};
    if (message.type === 'progress') {
      const values = Object.values(message.files || {});
      loadState = { phase: 'loading', loadedBytes: values.reduce((sum, item) => sum + (item.bytes || 0), 0), totalBytes: values.reduce((sum, item) => sum + (item.total || 0), 0) };
      try { onLoadProgress({ ...loadState }); } catch {}
      return;
    }
    if (message.type === 'ready' || (message.type === 'error' && loadState.phase !== 'ready')) return;
    // Events belong to one microphone session; anything older is stale.
    if (!resources || message.session !== session || muted) return;
    if (message.type === 'speech-start') { callbacks?.onSpeechStart?.(); callbacks?.onState?.({ phase: 'capturing' }); }
    else if (message.type === 'partial') callbacks?.onPartial?.(message.text);
    else if (message.type === 'discard') callbacks?.onState?.({ phase: 'monitoring' });
    else if (message.type === 'final') {
      callbacks?.onState?.({ phase: 'monitoring' });
      callbacks?.onUtterance?.({ text: message.text, durationMs: message.durationMs, utteranceId: message.utteranceId, mimeType: 'text/plain', audio: null });
    } else if (message.type === 'error') callbacks?.onWarning?.(message.message);
  }

  /** Downloads (or reads cached) models and starts the worker. Safe to call early. */
  function preload() {
    if (destroyed) return Promise.reject(new Error('The microphone input is closed.'));
    if (ready) return ready;
    ready = (async () => {
      if (typeof WorkerImpl !== 'function') throw new Error('On-device listening needs Web Worker support. Use typing instead.');
      const assets = manifest || await loadSherpaManifest(assetBaseUrl, fetchImpl);
      worker = new WorkerImpl(workerUrl);
      loadState = { phase: 'loading', loadedBytes: 0, totalBytes: 0 };
      await new Promise((resolve, reject) => {
        const listener = event => {
          if (event.data?.type === 'ready') { worker.removeEventListener('message', listener); resolve(); }
          else if (event.data?.type === 'error') { worker.removeEventListener('message', listener); reject(new Error(event.data.message)); }
        };
        worker.addEventListener('message', listener);
        worker.addEventListener('message', onWorkerMessage);
        worker.addEventListener('error', () => reject(new Error('On-device listening could not start. Use typing instead.')), { once: true });
        worker.postMessage({ type: 'init', runtime: assets.runtime, models: assets.models, settings, cacheName });
      });
      loadState = { ...loadState, phase: 'ready' };
      try { onLoadProgress({ ...loadState }); } catch {}
    })();
    ready.catch(() => { try { worker?.terminate?.(); } catch {} worker = null; ready = null; loadState = { phase: 'error', loadedBytes: 0, totalBytes: 0 }; });
    return ready;
  }

  function release(value) {
    if (!value) return;
    if (value.processor) { value.processor.onaudioprocess = null; if (value.processor.port) { value.processor.port.onmessage = null; value.processor.port.close?.(); } }
    for (const node of [value.source, value.processor, value.silentGain]) { try { node?.disconnect?.(); } catch {} }
    for (const track of value.stream?.getTracks?.() || []) { track.onended = null; try { track.stop(); } catch {} }
    try { Promise.resolve(value.context?.close?.()).catch(() => {}); } catch {}
  }

  function stop() {
    generation++; session++;
    const previous = resources; resources = null; release(previous);
    worker?.postMessage({ type: 'reset', session });
    callbacks?.onState?.({ phase: 'off' });
  }

  async function start(options = callbacks) {
    if (destroyed) throw new Error('The microphone input is closed.');
    if (!options) throw new Error('Microphone callbacks are required.');
    stop(); callbacks = options; muted = false;
    if (documentImpl?.hidden) throw new Error('Keep the page visible to use its microphone.');
    if (!windowImpl?.isSecureContext || typeof navigatorImpl?.mediaDevices?.getUserMedia !== 'function' || !AudioContextImpl) throw new Error('Microphone capture needs HTTPS and browser audio support. Use typing instead.');
    const epoch = generation;
    const value = { context: new AudioContextImpl(), stream: null, source: null, processor: null, silentGain: null };
    resources = value; callbacks.onState?.({ phase: 'starting' });
    const valid = () => !destroyed && !muted && generation === epoch && resources === value && !documentImpl?.hidden;
    // Resume before awaiting permission or downloads, within the initiating gesture.
    const resume = Promise.resolve(value.context.resume?.()).then(() => null, error => error);
    const loading = preload().then(() => null, error => error);
    try {
      const stream = await navigatorImpl.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (!valid()) { for (const track of stream.getTracks()) track.stop(); release(value); return; }
      value.stream = stream;
      const resumeError = await resume; if (resumeError) throw resumeError;
      const loadError = await loading; if (loadError) { loadError.speechModel = true; throw loadError; }
      if (!valid()) { release(value); return; }
      const settingsNow = stream.getAudioTracks?.()[0]?.getSettings?.() || {};
      if (settingsNow.echoCancellation === false) callbacks.onWarning?.('Browser echo cancellation is unavailable. Headphones work best; the app also ignores its own voice where it can.');
      session++;
      const current = session;
      worker.postMessage({ type: 'reset', session: current });
      worker.postMessage({ type: 'output', active: outputActive, text: outputText });
      const resample = createStreamResampler(value.context.sampleRate, RATE);
      const send = frame => {
        if (!valid() || current !== session) return;
        const samples = resample(frame);
        if (samples.length) worker.postMessage({ type: 'audio', session: current, samples }, [samples.buffer]);
      };
      value.source = value.context.createMediaStreamSource(stream);
      value.silentGain = value.context.createGain(); value.silentGain.gain.value = 0;
      if (value.context.audioWorklet && windowImpl.AudioWorkletNode) {
        await value.context.audioWorklet.addModule(new URL(captureModuleUrl, import.meta.url).href);
        if (!valid()) { release(value); return; }
        value.processor = new windowImpl.AudioWorkletNode(value.context, 'conversation-agent-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        value.processor.port.onmessage = event => { if (event.data instanceof Float32Array) send(event.data); };
      } else {
        value.processor = value.context.createScriptProcessor(2048, 1, 1);
        value.processor.onaudioprocess = event => send(event.inputBuffer.getChannelData(0));
      }
      value.source.connect(value.processor); value.processor.connect(value.silentGain); value.silentGain.connect(value.context.destination);
      for (const track of stream.getTracks()) track.onended = () => { if (valid()) { stop(); callbacks.onState?.({ phase: 'unavailable' }); callbacks.onWarning?.('The microphone disconnected. Use typing or start again.'); } };
      callbacks.onState?.({ phase: 'monitoring' });
    } catch (error) {
      release(value); if (resources === value) resources = null;
      if (generation !== epoch || destroyed || muted) return;
      if (error?.name === 'NotAllowedError') throw new Error('Microphone permission was denied. Use typing or allow it in browser settings.');
      if (error?.speechModel) throw new Error(String(error.message || 'On-device listening could not start. Use typing instead.').slice(0, 300));
      throw new Error('Microphone capture could not start. Use typing instead.');
    }
  }

  const onHidden = () => { if (documentImpl?.hidden) stop(); };
  documentImpl?.addEventListener?.('visibilitychange', onHidden);
  return { start, stop, preload,
    setMuted(value) { muted = Boolean(value); if (muted) stop(); else if (callbacks && !resources) void start(callbacks).catch(error => { callbacks?.onState?.({ phase: 'unavailable' }); callbacks?.onWarning?.(error.message); }); },
    setOutputActive(value) { outputActive = Boolean(value); worker?.postMessage({ type: 'output', active: outputActive }); },
    /** The words currently being spoken, so they are not mistaken for the person. */
    setOutputText(text) { outputText = typeof text === 'string' ? text.slice(0, 24000) : null; worker?.postMessage({ type: 'output', active: outputActive, text: outputText }); },
    /** 'low' ignores more background sound; 'high' catches quiet voices. */
    setSensitivity(value) { if (!SHERPA_SENSITIVITIES.includes(value)) return; settings = { ...settings, sensitivity: value }; worker?.postMessage({ type: 'config', settings }); },
    /** How long a pause ends your turn, in milliseconds (300–2000). */
    setPauseMs(value) { settings = { ...settings, pauseMs: Number(value) || 700 }; worker?.postMessage({ type: 'config', settings }); },
    state: () => ({ active: Boolean(resources?.stream), muted, sampleRate: RATE, sensitivity: settings.sensitivity, pauseMs: settings.pauseMs, model: { ...loadState } }),
    destroy() {
      stop(); destroyed = true; callbacks = null; documentImpl?.removeEventListener?.('visibilitychange', onHidden);
      try { worker?.postMessage({ type: 'close' }); worker?.terminate?.(); } catch {}
      worker = null; ready = null;
    },
  };
}
