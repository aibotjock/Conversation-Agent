/** Transport-independent foreground conversation coordinator.
 * Hosts own authentication, knowledge, authorization, storage and provider policy.
 * A browser flag is never evidence that an audio response is authorized.
 */
export function createConversationAgent({ input = null, host, playback = null, onState = () => {},
  windowImpl = globalThis.window, documentImpl = globalThis.document,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout, maxDurationMs = 600000, checkpointTimeoutMs = 2000,
  createId = () => globalThis.crypto?.randomUUID?.() ?? `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
} = {}) {
  if (typeof host?.sendTurn !== 'function') throw new TypeError('A conversation host must provide sendTurn.');
  let destroyed = false, sessionEpoch = 0, turnEpoch = 0, work = null, sessionController = null;
  let sessionReady = Promise.resolve(), playbackCheckpointReady = Promise.resolve(), durationTimer = null, waitTimer = null;
  const seenUtterances = new Set();
  let snapshot = { phase: 'idle', active: false, muted: false, audioBlocked: false,
    userCaption: '', assistantCaption: '', message: 'Start a conversation or type a message.', warning: '',
    setupPending: false, replyWaitMs: 0, inputState: 'off', outputState: 'idle',
    sessionEpoch: 0, turnEpoch: 0, conversationId: null, sessionId: null };
  const state = () => ({ ...snapshot });
  function phaseOf(value) {
    if (!value.active) return value.outputState === 'error' ? 'error' : 'idle';
    if (value.outputState === 'generating') return 'thinking';
    if (value.outputState === 'transcribing') return 'transcribing';
    if (value.outputState === 'preparing') return 'preparing-audio';
    if (value.outputState === 'playing') return 'speaking';
    if (value.outputState === 'blocked') return 'paused';
    if (value.inputState === 'starting') return 'starting';
    if (value.muted || value.inputState === 'unavailable' || value.inputState === 'off') return 'paused';
    return 'listening';
  }
  function update(change) {
    snapshot = { ...snapshot, ...change, sessionEpoch, turnEpoch };
    snapshot.phase = phaseOf(snapshot);
    onState(state());
  }
  const sessionCurrent = epoch => !destroyed && snapshot.active && epoch === sessionEpoch && !documentImpl?.hidden;
  const current = item => sessionCurrent(item.sessionEpoch) && work === item && item.turnEpoch === turnEpoch && !item.controller.signal.aborted;
  const outputActive = active => input?.setOutputActive?.(active);
  const quietCall = (method, value) => {
    try { Promise.resolve(method?.call(host, value)).catch(() => {}); } catch {}
  };
  function checkpoint(item, status) {
    if (!item?.reply?.messageId || item.checkpointTerminal) return;
    if (status !== 'progress') item.checkpointTerminal = true;
    const media = playback?.getOutputState?.() || playback?.state?.() || {};
    const currentChunk = Number.isInteger(media.currentChunk) ? media.currentChunk : Number.isInteger(media.chunkIndex) ? media.chunkIndex : item.currentChunk;
    const payload = {
      conversationId: snapshot.conversationId, sessionId: snapshot.sessionId,
      turnId: item.turnId, messageId: item.reply.messageId, status,
      completedChunks: item.completedChunks, currentChunk: Math.max(0, currentChunk || 0), complete: status === 'completed',
    };
    const report = host.reportPlayback || host.checkpoint;
    if (report) {
      const controller = new AbortController();
      let timer;
      const request = Promise.resolve().then(() => report.call(host, { ...payload, signal: controller.signal }));
      playbackCheckpointReady = Promise.race([request, new Promise((_, reject) => {
        timer = setTimer(() => { controller.abort(); reject(new Error('Playback progress was not saved.')); }, Math.max(100, Math.min(5000, Number(checkpointTimeoutMs) || 2000)));
      })]).finally(() => clearTimer(timer));
      // Attach an observer immediately; a later turn still awaits the original rejection.
      playbackCheckpointReady.catch(() => {});
    }
  }
  function cancelWork({ report = true, clearCache = false } = {}) {
    const previous = work; work = null; turnEpoch++;
    clearTimer(waitTimer); waitTimer = null;
    if (previous) {
      if (report) checkpoint(previous, 'interrupted');
      previous.controller.abort();
      quietCall(host.cancel || host.cancelTurn, {
        conversationId: snapshot.conversationId, sessionId: snapshot.sessionId,
        requestId: previous.requestId, turnId: previous.turnId,
      });
    }
    playback?.stop?.({ clearCache }); outputActive(false);
  }
  async function waitForCheckpoint() {
    try {
      await playbackCheckpointReady;
      return true;
    } catch { return false; }
  }
  function stop(message = 'Conversation stopped. Your microphone is off.', failed = false) {
    const ended = { conversationId: snapshot.conversationId, sessionId: snapshot.sessionId };
    sessionEpoch++; sessionController?.abort(); sessionController = null;
    clearTimer(durationTimer); durationTimer = null;
    cancelWork({ clearCache: true }); input?.stop?.(); seenUtterances.clear();
    update({ active: false, muted: false, inputState: 'off', outputState: failed ? 'error' : 'idle',
      audioBlocked: false, setupPending: false, replyWaitMs: 0, message, sessionId: null });
    if (ended.sessionId) quietCall(host.endSession, ended);
    return Promise.resolve();
  }
  function interrupt() {
    if (!snapshot.active || destroyed) return;
    cancelWork();
    update({ outputState: 'idle', audioBlocked: false, replyWaitMs: 0,
      message: snapshot.muted ? 'Microphone muted. Type your next message.' : 'Listening for your next message.', warning: '' });
  }
  function beginWork() {
    cancelWork();
    const item = { sessionEpoch, turnEpoch, controller: new AbortController(), turnId: createId(),
      requestId: null, reply: null, completedChunks: 0, currentChunk: 0, checkpointTerminal: false, terminal: false };
    item.requestId = item.turnId; work = item;
    return item;
  }
  function terminal(item, error) {
    if (!current(item) || item.terminal) return;
    item.terminal = true;
    checkpoint(item, error ? 'interrupted' : 'completed');
    work = null; clearTimer(waitTimer); waitTimer = null; outputActive(false);
    update({ outputState: 'idle', audioBlocked: false, setupPending: false,
      message: error ? 'Audio stopped. Your reply remains visible; use typing or try audio manually.' : snapshot.muted ? 'Microphone muted. Type or unmute to continue.' : 'Listening for your next message.',
      warning: error ? String(error?.message || 'Audio could not be played.').slice(0, 300) : snapshot.warning });
  }
  async function turn(text, item) {
    if (!current(item)) return;
    const cleaned = typeof text === 'string' ? text.trim() : '';
    if (!cleaned || cleaned.length > 12000) throw new Error('Enter a message from 1 to 12000 characters.');
    await sessionReady;
    const checkpointSaved = await waitForCheckpoint();
    if (!current(item)) return;
    const startedAt = now();
    update({ userCaption: cleaned, outputState: 'generating', message: 'Preparing your reply.', warning: checkpointSaved ? '' : 'Playback progress was not saved. Your earlier reply remains visible.', replyWaitMs: 0 });
    function tick() {
      if (!current(item) || snapshot.outputState !== 'generating') return;
      update({ replyWaitMs: Math.max(0, now() - startedAt) }); waitTimer = setTimer(tick, 1000);
    }
    waitTimer = setTimer(tick, 1000);
    item.requestId = item.turnId;
    const reply = await host.sendTurn({ conversationId: snapshot.conversationId, sessionId: snapshot.sessionId,
      text: cleaned, content: cleaned, requestId: item.turnId, turnId: item.turnId, signal: item.controller.signal });
    if (!current(item)) return;
    clearTimer(waitTimer); waitTimer = null;
    if (!reply || typeof reply.content !== 'string' || !reply.content.trim() || reply.content.length > 24000) throw new Error('The host did not return a valid conversation reply.');
    item.reply = reply;
    if (reply.conversationId) update({ conversationId: reply.conversationId });
    const caption = typeof reply.spokenText === 'string' ? reply.spokenText : reply.content;
    update({ assistantCaption: caption.slice(0, 24000), replyWaitMs: Math.max(0, now() - startedAt) });
    if (!playback || reply.readoutAllowed === false) {
      work = null;
      update({ outputState: 'idle', message: 'Your reply is available as text.', warning: reply.readoutAllowed === false ? 'This reply is available as text only.' : '' });
      return reply;
    }
    if (typeof reply.messageId !== 'string' || !reply.messageId) throw new Error('Audio requires a saved host message identity.');
    update({ outputState: 'preparing', message: 'Preparing audio.', audioBlocked: false });
    await playback.play({ conversationId: snapshot.conversationId, messageId: reply.messageId,
      content: caption, signal: item.controller.signal,
      onPreparing(detail = {}) {
        if (!current(item) || item.terminal) return;
        const index = Number.isInteger(detail.chunkIndex) ? detail.chunkIndex : 0;
        item.currentChunk = index;
        // Next-part preparation is emitted only after the previous part ended.
        item.completedChunks = Math.max(item.completedChunks, index);
        outputActive(false); update({ outputState: 'preparing', message: index ? 'Preparing the next audio part.' : 'Preparing audio.' });
      },
      onStart() { if (current(item) && !item.terminal) { outputActive(true); update({ outputState: 'playing', audioBlocked: false, message: 'Speaking. You can interrupt with your voice or the Interrupt button.' }); } },
      onWaiting() { if (current(item) && !item.terminal) update({ outputState: 'preparing', message: 'Audio is buffering.' }); },
      onProgress(detail = {}) {
        if (!current(item) || item.terminal) return;
        if (Number.isInteger(detail.completedChunks) && detail.completedChunks >= 0 && detail.completedChunks <= 100) item.completedChunks = Math.max(item.completedChunks, detail.completedChunks);
        if (Number.isInteger(detail.currentChunk)) item.currentChunk = detail.currentChunk;
      },
      onChunkEnd(detail = {}) {
        if (!current(item) || item.terminal) return;
        if (Number.isInteger(detail.completedChunks) && detail.completedChunks >= 0 && detail.completedChunks <= 100) item.completedChunks = Math.max(item.completedChunks, detail.completedChunks);
        outputActive(false);
      },
      onBlocked(message) { if (current(item) && !item.terminal) { outputActive(false); update({ outputState: 'blocked', audioBlocked: true, message: message || 'Tap Play audio to continue the prepared recording.' }); } },
      onEnd() { terminal(item); }, onError(error) { terminal(item, error); },
    });
    return reply;
  }
  async function handleUtterance(value, epoch) {
    if (!sessionCurrent(epoch) || snapshot.muted) return;
    const id = value?.utteranceId;
    if (typeof id !== 'string' || !id || seenUtterances.has(id)) return;
    seenUtterances.add(id); if (seenUtterances.size > 100) seenUtterances.delete(seenUtterances.values().next().value);
    const item = beginWork(); item.requestId = id;
    update({ outputState: 'transcribing', inputState: 'monitoring', userCaption: '', message: 'Transcribing your message.' });
    try {
      await sessionReady;
      if (!current(item)) return;
      if (typeof host.transcribe !== 'function') throw new Error('This host has no audio transcription adapter. Type your message instead.');
      const result = await host.transcribe({ ...value, requestId: id, conversationId: snapshot.conversationId,
        sessionId: snapshot.sessionId, signal: item.controller.signal });
      if (!current(item)) return;
      await turn(typeof result === 'string' ? result : result?.text, item);
    } catch (error) {
      if (!current(item)) return;
      cancelWork(); update({ outputState: 'idle', message: 'The message was not completed. Type or speak again when ready.', warning: String(error?.message || 'The request failed.').slice(0, 300) });
    }
  }
  async function start({ conversationId = snapshot.conversationId } = {}) {
    if (destroyed) throw new Error('The conversation agent is closed.');
    if (snapshot.active) return state();
    if (documentImpl?.hidden) throw new Error('Keep the app visible to use its microphone.');
    sessionEpoch++; const epoch = sessionEpoch; const controller = new AbortController(); sessionController = controller; playbackCheckpointReady = Promise.resolve();
    update({ active: true, muted: false, conversationId, sessionId: null, inputState: input ? 'starting' : 'unavailable', outputState: 'idle',
      setupPending: Boolean(input), audioBlocked: false, userCaption: '', assistantCaption: '', warning: '', message: 'Starting your conversation.' });
    // Invoke input synchronously from the user gesture so AudioContext can resume.
    let inputReady;
    try {
      inputReady = input?.start?.({
        onSpeechStart() {
          if (!sessionCurrent(epoch) || snapshot.muted) return;
          if (work) interrupt();
          update({ inputState: 'capturing', userCaption: '', message: 'Listening…' });
        },
        onUtterance: value => { void handleUtterance(value, epoch); },
        onWarning: warning => { if (sessionCurrent(epoch)) update({ warning: String(warning).slice(0, 300) }); },
        onState: value => { if (sessionCurrent(epoch)) update({ inputState: value?.phase || 'monitoring', setupPending: value?.phase === 'starting' }); },
      });
    } catch (error) { inputReady = Promise.reject(error); }
    sessionReady = Promise.resolve().then(() => host.startSession?.({ conversationId, signal: controller.signal })).then(result => {
      if (!sessionCurrent(epoch)) { if (result?.sessionId) quietCall(host.endSession, { conversationId: result.conversationId || conversationId, sessionId: result.sessionId }); return; }
      update({ sessionId: result?.sessionId || null, conversationId: result?.conversationId || snapshot.conversationId });
    });
    // Attach both rejection handlers immediately, including delayed permission UI.
    const inputResult = Promise.resolve(inputReady).then(() => {
      if (sessionCurrent(epoch)) update({ inputState: input ? 'monitoring' : 'unavailable', setupPending: false,
        message: input ? 'Listening. Speak naturally or type a message.' : 'Microphone unavailable. Type a message to continue.',
        warning: input ? snapshot.warning : 'This host provides typed conversation only.' });
    }, error => {
      if (sessionCurrent(epoch)) { input?.stop?.(); update({ inputState: 'unavailable', setupPending: false, message: 'Microphone unavailable. Type a message to continue.', warning: String(error?.message || 'Microphone permission is required.').slice(0, 300) }); }
    });
    durationTimer = setTimer(() => { if (sessionCurrent(epoch)) void stop('Your foreground conversation session ended. Start again when ready.'); }, Math.max(1000, Math.min(600000, Number(maxDurationMs) || 600000)));
    try { await sessionReady; await inputResult; }
    catch (error) { if (sessionCurrent(epoch)) await stop(String(error?.message || 'The host could not start the conversation.').slice(0, 300), true); }
    return state();
  }
  async function sendText(text) {
    if (destroyed) throw new Error('The conversation agent is closed.');
    if (!snapshot.active) {
      sessionEpoch++; sessionController = new AbortController();
      update({ active: true, muted: true, inputState: 'off', outputState: 'idle' });
      const epoch = sessionEpoch;
      sessionReady = Promise.resolve(host.startSession?.({ conversationId: snapshot.conversationId, signal: sessionController.signal })).then(result => {
        if (sessionCurrent(epoch)) update({ sessionId: result?.sessionId || null, conversationId: result?.conversationId || snapshot.conversationId });
        else if (result?.sessionId) quietCall(host.endSession, { conversationId: result.conversationId || snapshot.conversationId, sessionId: result.sessionId });
      });
      durationTimer = setTimer(() => { if (sessionCurrent(epoch)) void stop('Your foreground conversation session ended. Start again when ready.'); }, Math.max(1000, Math.min(600000, Number(maxDurationMs) || 600000)));
    }
    const item = beginWork();
    try { return await turn(text, item); }
    catch (error) {
      if (current(item)) { cancelWork(); update({ outputState: 'idle', warning: String(error?.message || 'The request failed.').slice(0, 300), message: 'Your message was not completed. No automatic retry was made.' }); }
      return null;
    }
  }
  function toggleMute() {
    if (!snapshot.active || destroyed) return;
    const muted = !snapshot.muted; input?.setMuted?.(muted);
    update({ muted, inputState: muted ? 'off' : input ? 'starting' : 'unavailable', message: muted ? 'Microphone muted. Typing and audio remain available.' : 'Starting your microphone.' });
  }
  async function playAudio() {
    if (!snapshot.active || !snapshot.audioBlocked || !work || destroyed) return;
    const item = work;
    update({ audioBlocked: false, outputState: 'preparing', message: 'Resuming the prepared recording.' });
    try { await playback?.resume?.(); } catch (error) { terminal(item, error); }
  }
  const onHidden = () => { if (documentImpl?.hidden && snapshot.active) void stop('Conversation stopped in the background. Your microphone is off.'); };
  const onLeave = () => { if (snapshot.active) void stop('Conversation stopped because you left the page.'); };
  const onOffline = () => { if (snapshot.active) void stop('Connection lost. Your microphone is off. Reconnect and start again when ready.'); };
  documentImpl?.addEventListener?.('visibilitychange', onHidden); windowImpl?.addEventListener?.('pagehide', onLeave); windowImpl?.addEventListener?.('offline', onOffline);
  return { start, stop, interrupt, toggleMute, sendText, playAudio, clearCaptions: () => update({ userCaption: '', assistantCaption: '', warning: '' }),
    active: () => snapshot.active, state,
    destroy() { if (destroyed) return; void stop(); destroyed = true; input?.destroy?.(); playback?.destroy?.(); documentImpl?.removeEventListener?.('visibilitychange', onHidden); windowImpl?.removeEventListener?.('pagehide', onLeave); windowImpl?.removeEventListener?.('offline', onOffline); },
  };
}
