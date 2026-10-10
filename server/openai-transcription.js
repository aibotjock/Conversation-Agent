import { createHash, randomUUID } from 'node:crypto';

export const CONVERSATION_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
export const CONVERSATION_AUDIO_LIMITS = Object.freeze({
  sessionMs: 600000, maxUtteranceMs: 60000, minUtteranceMs: 120,
  maxAudioBytes: 5760044, maxJsonBytes: 7680500, maxSessionRequests: 60,
  maxSessionsPerHour: 60, maxHourlyRequests: 360, maxHourlyAudioMs: 3600000, timeoutMs: 30000, cacheMs: 60000,
  maxLedgerEntries: 10000, maxProviderBytes: 65536,
});
const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = value => createHash('sha256').update(value).digest('hex');
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 10000000;

export class ConversationAudioError extends Error {
  constructor(status, message, code = 'conversation_audio_unavailable') {
    super(message); this.name = 'ConversationAudioError'; this.status = status; this.code = code;
  }
}
const fail = (status, message, code) => { throw new ConversationAudioError(status, message, code); };
export function conversationAudioId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(400, 'Use a valid conversation audio UUID.', 'invalid_conversation_audio_id');
  return value.toLowerCase();
}

/** Validate bytes rather than trusting a browser-provided MIME, duration or filename. */
export function decodeConversationWav(base64) {
  const max = CONVERSATION_AUDIO_LIMITS.maxAudioBytes;
  if (typeof base64 !== 'string' || !base64.length || base64.length > Math.ceil(max / 3) * 4 || base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) fail(400, 'Use a bounded base64 WAV recording.', 'invalid_conversation_audio');
  const audio = Buffer.from(base64, 'base64');
  if (audio.length > max || audio.toString('base64') !== base64 || audio.length < 44 || audio.subarray(0, 4).toString() !== 'RIFF' || audio.subarray(8, 12).toString() !== 'WAVE' || audio.readUInt32LE(4) !== audio.length - 8) fail(400, 'Use a complete PCM WAV recording.', 'invalid_conversation_audio');
  let offset = 12, format, data;
  while (offset < audio.length) {
    if (offset + 8 > audio.length) fail(400, 'The WAV recording is incomplete.', 'invalid_conversation_audio');
    const id = audio.subarray(offset, offset + 4).toString('ascii'), size = audio.readUInt32LE(offset + 4), start = offset + 8;
    if (size > audio.length - start || start + size + (size % 2) > audio.length) fail(400, 'The WAV recording is incomplete.', 'invalid_conversation_audio');
    if (id === 'fmt ') {
      if (format || size !== 16) fail(400, 'Use standard mono PCM16 WAV audio.', 'invalid_conversation_audio');
      const sampleRate = audio.readUInt32LE(start + 4);
      if (audio.readUInt16LE(start) !== 1 || audio.readUInt16LE(start + 2) !== 1 || ![16000, 24000, 48000].includes(sampleRate) || audio.readUInt32LE(start + 8) !== sampleRate * 2 || audio.readUInt16LE(start + 12) !== 2 || audio.readUInt16LE(start + 14) !== 16) fail(400, 'Use mono PCM16 WAV at 16, 24 or 48 kHz.', 'invalid_conversation_audio');
      format = { sampleRate };
    } else if (id === 'data') {
      if (data || !format || size % 2) fail(400, 'Use one complete PCM data chunk.', 'invalid_conversation_audio');
      data = { bytes: size };
    } else fail(400, 'Unsupported WAV metadata is not accepted.', 'invalid_conversation_audio');
    offset = start + size + (size % 2);
  }
  if (!format || !data || offset !== audio.length) fail(400, 'The WAV recording is incomplete.', 'invalid_conversation_audio');
  const durationMs = data.bytes / (format.sampleRate * 2) * 1000;
  if (durationMs < CONVERSATION_AUDIO_LIMITS.minUtteranceMs || durationMs > CONVERSATION_AUDIO_LIMITS.maxUtteranceMs) fail(400, 'Speak for between 0.12 and 60 seconds per turn.', 'conversation_audio_duration');
  return { audio, sampleRate: format.sampleRate, durationMs };
}

function safeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  if (usage.type === 'duration' && Number.isFinite(usage.seconds) && usage.seconds >= 0 && usage.seconds <= 120) return { type: 'duration', seconds: usage.seconds };
  if (usage.type !== 'tokens' || !count(usage.input_tokens) || !count(usage.output_tokens) || !count(usage.total_tokens) || usage.input_tokens + usage.output_tokens !== usage.total_tokens) return null;
  const result = { type: 'tokens', input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, total_tokens: usage.total_tokens };
  const details = usage.input_token_details;
  if (details && count(details.audio_tokens) && count(details.text_tokens) && details.audio_tokens + details.text_tokens === usage.input_tokens) result.input_token_details = { audio_tokens: details.audio_tokens, text_tokens: details.text_tokens };
  return result;
}

async function providerPayload(response) {
  if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length')) > CONVERSATION_AUDIO_LIMITS.maxProviderBytes || !response.body?.getReader) fail(502, 'The transcription provider returned an unexpected response.', 'conversation_audio_provider_format');
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > CONVERSATION_AUDIO_LIMITS.maxProviderBytes) { await reader.cancel(); fail(502, 'The transcription response exceeded its limit.', 'conversation_audio_provider_format'); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof ConversationAudioError) throw error;
    fail(502, 'The transcription provider returned an unusable response.', 'conversation_audio_provider_format');
  }
}

/** Server-owned transcription only; no credentials, free-form prompt or model selector reach the browser. */
export function createConversationAudioService({ env = process.env, fetchImpl = globalThis.fetch, db, now = Date.now, onSessionEnded = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!db?.prepare) throw new Error('Conversation audio requires a durable request ledger.');
  const key = (env.OPENAI_API_KEY || '').trim();
  db.exec("CREATE TABLE IF NOT EXISTS conversation_audio_requests(request_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,scope TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,metadata TEXT); UPDATE conversation_audio_requests SET status='uncertain' WHERE status='pending';");
  const sessions = new Map(), active = new Map(), cache = new Map();
  let stopped = false, starts = [];
  function expire(sessionId, reason) {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    clearTimer(session.timer);
    for (const [id, item] of active) if (item.sessionId === sessionId) {
      item.controller.abort();
      db.prepare("UPDATE conversation_audio_requests SET status='uncertain' WHERE request_id=? AND status='pending'").run(id);
    }
    for (const [id, item] of cache) if (item.sessionId === sessionId) cache.delete(id);
    try { onSessionEnded({ sessionId, conversationId: session.conversationId, reason }); } catch {}
  }
  function prune() {
    for (const [id, session] of sessions) if (session.expiresAt <= now()) expire(id, 'expired');
    for (const [id, value] of cache) if (value.expiresAt <= now()) cache.delete(id);
    starts = starts.filter(time => time > now() - 3600000);
  }
  function requireSession({ sessionId, conversationId, ownerKey }) {
    prune(); sessionId = conversationAudioId(sessionId);
    const session = sessions.get(sessionId);
    if (stopped || !session || session.conversationId !== conversationId || session.ownerKey !== ownerKey) fail(409, 'This voice session is no longer active.', 'conversation_audio_session_inactive');
    return session;
  }
  function options() {
    return { enabled: Boolean(key) && !stopped, provider: 'openai', transcriptionModel: CONVERSATION_TRANSCRIPTION_MODEL, maxDurationMs: CONVERSATION_AUDIO_LIMITS.sessionMs, audio: { format: 'wav', sampleRate: 16000, channels: 1, maxDurationMs: CONVERSATION_AUDIO_LIMITS.maxUtteranceMs, maxBytes: CONVERSATION_AUDIO_LIMITS.maxAudioBytes }, telemetry: { audioReportedToIngenium: false, reason: 'receiver_audio_schema_pending', estimatedCostUsd: null } };
  }
  function start({ conversationId, ownerKey }) {
    prune();
    if (!key || stopped) fail(503, 'OpenAI transcription is not configured on this server.', 'conversation_audio_not_configured');
    if (typeof conversationId !== 'string' || !conversationId || typeof ownerKey !== 'string' || !ownerKey) fail(400, 'Use an authenticated conversation.', 'invalid_conversation_audio_scope');
    if (starts.length >= CONVERSATION_AUDIO_LIMITS.maxSessionsPerHour) fail(429, 'The hourly voice-session limit has been reached.', 'conversation_audio_session_limit');
    for (const [id, session] of sessions) {
      if (session.ownerKey !== ownerKey) fail(409, 'A voice session is already active in another sign-in.', 'conversation_audio_busy');
      expire(id, 'replaced');
    }
    const sessionId = randomUUID(), expiresAt = now() + CONVERSATION_AUDIO_LIMITS.sessionMs;
    const timer = setTimer(() => expire(sessionId, 'expired'), CONVERSATION_AUDIO_LIMITS.sessionMs); timer?.unref?.();
    sessions.set(sessionId, { conversationId, ownerKey, expiresAt, timer, audioMs: 0, requests: 0 }); starts.push(now());
    return { sessionId, conversationId, expiresAt, ...options() };
  }
  function end(input) {
    requireSession(input); const sessionId = conversationAudioId(input.sessionId); expire(sessionId, 'ended');
    return { sessionId, conversationId: input.conversationId, ended: true };
  }
  function cancel(input) {
    requireSession(input); const sessionId = conversationAudioId(input.sessionId), requestId = conversationAudioId(input.requestId), item = active.get(requestId);
    if (item && item.sessionId === sessionId) {
      item.controller.abort(); db.prepare("UPDATE conversation_audio_requests SET status='uncertain' WHERE request_id=? AND status='pending'").run(requestId);
    }
    return { requestId, cancelled: Boolean(item && item.sessionId === sessionId), usage: null, estimatedCostUsd: null };
  }
  async function transcribe(input) {
    input = { ...input, sessionId: conversationAudioId(input.sessionId) };
    const session = requireSession(input), requestId = conversationAudioId(input.requestId);
    const { audio, durationMs, sampleRate } = decodeConversationWav(input.audioBase64);
    const scope = digest(`${input.ownerKey}\0${input.sessionId}\0${input.conversationId}`), fingerprint = digest(`${scope}\0${digest(audio)}`);
    const allowed = () => {
      if (input.signal?.aborted || input.authorize?.() === false) fail(409, 'This transcription request was stopped.', 'conversation_audio_request_inactive');
      requireSession(input);
    };
    allowed();
    const prior = db.prepare('SELECT fingerprint,scope,status FROM conversation_audio_requests WHERE request_id=?').get(requestId);
    if (prior && (prior.fingerprint !== fingerprint || prior.scope !== scope)) fail(409, 'This transcription ID was already used for a different recording or session.', 'conversation_audio_request_conflict');
    if (prior?.status === 'complete') {
      const cached = cache.get(requestId);
      if (!cached) fail(409, 'This transcript is no longer in memory. It will not be automatically generated again.', 'conversation_audio_transcript_expired');
      return { ...cached.result, cached: true, metadata: { ...cached.result.metadata, paidRequest: false } };
    }
    if (prior) fail(409, 'The earlier transcription has an uncertain outcome. No automatic retry was made.', 'conversation_audio_request_uncertain');
    if (active.size) fail(409, 'Another voice turn is being transcribed.', 'conversation_audio_busy');
    // Durable paid-usage limits survive session restarts and process restarts.
    const hourly = db.prepare("SELECT COUNT(*) AS requests, COALESCE(SUM(json_extract(metadata, '$.durationMs')), 0) AS audioMs FROM conversation_audio_requests WHERE created_at > ?").get(now() - 3600000);
    if (hourly.requests >= CONVERSATION_AUDIO_LIMITS.maxHourlyRequests || hourly.audioMs + durationMs > CONVERSATION_AUDIO_LIMITS.maxHourlyAudioMs) fail(429, 'The hourly transcription usage limit has been reached. Try again when earlier usage expires.', 'conversation_audio_hourly_usage_limit');
    if (session.requests >= CONVERSATION_AUDIO_LIMITS.maxSessionRequests || session.audioMs + durationMs > CONVERSATION_AUDIO_LIMITS.sessionMs) fail(429, 'The voice-session usage limit has been reached.', 'conversation_audio_usage_limit');
    if (db.prepare('SELECT COUNT(*) AS count FROM conversation_audio_requests').get().count >= CONVERSATION_AUDIO_LIMITS.maxLedgerEntries) fail(429, 'The transcription request history is full.', 'conversation_audio_ledger_limit');
    const controller = new AbortController(), startedAt = now(), timer = setTimer(() => controller.abort(), CONVERSATION_AUDIO_LIMITS.timeoutMs);
    timer?.unref?.();
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    const form = new FormData();
    form.set('file', new Blob([audio], { type: 'audio/wav' }), 'utterance.wav');
    form.set('model', CONVERSATION_TRANSCRIPTION_MODEL); form.set('response_format', 'json'); form.set('language', 'en');
    session.requests++; session.audioMs += durationMs;
    let metadata = { provider: 'openai', endpoint: 'audio/transcriptions', model: CONVERSATION_TRANSCRIPTION_MODEL, durationMs, sampleRate, usage: null, estimatedCostUsd: null, paidRequest: true };
    db.prepare('INSERT INTO conversation_audio_requests VALUES(?,?,?,?,?,?)').run(requestId, fingerprint, scope, 'pending', startedAt, JSON.stringify(metadata));
    active.set(requestId, { controller, sessionId: input.sessionId });
    try {
      const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal, headers: { Authorization: `Bearer ${key}` }, body: form });
      if (!response.ok) { await response.body?.cancel?.().catch(() => {}); fail(response.status === 429 ? 429 : 502, 'OpenAI could not transcribe this turn. No automatic retry was made.', 'conversation_audio_provider_failed'); }
      const payload = await providerPayload(response);
      allowed();
      if (signal.aborted) fail(409, 'This transcription request was stopped.', 'conversation_audio_request_inactive');
      if (payload?.model !== undefined && payload.model !== CONVERSATION_TRANSCRIPTION_MODEL && !/^gpt-4o-mini-transcribe-\d{4}-\d{2}-\d{2}$/.test(payload.model)) fail(502, 'The transcription provider returned an unexpected model.', 'conversation_audio_provider_model');
      if (typeof payload?.text !== 'string' || payload.text.length > 12000 || /[\0\u0001-\u0008\u000b\u000c\u000e-\u001f]/u.test(payload.text)) fail(502, 'OpenAI returned an unusable transcript.', 'conversation_audio_provider_format');
      const providerId = response.headers.get('x-request-id');
      metadata = { ...metadata, returnedModel: payload.model ?? null, providerRequestId: typeof providerId === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(providerId) ? providerId : null, audioBytes: audio.length, latencyMs: Math.max(0, now() - startedAt), usage: safeUsage(payload.usage), pricingBasis: 'Actual provider usage when supplied; transcription cost is not estimated.', recordedAt: now(), ingeniumReported: false };
      const result = { sessionId: input.sessionId, conversationId: input.conversationId, requestId, text: payload.text.trim(), transcriptVerified: false, metadata, cached: false };
      db.prepare("UPDATE conversation_audio_requests SET status='complete',metadata=? WHERE request_id=?").run(JSON.stringify(metadata), requestId);
      while (cache.size >= 10) cache.delete(cache.keys().next().value);
      cache.set(requestId, { sessionId: input.sessionId, result, expiresAt: now() + CONVERSATION_AUDIO_LIMITS.cacheMs });
      return result;
    } catch (error) {
      if (!stopped) db.prepare("UPDATE conversation_audio_requests SET status='uncertain',metadata=? WHERE request_id=?").run(JSON.stringify({ ...metadata, latencyMs: Math.max(0, now() - startedAt), cancelled: signal.aborted, billingOutcome: 'unknown' }), requestId);
      if (error instanceof ConversationAudioError) throw error;
      fail(signal.aborted ? 409 : 502, signal.aborted ? 'This transcription request was stopped.' : 'Transcription could not be completed. No automatic retry was made.', signal.aborted ? 'conversation_audio_request_inactive' : 'conversation_audio_provider_failed');
    } finally { clearTimer(timer); active.delete(requestId); audio.fill(0); }
  }
  function invalidate() { for (const id of [...sessions.keys()]) expire(id, 'invalidated'); cache.clear(); }
  return { options, start, end, cancel, transcribe, requireSession, invalidate, get active() { return active.size; }, close() { if (stopped) return; invalidate(); stopped = true; } };
}
