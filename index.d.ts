export interface ConversationState {
  phase: string; active: boolean; muted: boolean; audioBlocked: boolean;
  /** Playback recovery reason; null when unknown or audio is not blocked. */
  audioBlockReason: 'permission' | 'stalled' | 'paused' | null;
  userCaption: string; assistantCaption: string; message: string; warning: string;
  setupPending: boolean; replyWaitMs: number; inputState: string; outputState: string;
  sessionEpoch: number; turnEpoch: number; conversationId: string | null; sessionId: string | null;
}
export interface AudioUtterance { audio: Blob; mimeType: string; durationMs: number; utteranceId: string }
export interface InputCallbacks {
  onSpeechStart?(): void; onUtterance?(utterance: AudioUtterance): void;
  onWarning?(warning: string): void; onState?(state: { phase: string }): void;
}
export interface ConversationInput {
  start(callbacks: InputCallbacks): Promise<void> | void;
  stop(): void; setMuted?(muted: boolean): void; setOutputActive?(active: boolean): void;
  setOutputReference?(pcm: Float32Array | null): void; destroy?(): void;
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
