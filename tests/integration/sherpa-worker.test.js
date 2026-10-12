/* Real-model check of the on-device listening worker (opt-in; not part of `npm test`).
 *
 *   SHERPA_ONNX_NODE=/path/to/node_modules/sherpa-onnx \
 *   SHERPA_TEST_MODELS=/path/to/models npm run test:sherpa
 *
 * SHERPA_TEST_MODELS must contain silero_vad.onnx and the extracted
 * sherpa-onnx-streaming-zipformer-en-20M-2023-02-17 folder. The worker script runs
 * unchanged against the Node build of the same sherpa-onnx WebAssembly runtime.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrapClassicApi } from '../../scripts/fetch-sherpa-assets.mjs';

const runtimeDir = process.env.SHERPA_ONNX_NODE;
const modelDir = process.env.SHERPA_TEST_MODELS;
const asrDir = modelDir && join(modelDir, 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17');
const skip = !runtimeDir || !modelDir || !existsSync(join(modelDir, 'silero_vad.onnx')) || !existsSync(asrDir || '')
  ? 'Set SHERPA_ONNX_NODE and SHERPA_TEST_MODELS to run real-model checks.' : false;
const RATE = 16000;

async function startWorker(settings = {}) {
  const require = createRequire(join(runtimeDir, 'index.js'));
  const vadSource = wrapClassicApi(await readFile(join(runtimeDir, 'sherpa-onnx-vad.js'), 'utf8'), 'SherpaOnnxVadApi', ['createVad']);
  const asrSource = wrapClassicApi(await readFile(join(runtimeDir, 'sherpa-onnx-asr.js'), 'utf8'), 'SherpaOnnxAsrApi', ['createOnlineRecognizer']);
  const files = { 'vad.js': vadSource, 'asr.js': asrSource };
  const modelRoot = await mkdtemp(join(tmpdir(), 'sherpa-worker-'));
  const events = [];
  let waiters = [];
  const self = {
    postMessage(message) { events.push(message); waiters = waiters.filter(waiter => !waiter(message)); },
    importScripts(...urls) {
      for (const url of urls) {
        const name = String(url).split('/').pop();
        if (name === 'glue.js') self.SherpaOnnx = async () => { const module = {}; require('./sherpa-onnx-wasm-nodejs.js')(module); return module; };
        else new Function('self', files[name])(self);
      }
    },
    async fetch(url) { return new Response(await readFile(new URL(url))); },
    close() {},
  };
  new Function('self', await readFile(new URL('../../src/sherpa-speech-worker.js', import.meta.url), 'utf8'))(self);
  const send = data => self.onmessage({ data });
  const next = predicate => new Promise(resolve => { waiters.push(message => predicate(message) && (resolve(message), true)); });
  const ready = next(message => message.type === 'ready' || message.type === 'error');
  const file = path => ({ url: new URL(`file://${path}`).href });
  send({ type: 'init', modelRoot, settings,
    runtime: { glue: 'https://assets.test/runtime/glue.js', vad: 'https://assets.test/runtime/vad.js', asr: 'https://assets.test/runtime/asr.js' },
    models: { vad: file(join(modelDir, 'silero_vad.onnx')), encoder: file(join(asrDir, 'encoder-epoch-99-avg-1.int8.onnx')),
      decoder: file(join(asrDir, 'decoder-epoch-99-avg-1.int8.onnx')), joiner: file(join(asrDir, 'joiner-epoch-99-avg-1.int8.onnx')), tokens: file(join(asrDir, 'tokens.txt')) } });
  const result = await ready;
  assert.equal(result.type, 'ready', result.message);
  return { send, events,
    close: async () => { send({ type: 'close' }); await rm(modelRoot, { recursive: true, force: true }); } };
}

// 16-bit PCM mono WAV reader for the model's bundled test recordings.
async function readWave(path) {
  const data = await readFile(path), view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 12, rate = 0;
  while (offset < data.length) {
    const id = data.toString('ascii', offset, offset + 4), size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') rate = view.getUint32(offset + 12, true);
    if (id === 'data') {
      const samples = new Float32Array(size / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(offset + 8 + i * 2, true) / 32768;
      assert.equal(rate, RATE); return { samples };
    }
    offset += 8 + size;
  }
  throw new Error('No audio data.');
}

// Streams audio in 2048-sample frames, like a microphone, with silence around it.
function feed(worker, session, samples, { leadMs = 800, tailMs = 1500 } = {}) {
  const all = new Float32Array(RATE * leadMs / 1000 + samples.length + RATE * tailMs / 1000);
  all.set(samples, RATE * leadMs / 1000);
  for (let i = 0; i < all.length; i += 2048) worker.send({ type: 'audio', session, samples: all.slice(i, i + 2048) });
}

test('speech becomes final text quickly, with live partial captions', { skip }, async () => {
  const worker = await startWorker();
  try {
    const { samples } = await readWave(join(asrDir, 'test_wavs/0.wav'));
    worker.send({ type: 'reset', session: 1 });
    const started = performance.now();
    feed(worker, 1, samples);
    const elapsed = performance.now() - started;
    const types = worker.events.filter(event => event.session === 1).map(event => event.type);
    assert.equal(types[0], 'speech-start');
    assert.ok(types.filter(type => type === 'partial').length >= 3, 'partial captions while speaking');
    const final = worker.events.find(event => event.type === 'final');
    assert.match(final.text, /^After early nightfall the yellow lamps would light up here and there the squalid quarter of the/);
    assert.equal(final.reason, 'silence');
    assert.ok(final.durationMs > 6000 && final.durationMs < 8000);
    // Processing ~9 s of audio must take far less than 9 s on one core.
    assert.ok(elapsed < 4000, `processing took ${Math.round(elapsed)} ms`);
    console.log(`  ${Math.round(elapsed)} ms to process ${Math.round((samples.length / RATE + 2.3) * 1000)} ms of audio: "${final.text}"`);
  } finally { await worker.close(); }
});

test('background noise and knocks without words never start a turn', { skip }, async () => {
  const worker = await startWorker();
  try {
    worker.send({ type: 'reset', session: 2 });
    let seed = 7; const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
    const noise = new Float32Array(RATE * 4);
    for (let i = 0; i < noise.length; i++) noise[i] = random() * 0.05;
    for (const at of [0.5, 1.7, 2.9]) for (let i = 0; i < 800; i++) noise[Math.round(at * RATE) + i] += (random() * 0.9) * Math.exp(-i / 150);
    feed(worker, 2, noise);
    assert.deepEqual(worker.events.filter(event => ['speech-start', 'final', 'partial'].includes(event.type)), []);
  } finally { await worker.close(); }
});

test('the device hearing its own reply is ignored, but the person interrupting is not', { skip }, async () => {
  const worker = await startWorker();
  try {
    const { samples } = await readWave(join(asrDir, 'test_wavs/0.wav'));
    worker.send({ type: 'reset', session: 3 });
    worker.send({ type: 'output', active: true, text: 'After early nightfall, the yellow lamps would light up here and there, the squalid quarter of the brothels.' });
    feed(worker, 3, samples);
    assert.equal(worker.events.some(event => event.session === 3 && ['speech-start', 'final'].includes(event.type)), false, 'own voice ignored');
    assert.ok(worker.events.some(event => event.session === 3 && event.type === 'discard' && event.reason === 'echo'));
    worker.send({ type: 'output', active: true, text: 'Something completely different about cells and energy.' });
    feed(worker, 3, samples);
    assert.ok(worker.events.some(event => event.session === 3 && event.type === 'final'), 'a real interruption is heard');
  } finally { await worker.close(); }
});

test('events from an older microphone session are tagged so the page can drop them', { skip }, async () => {
  const worker = await startWorker({ pauseMs: 500 });
  try {
    const { samples } = await readWave(join(asrDir, 'test_wavs/0.wav'));
    worker.send({ type: 'reset', session: 4 });
    feed(worker, 4, samples.slice(0, RATE * 2), { tailMs: 0 });
    worker.send({ type: 'reset', session: 5 });
    feed(worker, 4, samples); // late frames from the stopped session
    assert.equal(worker.events.some(event => event.type === 'final'), false);
    feed(worker, 5, samples);
    assert.equal(worker.events.filter(event => event.type === 'final').every(event => event.session === 5), true);
    assert.equal(worker.events.filter(event => event.type === 'final').length, 1);
  } finally { await worker.close(); }
});
