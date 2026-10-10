const PHASE_LABELS = {
  idle: 'Ready to begin', stopped: 'Conversation stopped',
  listening: 'Listening', transcribing: 'Transcribing your words',
  thinking: 'Preparing a reply', reviewing: 'Checking the reply',
  'preparing-audio': 'Preparing audio', speaking: 'Playing reply',
  paused: 'Conversation paused', blocked: 'Tap Play reply to start audio',
  error: 'Conversation needs attention',
};

// Avoid replacing caption nodes and repeating accessibility writes on timer ticks.
function setText(element, value) { if (element.textContent !== value) element.textContent = value; }
function setAttribute(element, name, value) { if (element.getAttribute(name) !== value) element.setAttribute(name, value); }

function readable(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.replace(/[-_]/g, ' ');
}

/** Mounts presentation and user actions only. The host owns conversation state. */
export function mountVoiceCircle({ container, agent, documentImpl = globalThis.document, reducedMotion, getStartOptions = () => ({}), showComposer = true, showNotice = true } = {}) {
  if (!container || typeof container.appendChild !== 'function') throw new TypeError('A DOM container is required.');
  if (!documentImpl || typeof documentImpl.createElement !== 'function') throw new TypeError('A document is required.');
  if (!agent || typeof agent.start !== 'function' || typeof agent.stop !== 'function') throw new TypeError('An agent with start and stop actions is required.');

  let destroyed = false;
  let current = {};
  let pendingText = false;
  let submittedText = '';
  let submissionVersion = 0;
  const listeners = [];
  const make = (tag, className, text) => {
    const element = documentImpl.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const listen = (element, type, handler) => {
    element.addEventListener(type, handler);
    listeners.push(() => element.removeEventListener(type, handler));
  };
  const wrapper = make('section', 'conversation-voice-circle');
  setAttribute(wrapper, 'aria-label', 'Voice conversation');
  const motionPreference = reducedMotion ?? documentImpl.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  setAttribute(wrapper, 'data-reduced-motion', String(Boolean(motionPreference)));
  const center = make('div', 'voice-center');
  const orb = make('button', 'voice-orb');
  orb.type = 'button';
  const orbTitle = make('strong', '', 'Start conversation');
  const orbHint = make('span', '', 'Voice or text');
  orb.appendChild(orbTitle);
  orb.appendChild(orbHint);
  const status = make('p', 'voice-status', 'Ready to begin');
  setAttribute(status, 'role', 'status');
  setAttribute(status, 'aria-live', 'polite');
  const channels = make('p', 'voice-channels');
  center.appendChild(orb);
  center.appendChild(status);
  center.appendChild(channels);
  wrapper.appendChild(center);
  const controls = make('div', 'voice-controls');
  wrapper.appendChild(controls);
  const notice = make('p', 'voice-notice');
  setAttribute(notice, 'role', 'status');
  setAttribute(notice, 'aria-live', 'polite');
  wrapper.appendChild(notice);
  const warning = make('p', 'voice-notice');
  setAttribute(warning, 'role', 'alert');
  wrapper.appendChild(warning);
  const captions = make('div', 'voice-captions');
  const caption = (label, initial) => {
    const box = make('div', 'voice-caption');
    box.appendChild(make('h3', '', label));
    const content = make('p', '', initial);
    box.appendChild(content);
    captions.appendChild(box);
    return content;
  };
  const userCaption = caption('You', 'Your words will appear here.');
  const assistantCaption = caption('Assistant', 'The reply will appear here.');
  wrapper.appendChild(captions);

  const active = () => typeof current.active === 'boolean' ? current.active : Boolean(agent.active?.());
  const failed = () => {
    if (!destroyed) {
      warning.hidden = false;
      setText(warning, 'That action could not finish. Try again or use the text controls.');
    }
  };
  const invoke = (action) => {
    if (destroyed) return;
    try { Promise.resolve(action()).catch(failed); } catch { failed(); }
  };
  listen(orb, 'click', () => invoke(() => active() ? agent.stop() : agent.start(getStartOptions())));

  const optionalButton = (method, title) => {
    if (typeof agent[method] !== 'function') return null;
    const button = make('button', '', title);
    button.type = 'button';
    listen(button, 'click', () => invoke(() => agent[method]()));
    controls.appendChild(button);
    return button;
  };
  const interrupt = optionalButton('interrupt', 'Interrupt reply');
  const mute = optionalButton('toggleMute', 'Mute microphone');
  const replay = optionalButton('playAudio', 'Play prepared audio');
  let textarea;
  let send;
  if (showComposer && typeof agent.sendText === 'function') {
    const form = make('form', 'voice-text-form');
    const label = make('label', '', 'Type a message');
    textarea = make('textarea');
    textarea.rows = 2;
    setAttribute(textarea, 'aria-label', 'Type a message');
    label.appendChild(textarea);
    form.appendChild(label);
    send = make('button', '', 'Send message');
    send.type = 'submit';
    form.appendChild(send);
    listen(form, 'submit', (event) => {
      event.preventDefault();
      const text = textarea.value.trim();
      if (!text || pendingText || destroyed) return;
      pendingText = true;
      submittedText = text;
      const version = ++submissionVersion;
      send.disabled = true;
      let result;
      try { result = agent.sendText(text); } catch {
        pendingText = false;
        send.disabled = false;
        failed();
        return;
      }
      Promise.resolve(result).then(value => {
        if (!destroyed && version === submissionVersion && value !== null && textarea.value.trim() === text) textarea.value = '';
      }, () => { if (version === submissionVersion) failed(); }).finally(() => {
        if (version !== submissionVersion) return;
        pendingText = false;
        if (!destroyed) send.disabled = false;
      });
    });
    wrapper.appendChild(form);
  }
  container.appendChild(wrapper);

  const update = (state = {}) => {
    if (destroyed) return;
    current = state && typeof state === 'object' ? state : {};
    const isActive = active();
    const phase = typeof current.phase === 'string' ? current.phase : 'idle';
    const blockedLabel = current.audioBlockReason === 'permission' ? 'Audio needs permission'
      : current.audioBlockReason === 'stalled' ? 'Audio stalled' : 'Audio paused';
    const phaseLabel = phase === 'paused'
      ? current.audioBlocked ? blockedLabel : current.muted ? 'Microphone muted' : current.inputState === 'unavailable' ? 'Microphone unavailable' : 'Conversation paused'
      : PHASE_LABELS[phase] || readable(phase, 'Ready to begin');
    setText(orbTitle, isActive ? 'Stop conversation' : 'Start conversation');
    setText(orbHint, phaseLabel);
    setAttribute(orb, 'aria-label', orbTitle.textContent);
    setAttribute(orb, 'aria-pressed', String(isActive));
    setText(status, current.setupPending ? 'Setting up microphone' : phaseLabel);
    const microphoneLabel = !isActive || current.inputState === 'off'
      ? current.muted ? 'Microphone muted' : 'Microphone off'
      : current.muted ? 'Microphone muted'
      : ({ starting: 'Microphone starting', capturing: 'Listening to your message', monitoring: 'Microphone on', listening: 'Microphone on', unavailable: 'Microphone unavailable', muted: 'Microphone muted' })[current.inputState] || 'Microphone status unavailable';
    const outputLabel = ({ idle: 'Ready', generating: 'Preparing reply', transcribing: 'Transcribing', preparing: 'Preparing audio', playing: 'Reply playing', blocked: blockedLabel, error: 'Reply needs attention', checking: 'Checking reply' })[current.outputState] || 'Reply status unavailable';
    setText(channels, `${microphoneLabel} · ${outputLabel}`);
    setText(userCaption, typeof current.userCaption === 'string' && current.userCaption ? current.userCaption : 'Your words will appear here.');
    setText(assistantCaption, typeof current.assistantCaption === 'string' && current.assistantCaption ? current.assistantCaption : 'The reply will appear here.');
    setText(notice, typeof current.message === 'string' ? current.message : '');
    notice.hidden = !showNotice || !notice.textContent;
    setText(warning, typeof current.warning === 'string' ? current.warning : '');
    warning.hidden = !warning.textContent;
    if (interrupt) interrupt.disabled = !isActive;
    if (mute) {
      setText(mute, current.muted ? 'Unmute microphone' : 'Mute microphone');
      setAttribute(mute, 'aria-pressed', String(Boolean(current.muted)));
      mute.disabled = !isActive;
    }
    if (replay) {
      replay.hidden = !current.audioBlocked;
      replay.disabled = !isActive;
    }
    if (send) {
      if (pendingText && !current.warning && current.userCaption === submittedText && ['generating', 'preparing', 'playing', 'blocked'].includes(current.outputState)) {
        pendingText = false;
        if (textarea.value.trim() === submittedText) textarea.value = '';
      }
      send.disabled = pendingText;
    }
    setAttribute(wrapper, 'data-phase', phase);
    setAttribute(wrapper, 'data-input-state', typeof current.inputState === 'string' ? current.inputState : 'off');
    setAttribute(wrapper, 'data-output-state', typeof current.outputState === 'string' ? current.outputState : 'idle');
  };
  update(typeof agent.state === 'function' ? agent.state() : {});

  return {
    element: wrapper,
    button: orb,
    update,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const remove of listeners) remove();
      wrapper.remove();
    },
  };
}

