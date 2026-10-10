import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationAgent } from '../src/conversation-core.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture(overrides = {}) {
  const timers = new Map(); let timerId = 0, id = 0;
  const handlers = new Map(), changes = [], sends = [], transcriptions = [], cancellations = [], reports = [], ended = [], plays = [];
  const documentImpl = { hidden: false, addEventListener: (name, callback) => handlers.set(name, callback), removeEventListener: name => handlers.delete(name) };
  const windowImpl = { addEventListener: (name, callback) => handlers.set(name, callback), removeEventListener: name => handlers.delete(name) };
  const input = { callbacks: null, stops: 0, muted: false, output: false,
    start(callbacks) { this.callbacks = callbacks; callbacks.onState({ phase: 'monitoring' }); },
    stop() { this.stops++; }, setMuted(value) { this.muted = value; }, setOutputActive(value) { this.output = value; }, destroy() { this.stop(); } };
  const host = { startSession: async ({ conversationId }) => ({ conversationId, sessionId: 'session' }),
    endSession: value => { ended.push(value); }, cancel: value => { cancellations.push(value); },
    reportPlayback: value => { reports.push(value); },
    transcribe: async value => { transcriptions.push(value); return { text: 'A learner utterance' }; },
    sendTurn: async value => { sends.push(value); return { content: `A reply to ${value.text}`, messageId: `message-${sends.length}`, conversationId: value.conversationId }; }, ...overrides.host };
  const playback = { stops: 0, resumes: 0, output: {},
    play(value) { plays.push(value); value.onStart(); return Promise.resolve(); },
    stop() { this.stops++; }, resume() { this.resumes++; plays.at(-1)?.onStart(); }, state() { return this.output; }, ...overrides.playback };
  const agent = createConversationAgent({ input: overrides.input || input, host, playback,
    documentImpl, windowImpl, onState: state => changes.push(state), createId: () => `turn-${++id}`,
    setTimer: (callback, duration) => { timers.set(++timerId, { callback, duration }); return timerId; }, clearTimer: value => timers.delete(value), ...overrides.options });
  return { agent, input, host, playback, changes, sends, transcriptions, cancellations, reports, ended, plays, timers, handlers, documentImpl };
}

test('full duplex barge-in stops playback before transcription and saves a conservative checkpoint', async () => {
  const saved = deferred(); const f = fixture({ host: { reportPlayback: value => { f.reports.push(value); return saved.promise; } } });
  await f.agent.start({ conversationId: 'conversation' }); await f.agent.sendText('First');
  assert.equal(f.agent.state().outputState, 'playing'); assert.equal(f.input.output, true);
  const inputStops = f.input.stops, playbackStops = f.playback.stops;
  f.plays[0].onChunkEnd({ completedChunks: 1 }); f.plays[0].onPreparing({ chunkIndex: 1 }); f.plays[0].onStart();
  f.input.callbacks.onSpeechStart();
  assert.equal(f.playback.stops, playbackStops + 1); assert.equal(f.input.stops, inputStops);
  assert.equal(f.agent.state().inputState, 'capturing');
  f.input.callbacks.onUtterance({ utteranceId: 'utterance-1', audio: new Blob(['wav']), mimeType: 'audio/wav' }); await flush();
  assert.equal(f.transcriptions.length, 1); assert.equal(f.sends.length, 1);
  assert.equal(f.reports[0].status, 'interrupted'); assert.equal(f.reports[0].completedChunks, 1);
  assert.equal(f.reports[0].complete, false);
  saved.resolve(); await flush(); assert.equal(f.sends.length, 2); f.agent.destroy();
});

test('stable utterance IDs suppress duplicate submission while repeated words in a new turn remain valid', async () => {
  const f = fixture(); await f.agent.start({ conversationId: 'conversation' });
  const utterance = { utteranceId: 'one', audio: new Blob(['wav']), mimeType: 'audio/wav' };
  f.input.callbacks.onUtterance(utterance); f.input.callbacks.onUtterance(utterance); await flush();
  assert.equal(f.transcriptions.length, 1); assert.equal(f.sends.length, 1);
  f.input.callbacks.onSpeechStart(); f.input.callbacks.onUtterance({ ...utterance, utteranceId: 'two' }); await flush();
  assert.equal(f.transcriptions.length, 2); assert.equal(f.sends.length, 2); f.agent.destroy();
});

test('late transcription and generated replies cannot overwrite a newer turn or restart speech', async () => {
  const old = deferred(); const f = fixture({ host: { transcribe: () => old.promise } });
  await f.agent.start({ conversationId: 'conversation' }); f.input.callbacks.onUtterance({ utteranceId: 'one', audio: new Blob(['wav']) }); await flush();
  await f.agent.sendText('New message'); assert.equal(f.plays.length, 1);
  old.resolve({ text: 'Stale transcript' }); await flush();
  assert.equal(f.agent.state().userCaption, 'New message'); assert.equal(f.sends.length, 1);
  const generated = deferred(); f.host.sendTurn = () => generated.promise;
  void f.agent.sendText('Pending reply'); await flush(); await f.agent.stop();
  generated.resolve({ content: 'Late output', messageId: 'late' }); await flush();
  assert.equal(f.plays.length, 1); assert.equal(f.agent.active(), false); f.agent.destroy();
});

test('explicit cancellation uses the active transcription ID then the chat turn ID', async () => {
  const transcript = deferred(), generated = deferred(); const f = fixture({ host: { transcribe: () => transcript.promise, sendTurn: () => generated.promise } });
  await f.agent.start({ conversationId: 'conversation' }); f.input.callbacks.onUtterance({ utteranceId: 'wav-request', audio: new Blob(['wav']) }); await flush();
  f.agent.interrupt(); await flush(); assert.equal(f.cancellations.at(-1).requestId, 'wav-request');
  f.input.callbacks.onUtterance({ utteranceId: 'second-wav', audio: new Blob(['wav']) }); await flush(); transcript.resolve({ text: 'Final words' }); await flush();
  const activeTurnId = f.agent.state().turnEpoch; f.agent.interrupt(); await flush();
  assert.match(f.cancellations.at(-1).requestId, /^turn-/); assert.equal(f.cancellations.at(-1).requestId, f.cancellations.at(-1).turnId);
  assert.ok(activeTurnId > 0); generated.resolve({ content: 'Late reply', messageId: 'late' }); await flush(); f.agent.destroy();
});

test('blocked audio resumes the prepared recording without another host request and ends once', async () => {
  const f = fixture(); await f.agent.start({ conversationId: 'conversation' }); await f.agent.sendText('Hello');
  const callbacks = f.plays[0]; callbacks.onBlocked('Tap Play audio'); assert.equal(f.agent.state().audioBlocked, true);
  assert.equal(f.agent.state().audioBlockReason, null, 'Legacy adapters do not establish a permission failure.');
  await f.agent.playAudio(); assert.equal(f.playback.resumes, 1); assert.equal(f.sends.length, 1);
  assert.equal(f.agent.state().audioBlockReason, null);
  callbacks.onChunkEnd({ completedChunks: 2 }); callbacks.onEnd(); callbacks.onEnd(); callbacks.onStart(); await flush();
  assert.equal(f.reports.filter(value => value.status === 'completed').length, 1);
  assert.equal(f.reports[0].completedChunks, 2); assert.equal(f.agent.state().outputState, 'idle'); f.agent.destroy();
});

test('playback block reasons are bounded and cleared on resume, replacement, interruption and session stop', async () => {
  const f = fixture(); await f.agent.start({ conversationId: 'conversation' }); await f.agent.sendText('First');
  const first = f.plays[0];
  for (const reason of ['permission', 'stalled', 'paused']) {
    first.onBlocked('Prepared recording needs attention.', { reason });
    assert.equal(f.agent.state().audioBlockReason, reason); assert.equal(f.agent.state().outputState, 'blocked');
    assert.equal(f.input.output, false);
    await f.agent.playAudio();
    assert.equal(f.agent.state().audioBlockReason, null); assert.equal(f.agent.state().audioBlocked, false);
    assert.equal(f.agent.state().outputState, 'playing');
  }
  first.onBlocked('Unknown recovery cause.', { reason: 'untrusted-value' });
  assert.equal(f.agent.state().audioBlockReason, null);
  first.onBlocked('Stalled.', { reason: 'stalled' }); await f.agent.sendText('Replacement');
  assert.equal(f.agent.state().audioBlockReason, null); assert.equal(f.agent.state().audioBlocked, false);
  first.onBlocked('Stale permission callback.', { reason: 'permission' });
  assert.equal(f.agent.state().audioBlockReason, null); assert.equal(f.agent.state().outputState, 'playing');
  f.plays[1].onBlocked('Paused.', { reason: 'paused' }); f.agent.interrupt();
  assert.equal(f.agent.state().audioBlockReason, null); assert.equal(f.agent.state().audioBlocked, false);
  await f.agent.sendText('Last'); f.plays[2].onBlocked('Permission.', { reason: 'permission' }); await f.agent.stop();
  assert.equal(f.agent.state().audioBlockReason, null); assert.equal(f.agent.state().audioBlocked, false);
  await f.agent.start({ conversationId: 'conversation' }); assert.equal(f.agent.state().audioBlockReason, null);
  assert.equal(f.sends.length, 3, 'Recovery never creates a new host request.'); f.agent.destroy();
});

test('a failed replacement clears obsolete blocked-audio recovery rather than exposing a stale recording', async () => {
  const f = fixture(); await f.agent.start({ conversationId: 'conversation' }); await f.agent.sendText('First');
  f.plays[0].onBlocked('Audio stalled.', { reason: 'stalled' });
  await f.agent.sendText('');
  assert.equal(f.agent.state().outputState, 'idle'); assert.equal(f.agent.state().audioBlocked, false);
  assert.equal(f.agent.state().audioBlockReason, null); assert.equal(f.sends.length, 1);
  await f.agent.playAudio(); assert.equal(f.playback.resumes, 0); f.agent.destroy();
});

test('microphone failure retains typed conversation without automatically reacquiring permission', async () => {
  let starts = 0; const f = fixture({ input: { start() { starts++; throw new Error('Permission denied'); }, stop() {}, setOutputActive() {} } });
  await f.agent.start({ conversationId: 'conversation' }); assert.equal(f.agent.state().inputState, 'unavailable');
  await f.agent.sendText('Typed fallback'); assert.equal(f.plays.length, 1); assert.equal(starts, 1); f.agent.destroy();
});

test('a stopped delayed session is closed even when its host ignores abort', async () => {
  const pending = deferred(); const f = fixture({ host: { startSession: () => pending.promise } });
  const started = f.agent.start({ conversationId: 'conversation' }); await flush(); await f.agent.stop();
  pending.resolve({ sessionId: 'late-session', conversationId: 'conversation' }); await started; await flush();
  assert.deepEqual(f.ended.map(value => value.sessionId), ['late-session']); assert.equal(f.agent.active(), false); f.agent.destroy();
});

test('failed and hung playback acknowledgments do not freeze later turns or retry paid work', async () => {
  const f = fixture({ host: { reportPlayback: () => Promise.reject(new Error('Checkpoint unavailable')) } });
  await f.agent.start({ conversationId: 'conversation' }); await f.agent.sendText('First'); f.agent.interrupt(); await flush();
  await f.agent.sendText('Second'); assert.equal(f.sends.length, 2);
  const hanging = deferred(); let signal; f.host.reportPlayback = value => { signal = value.signal; return hanging.promise; };
  f.agent.interrupt(); await flush(); const next = f.agent.sendText('Third'); await flush(); assert.equal(f.sends.length, 2);
  const timer = [...f.timers.values()].find(value => value.duration === 2000); assert.ok(timer); timer.callback();
  await next; assert.equal(signal.aborted, true); assert.equal(f.sends.length, 3);
  hanging.resolve(); await flush(); assert.equal(f.sends.length, 3); f.agent.destroy();
});

test('background stop removes microphone activity and all stale playback callbacks', async () => {
  const f = fixture(); await f.agent.start({ conversationId: 'conversation' }); await f.agent.sendText('First');
  const callbacks = f.plays[0]; f.documentImpl.hidden = true; f.handlers.get('visibilitychange')();
  assert.equal(f.agent.active(), false); assert.equal(f.agent.state().inputState, 'off'); assert.ok(f.input.stops > 0);
  callbacks.onStart(); callbacks.onEnd(); assert.equal(f.agent.state().outputState, 'idle');
  f.agent.clearCaptions(); assert.equal(f.agent.state().userCaption, ''); assert.equal(f.agent.state().assistantCaption, '');
  f.agent.destroy(); assert.equal(f.handlers.size, 0); await assert.rejects(f.agent.start(), /closed/);
});

test('text-only and invalid host replies never invoke audio and failures make no automatic retries', async () => {
  const f = fixture({ host: { sendTurn: async () => ({ content: 'Read the visible reply.', messageId: 'message', readoutAllowed: false }) } });
  await f.agent.start({ conversationId: 'conversation' }); await f.agent.sendText('Hello'); assert.equal(f.plays.length, 0);
  let attempts = 0; f.host.sendTurn = async () => { attempts++; return { content: 'x'.repeat(24001), messageId: 'bad' }; };
  await f.agent.sendText('Try'); await flush(); assert.equal(attempts, 1); assert.equal(f.plays.length, 0);
  assert.match(f.agent.state().warning, /valid conversation reply/); f.agent.destroy();
});

test('a microphone-off event never advertises listening and typed fallback remains reachable', async () => {
  const f = fixture(); await f.agent.start({ conversationId: 'conversation' });
  f.input.callbacks.onState({ phase: 'off' }); assert.equal(f.agent.state().phase, 'paused');
  f.input.callbacks.onState({ phase: 'unavailable' }); await f.agent.sendText('Typed after disconnect');
  assert.equal(f.sends.length, 1); assert.equal(f.agent.state().userCaption, 'Typed after disconnect'); f.agent.destroy();
});

test('browser offline stops microphone and pending audio without automatically restarting online', async () => {
  const f = fixture(); await f.agent.start({ conversationId: 'conversation' }); await f.agent.sendText('Before network loss');
  const callbacks = f.plays[0], stops = f.input.stops;
  f.handlers.get('offline')(); await flush();
  assert.equal(f.agent.active(), false); assert.equal(f.agent.state().inputState, 'off'); assert.ok(f.input.stops > stops);
  assert.ok(f.cancellations.length > 0); assert.equal(f.input.output, false);
  assert.match(f.agent.state().message, /Connection lost.*microphone is off/);
  assert.equal(f.handlers.has('online'), false); f.handlers.get('online')?.(); callbacks.onStart(); callbacks.onEnd(); await flush();
  assert.equal(f.agent.active(), false); assert.equal(f.plays.length, 1); assert.equal(f.sends.length, 1);
  f.agent.destroy(); assert.equal(f.handlers.has('offline'), false);
});
