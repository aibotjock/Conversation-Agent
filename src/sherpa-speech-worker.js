/* Conversation-Agent on-device listening worker (classic Web Worker script).
 *
 * Runs Silero voice detection and a streaming Zipformer recognizer from
 * sherpa-onnx (WebAssembly) off the main thread. Audio never leaves the device.
 * Only words reach the page: noise without recognizable words never starts a turn.
 *
 * Messages in:  init, config, audio, output, reset, close
 * Messages out: ready, progress, speech-start, partial, final, discard, error
 */
'use strict';
(function (scope) {
  const RATE = 16000, WINDOW = 512;
  const SENSITIVITY = { low: 0.65, normal: 0.5, high: 0.35 };
  const clamp = (value, fallback, min, max) => Math.max(min, Math.min(max, Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : fallback));

  let api = null, vad = null, recognizer = null, stream = null, closed = false;
  let session = 0, settings = null;
  let pending = new Float32Array(0), ring = [], ringCount = 0;
  let captured = 0, partial = '', announced = false, utterances = 0;
  let outputActive = false, outputTail = 0, referenceWords = null;

  const post = message => { if (!closed) scope.postMessage(message); };
  const fail = error => post({ type: 'error', session, message: String(error?.message || error || 'On-device listening failed.').slice(0, 300) });

  function normalizeSettings(value = {}) {
    const sensitivity = Object.hasOwn(SENSITIVITY, value.sensitivity) ? value.sensitivity : 'normal';
    return {
      sensitivity,
      threshold: SENSITIVITY[sensitivity],
      pauseMs: clamp(value.pauseMs, 700, 300, 2000),
      minSpeechMs: clamp(value.minSpeechMs, 250, 100, 1000),
      preRollMs: clamp(value.preRollMs, 800, 300, 2000),
      maxDurationMs: clamp(value.maxDurationMs, 60000, 3000, 60000),
      echoOverlap: clamp(value.echoOverlap, 0.6, 0.3, 1),
    };
  }

  const words = text => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean);
  // Streaming English models emit upper-case text without punctuation.
  function tidy(text) {
    const value = String(text || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/\bi\b/g, 'I').replace(/\bi'(m|ll|ve|d)\b/g, "I'$1");
    return value ? value[0].toUpperCase() + value.slice(1) : '';
  }
  function soundsLikeOwnVoice(text) {
    if (!referenceWords?.size || !(outputActive || outputTail > 0)) return false;
    const heard = words(text);
    if (!heard.length) return false;
    return heard.filter(word => referenceWords.has(word)).length / heard.length >= settings.echoOverlap;
  }
  // While the device is speaking, require three words that are not its own reply.
  function realSpeech(text) {
    const count = words(text).length;
    if (!count) return false;
    if (outputActive || outputTail > 0) return count >= 3 && !soundsLikeOwnVoice(text);
    return true;
  }

  function createVad() {
    vad?.free?.();
    vad = api.createVad(api.Module, {
      sileroVad: { model: api.files.vad, threshold: settings.threshold, minSilenceDuration: settings.pauseMs / 1000,
        minSpeechDuration: settings.minSpeechMs / 1000, maxSpeechDuration: settings.maxDurationMs / 1000 + 1, windowSize: WINDOW },
      tenVad: { model: '', threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: 256 },
      sampleRate: RATE, numThreads: 1, provider: 'cpu', debug: 0, bufferSizeInSeconds: 70,
    });
  }

  function createRecognizer() {
    recognizer = api.createOnlineRecognizer(api.Module, {
      featConfig: { sampleRate: RATE, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: api.files.encoder, decoder: api.files.decoder, joiner: api.files.joiner },
        paraformer: { encoder: '', decoder: '' }, zipformer2Ctc: { model: '' }, nemoCtc: { model: '' }, toneCtc: { model: '' },
        tokens: api.files.tokens, numThreads: 1, provider: 'cpu', debug: 0, modelType: '', modelingUnit: 'cjkchar', bpeVocab: '',
      },
      decodingMethod: 'greedy_search', maxActivePaths: 4,
      // Voice detection owns turn endings; the recognizer only produces words.
      enableEndpoint: 0, rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: 1.2, rule3MinUtteranceLength: 20,
      hotwordsFile: '', hotwordsScore: 1.5, ctcFstDecoderConfig: { graph: '', maxActive: 3000 }, ruleFsts: '', ruleFars: '',
    });
  }

  function addRing(frame) {
    const limit = Math.round(RATE * settings.preRollMs / 1000);
    ring.push(frame); ringCount += frame.length;
    while (ringCount - ring[0].length >= limit) ringCount -= ring.shift().length;
  }

  function dropStream() {
    try { stream?.free?.(); } catch {}
    stream = null; captured = 0; partial = ''; announced = false;
  }

  function resetAll() {
    dropStream(); pending = new Float32Array(0); ring = []; ringCount = 0;
    try { vad?.reset?.(); } catch {}
  }

  function decode() {
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    return String(recognizer.getResult(stream)?.text || '').trim();
  }

  function openStream() {
    stream = recognizer.createStream(); captured = 0; partial = ''; announced = false;
    // The streaming model needs a moment of lead-in before the first word or it drops it.
    stream.acceptWaveform(RATE, new Float32Array(Math.round(RATE * 0.5)));
    for (const frame of ring) { stream.acceptWaveform(RATE, frame); captured += frame.length; }
    ring = []; ringCount = 0;
  }

  function finish(reason) {
    if (!stream) return;
    // A short silent tail lets the recognizer settle its last tokens.
    stream.acceptWaveform(RATE, new Float32Array(Math.round(RATE * 0.3)));
    stream.inputFinished();
    const text = decode(), durationMs = Math.round(captured * 1000 / RATE), wasAnnounced = announced;
    dropStream();
    if (text && (wasAnnounced || realSpeech(text)) && !soundsLikeOwnVoice(text)) {
      post({ type: 'final', session, text: tidy(text), durationMs, reason, utteranceId: `local-${session}-${++utterances}` });
    } else post({ type: 'discard', session, reason: text ? 'echo' : 'no-words' });
  }

  function processWindow(frame) {
    vad.acceptWaveform(frame);
    if (vad.isDetected() && !stream) openStream();
    if (stream) {
      stream.acceptWaveform(RATE, frame); captured += frame.length;
      const text = decode();
      if (text !== partial) {
        partial = text;
        if (!announced && realSpeech(text)) { announced = true; post({ type: 'speech-start', session }); }
        if (announced) post({ type: 'partial', session, text: tidy(text) });
      }
    } else addRing(frame);
    let ended = false;
    while (!vad.isEmpty()) { vad.pop(); ended = true; }
    if (stream && ended) finish('silence');
    else if (stream && captured >= RATE * settings.maxDurationMs / 1000) { finish('limit'); vad.reset(); }
    if (outputTail > 0) outputTail = Math.max(0, outputTail - frame.length);
  }

  function accept(samples) {
    if (!vad || !recognizer || !(samples instanceof Float32Array) || !samples.length) return;
    let buffer = samples;
    if (pending.length) { buffer = new Float32Array(pending.length + samples.length); buffer.set(pending); buffer.set(samples, pending.length); }
    let offset = 0;
    for (; offset + WINDOW <= buffer.length; offset += WINDOW) {
      const frame = buffer.slice(offset, offset + WINDOW);
      for (let i = 0; i < frame.length; i++) frame[i] = Number.isFinite(frame[i]) ? Math.max(-1, Math.min(1, frame[i])) : 0;
      processWindow(frame);
    }
    pending = buffer.slice(offset);
  }

  async function fetchModel(url, integrity, name, cache, progress) {
    // Keyed by content hash, so updated models at the same path are downloaded again.
    const key = integrity ? `${url}${url.includes('?') ? '&' : '?'}sri=${encodeURIComponent(integrity)}` : url;
    let response = cache ? await cache.match(key) : null;
    if (!response) {
      response = await scope.fetch(url, integrity ? { integrity } : undefined);
      if (!response.ok) throw new Error(`Could not download the ${name} speech model (${response.status}).`);
      if (cache) { try { await cache.put(key, response.clone()); } catch {} }
    }
    const total = Number(response.headers?.get?.('content-length')) || 0;
    if (!response.body?.getReader) { const data = new Uint8Array(await response.arrayBuffer()); progress(name, data.length, data.length); return data; }
    const reader = response.body.getReader(), parts = []; let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); loaded += value.length; progress(name, loaded, total);
    }
    const data = new Uint8Array(loaded); let offset = 0;
    for (const part of parts) { data.set(part, offset); offset += part.length; }
    return data;
  }

  async function init(message) {
    settings = normalizeSettings(message.settings);
    const runtime = message.runtime || {};
    scope.importScripts(runtime.glue, runtime.vad, runtime.asr);
    const factory = scope.SherpaOnnx || scope.Module;
    if (typeof factory !== 'function' || !scope.SherpaOnnxVadApi?.createVad || !scope.SherpaOnnxAsrApi?.createOnlineRecognizer) {
      throw new Error('The on-device speech runtime is missing or incompatible. Run the Sherpa asset script again.');
    }
    const Module = await factory({ locateFile: path => new URL(path, runtime.wasmBase || runtime.glue).href, print() {}, printErr() {} });
    if (!Module?.FS?.writeFile) throw new Error('The on-device speech runtime cannot load models.');
    const root = String(message.modelRoot || '/conversation-agent-models');
    try { Module.FS.mkdirTree ? Module.FS.mkdirTree(root) : Module.FS.mkdir(root); } catch {}
    let cache = null;
    try { cache = message.cacheName && scope.caches ? await scope.caches.open(message.cacheName) : null; } catch {}
    const models = message.models || {}, files = {}, loaded = {};
    const progress = (name, bytes, total) => { loaded[name] = { bytes, total }; post({ type: 'progress', session, files: { ...loaded } }); };
    for (const name of ['vad', 'encoder', 'decoder', 'joiner', 'tokens']) {
      const model = models[name];
      if (!model?.url) throw new Error(`The ${name} speech model location is missing.`);
      const data = await fetchModel(model.url, model.integrity, name, cache, progress);
      if (closed) return;
      files[name] = `${root}/${name}-${String(model.url).split('/').pop().replace(/[^A-Za-z0-9._-]/g, '_')}`;
      Module.FS.writeFile(files[name], data);
    }
    api = { Module, files, createVad: scope.SherpaOnnxVadApi.createVad, createOnlineRecognizer: scope.SherpaOnnxAsrApi.createOnlineRecognizer };
    createVad(); createRecognizer();
    // sherpa-onnx returns a null handle (not an exception) for an unusable model.
    if (!vad?.handle || !recognizer?.handle) throw new Error('The on-device speech models could not be loaded. Run the Sherpa asset script again.');
    // Model bytes now live inside the recognizer; free the virtual-file copies.
    for (const name of ['encoder', 'decoder', 'joiner']) { try { Module.FS.unlink(files[name]); } catch {} }
    post({ type: 'ready', session });
  }

  scope.onmessage = async event => {
    const message = event.data || {};
    try {
      if (message.type === 'init') await init(message);
      else if (message.type === 'reset') { session = Number(message.session) || 0; outputActive = false; outputTail = 0; referenceWords = null; resetAll(); }
      else if (message.type === 'audio') { if (message.session === session) accept(message.samples); }
      else if (message.type === 'output') {
        const was = outputActive; outputActive = Boolean(message.active);
        if (was && !outputActive) outputTail = Math.round(RATE * 0.6);
        if (typeof message.text === 'string') referenceWords = new Set(words(message.text));
      } else if (message.type === 'config') {
        const next = normalizeSettings({ ...settings, ...message.settings });
        const rebuild = vad && (next.threshold !== settings.threshold || next.pauseMs !== settings.pauseMs || next.minSpeechMs !== settings.minSpeechMs);
        settings = next;
        if (rebuild) { dropStream(); createVad(); if (!vad?.handle) throw new Error('Voice detection could not restart.'); }
      } else if (message.type === 'close') {
        closed = true; dropStream();
        try { vad?.free?.(); recognizer?.free?.(); } catch {}
        vad = recognizer = null; scope.close?.();
      }
    } catch (error) { fail(error); }
  };
})(self);
