export interface ConversationState {
  phase: string; active: boolean; muted: boolean; audioBlocked: boolean;
  /** Playback recovery reason; null when unknown or audio is not blocked. */
  audioBlockReason: 'permission' | 'stalled' | 'paused' | null;
  userCaption: string; assistantCaption: string; message: string; warning: string;
  setupPending: boolean; replyWaitMs: number; inputState: string; outputState: string;
  sessionEpoch: number; turnEpoch: number; conversationId: string | null; sessionId: string | null;
}
export interface AudioUtterance { audio: Blob; mimeType: string; durationMs: number; utteranceId: string }
/** Final words recognized on the device; the controller sends them without calling host.transcribe. */
export interface TextUtterance { text: string; mimeType: 'text/plain'; audio: null; durationMs: number; utteranceId: string }
export interface InputCallbacks {
  onSpeechStart?(): void; onUtterance?(utterance: AudioUtterance | TextUtterance): void;
  /** Live caption while the person is still speaking (on-device input only). */
  onPartial?(text: string): void;
  onWarning?(warning: string): void; onState?(state: { phase: string }): void;
}
export interface ConversationInput {
  start(callbacks: InputCallbacks): Promise<void> | void;
  stop(): void; setMuted?(muted: boolean): void; setOutputActive?(active: boolean): void;
  setOutputReference?(pcm: Float32Array | null): void;
  /** Text of the reply being spoken, so the input can ignore the device's own voice. */
  setOutputText?(text: string | null): void; destroy?(): void;
}
export interface TurnRequest {
  conversationId: string | null; sessionId: string | null; text: string; content: string;
  turnId: string; requestId: string; signal: AbortSignal;
}
export interface ConversationReply {
  conversationId?: string; messageId?: string; content: string; spokenText?: string;
  /** Presentation hint only. The server must independently authorize audio. */
  readoutAllowed?: boolean;
}
export interface PlaybackCheckpoint {
  conversationId: string | null; sessionId: string | null; turnId: string; messageId: string;
  status: 'progress' | 'interrupted' | 'completed'; completedChunks: number;
  currentChunk: number; complete: boolean; signal: AbortSignal;
}
export interface ConversationHost {
  startSession?(request: { conversationId: string | null; signal: AbortSignal }): Promise<{ conversationId?: string; sessionId?: string }>;
  endSession?(request: { conversationId: string | null; sessionId: string }): Promise<unknown> | void;
  /** Needed only for audio utterances (createBrowserAudioInput); on-device text skips it. */
  transcribe?(request: AudioUtterance & { requestId: string; conversationId: string | null; sessionId: string | null; signal: AbortSignal }): Promise<{ text: string } | string>;
  sendTurn(request: TurnRequest): Promise<ConversationReply>;
  cancel?(request: { conversationId: string | null; sessionId: string | null; requestId: string; turnId: string }): Promise<unknown> | void;
  /** Host must treat unacknowledged voice replies as unplayed. */
  reportPlayback?(checkpoint: PlaybackCheckpoint): Promise<unknown> | void;
}
export interface PlaybackProgress {
  completedChunks?: number; currentChunk?: number; chunkIndex?: number; chunkCount?: number;
  currentTime?: number; duration?: number; playing?: boolean;
}
export interface ConversationPlayback {
  play(request: { conversationId: string | null; messageId: string; content: string; signal: AbortSignal;
    onPreparing?(detail: { chunkIndex?: number; chunkCount?: number }): void; onStart?(): void;
    onWaiting?(): void; onProgress?(detail: PlaybackProgress): void; onChunkEnd?(detail: PlaybackProgress): void;
    onBlocked?(message: string, detail?: { reason?: 'permission' | 'stalled' | 'paused' }): void; onEnd?(): void; onError?(error: Error): void;
  }): Promise<unknown> | void;
  stop(options?: { clearCache?: boolean }): void; resume?(): Promise<unknown> | void;
  state?(): PlaybackProgress; getOutputState?(): PlaybackProgress; destroy?(): void;
}
export interface ConversationAgent {
  start(options?: { conversationId?: string | null }): Promise<ConversationState>;
  stop(message?: string, failed?: boolean): Promise<void>; interrupt(): void;
  toggleMute(): void; sendText(text: string): Promise<ConversationReply | null | undefined>;
  playAudio(): Promise<void>; clearCaptions(): void; active(): boolean; state(): ConversationState; destroy(): void;
}
export function createConversationAgent(options: {
  input?: ConversationInput | null; host: ConversationHost; playback?: ConversationPlayback | null;
  onState?(state: ConversationState): void; windowImpl?: Window; documentImpl?: Document;
  now?(): number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout;
  maxDurationMs?: number; checkpointTimeoutMs?: number; createId?(): string;
}): ConversationAgent;
export function createBrowserAudioInput(options?: {
  windowImpl?: Window; documentImpl?: Document; navigatorImpl?: Navigator; AudioContextImpl?: typeof AudioContext;
  sampleRate?: 16000 | 24000 | 48000; preRollMs?: number; silenceMs?: number; maxDurationMs?: number; createId?(): string;
}): ConversationInput & { state(): { active: boolean; muted: boolean; sampleRate: number | null } };
export function resampleMono(samples: Float32Array, inputRate: number, outputRate?: number): Float32Array;
export function encodePcmWav(samples: Float32Array, sampleRate?: 16000 | 24000 | 48000): Blob;
export function createLocalVad(options?: {
  sampleRate?: number; preRollMs?: number; silenceMs?: number; minSpeechMs?: number; attackMs?: number;
  maxDurationMs?: number; threshold?: number; outputThresholdMultiplier?: number;
  onSpeechStart?(): void; onUtterance?(value: { samples: Float32Array; sampleRate: number; durationMs: number; reason: string }): void;
  onState?(value: { phase: string }): void; onWarning?(warning: string): void;
}): { process(samples: Float32Array): void; reset(): void; setOutputActive(active: boolean): void; setOutputReference(pcm: Float32Array | null): void; state(): { active: boolean; bufferedSamples: number; sampleRate: number; outputActive: boolean; locked: boolean } };
export function mountVoiceCircle(options: {
  container: HTMLElement; agent: ConversationAgent; documentImpl?: Document;
  getStartOptions?(): { conversationId?: string | null }; showComposer?: boolean; showNotice?: boolean;
}): { element: HTMLElement; button: HTMLButtonElement; update(state: ConversationState): void; destroy(): void };

export type SherpaSensitivity = 'low' | 'normal' | 'high';
export const SHERPA_SENSITIVITIES: readonly SherpaSensitivity[];
export interface SherpaAssets {
  version: string | null;
  runtime: { glue: string; vad: string; asr: string; wasmBase: string };
  models: Record<'vad' | 'encoder' | 'decoder' | 'joiner' | 'tokens', { url: string; integrity?: string }>;
}
export interface SherpaLoadState { phase: 'idle' | 'loading' | 'ready' | 'error'; loadedBytes: number; totalBytes: number }
/** On-device listening: Silero voice detection + streaming speech recognition in a Web Worker. */
export function createSherpaAudioInput(options: {
  /** URL of the folder written by scripts/fetch-sherpa-assets.mjs. */
  assetBaseUrl?: string | URL; manifest?: SherpaAssets;
  windowImpl?: Window; navigatorImpl?: Navigator; documentImpl?: Document; AudioContextImpl?: typeof AudioContext;
  WorkerImpl?: typeof Worker; workerUrl?: string | URL; captureModuleUrl?: string | URL; fetchImpl?: typeof fetch;
  /** Cache Storage name for downloaded models; change it to force a fresh download. */
  cacheName?: string; sensitivity?: SherpaSensitivity;
  /** Silence that ends a turn, 300–2000 ms (default 700). */
  pauseMs?: number; maxDurationMs?: number; onLoadProgress?(state: SherpaLoadState): void;
}): ConversationInput & {
  /** Starts the model download early, for example when the page opens. */
  preload(): Promise<void>;
  setSensitivity(value: SherpaSensitivity): void; setPauseMs(value: number): void;
  state(): { active: boolean; muted: boolean; sampleRate: number; sensitivity: SherpaSensitivity; pauseMs: number; model: SherpaLoadState };
};
export function createStreamResampler(inputRate: number, outputRate?: number): (frame: Float32Array) => Float32Array;
export function loadSherpaManifest(assetBaseUrl: string | URL, fetchImpl?: typeof fetch): Promise<SherpaAssets>;

export interface PhoneVoiceOption { id: string; label: string; name: string; lang: string; offline: boolean }
/** Spoken replies using the device's own voices, sentence by sentence. */
export function createPhoneVoicePlayback(options?: {
  speechSynthesisImpl?: SpeechSynthesis; UtteranceImpl?: typeof SpeechSynthesisUtterance;
  voiceId?: string | null; rate?: number; pitch?: number; lang?: string; startTimeoutMs?: number;
  setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout;
}): ConversationPlayback & {
  setVoice(id: string | null): void; setRate(value: number): void; setPitch(value: number): void;
  settings(): { voiceId: string | null; rate: number; pitch: number };
  preview(id?: string | null, text?: string): boolean;
};
export function listPhoneVoices(options?: { speechSynthesisImpl?: SpeechSynthesis; lang?: string; timeoutMs?: number }): Promise<SpeechSynthesisVoice[]>;
export function pickVoiceOptions(voices: SpeechSynthesisVoice[], count?: number): PhoneVoiceOption[];
export function labelVoice(voice: { name?: string; lang?: string }): string;
export function splitForSpeech(text: string, options?: { maxLength?: number; firstMaxLength?: number }): string[];
/** Reply-voice picker (five voices with previews) and microphone sensitivity control. */
export function mountVoiceSettings(options: {
  container: HTMLElement; playback: ReturnType<typeof createPhoneVoicePlayback>;
  input?: { setSensitivity(value: SherpaSensitivity): void } | null; documentImpl?: Document;
  count?: number; selectedVoiceId?: string | null; sensitivity?: SherpaSensitivity;
  onChange?(value: { voiceId: string | null; sensitivity: SherpaSensitivity }): void;
  listVoices?(): Promise<SpeechSynthesisVoice[]>;
}): { element: HTMLElement; ready: Promise<void>; options(): PhoneVoiceOption[]; value(): { voiceId: string | null; sensitivity: SherpaSensitivity }; select(id: string): void; destroy(): void };
