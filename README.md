# Conversation-Agent

Reusable foreground voice conversation for browser applications, with **aibotjock/Conversation-Agent** as its dedicated public GitHub repository. StudyChat is the first integration, on its dedicated **feature/conversation-agent** branch. This project uses an original teal/gold circle and public APIs; it does not copy ChatGPT assets, branding or private services. Store publication remains on hold. No npm registry publication has occurred; the package remains marked private.

## Boundaries

The package manages capture, bounded microphone pre-roll, local turn detection, interruption, cancellation, captions and conversation state. The host manages authentication, transcription services, knowledge, response approval, persistent records and accounting. No medical knowledge or permanent credentials belong in the browser core.

The implemented browser input uses `getUserMedia` and Web Audio, memory-only pre-roll (500 ms by default), local energy-based VAD and a hesitant silence endpoint. A completed utterance becomes mono PCM16 WAV for the host's OpenAI transcription adapter; each capture is capped at 60 seconds. Local monitoring can remain active during generation and playback. Cloud transcription begins after the utterance ends; partial cloud captions are not implemented.

Speech starts only after StudyChat's independent whole-reply grounding review and server message authorization. Its player can consume approved MP3 progressively through MediaSource where supported, or use buffered playback. Browser echo cancellation and tighter output-time detection thresholds are best effort. The optional injected PCM correlation reference is implemented in the input API but **not connected to StudyChat's actual player**. Echo and credible brief backchannels may interrupt a reply. Physical Android speaker, headset and Bluetooth behavior remains unverified.

## Public interface

`createConversationAgent` accepts `input`, `host`, `playback`, `onState` and optional clock/timer controls. The controller exposes start, stop, interrupt, toggleMute, sendText, playAudio, clearCaptions, active, state and destroy. State includes independent input/output fields and a turn revision; an output operation may run while microphone input is active.

`createBrowserAudioInput` exposes start, stop, setMuted, setOutputActive, optional setOutputReference, state and destroy. Mute stops microphone tracks; unmute reacquires them. Permission, disconnection and reacquisition failures retain typed/manual recovery. The self-hosted AudioWorklet path uses a ScriptProcessor fallback where necessary.

`mountVoiceCircle` provides the original framework-independent DOM component. Hosts bind its actions to the controller and supply captions and essential controls. The external `voice-circle.css` stylesheet supports hosts that disallow inline styles. This first release uses a small DOM mount rather than introducing a framework or custom-element registration requirement.

### Host adapter

- `startSession` / `endSession` authorize and terminate the host audio session when supplied.
- `transcribe` receives audio, MIME type, duration, utterance identity, conversation identity and an abort signal, and returns final text.
- `sendTurn` receives text, conversation/session identity, turn/request identity and an abort signal. It returns content, a saved message identity and optional spokenText/readoutAllowed presentation fields. The server independently authorizes speech; browser flags cannot approve it.
- `cancel` reports the active transcription/chat request identity on interruption; HTTP requests are also aborted. Cancellation does not imply zero provider charges.
- `reportPlayback` receives message identity, completed chunks, interruption/completion status and a bounded abort signal. Only completed audio chunks are reported; timestamps do not establish exact words heard. A failed or timed-out acknowledgment does not freeze later turns. The host must treat unacknowledged voice replies as unplayed.

The playback adapter implements play, stop and resume. It must stop immediately on cancellation and reject stale callbacks. Paid audio requests use authorized server message IDs, not arbitrary browser text or client approval flags.

The optional `./server` export provides the reusable OpenAI transcription service for Node 24 hosts with an injected SQLite-compatible request ledger. It accepts host authorization callbacks and scoped identities; it does not implement account authentication or medical policies. Keep this server entry out of browser bundles. Hosts on other server platforms need an equivalent adapter.

## StudyChat integration

The application adapter lives in StudyChat; it connects this package to its existing `/api/chat` and approved-message speech service. Source freshness, source-span hashes, whole-reply review, imports, replay protections, question banks and spaced repetition stay in StudyChat. Marin is the default; Cedar, Coral, Sage and Ash remain available there.

StudyChat copies a versioned runtime artifact through `scripts/sync-conversation-agent.mjs`, recording file hashes and source provenance. Do not edit generated vendor files. Edit this repository, validate affected behavior, sync the artifact and record the actual GitHub source revision. `sourceRevision` will be set after the first GitHub publication; it must not be invented. Private-test deployment uses StudyChat's feature branch, with the running revision verified separately.

## Privacy and operating limits

- Capture is foreground-only and explicit. End, mute, navigation, logout, backgrounding and a browser offline event release microphone tracks. Coming online does not automatically restart them. Provider/server failures offer manual recovery without an automatic paid retry.
- Audio pre-roll is memory-only. No raw-audio file storage or model-training feature is enabled.
- Only authenticated server services access provider credentials. There are no broad provider tokens in the component.
- Hosts enforce authorization, idempotency, duration/request limits and costs; cancellation does not imply zero provider charges.
- OpenAI is the initial provider. Claude is on hold. Astra is prohibited for development, inference, review, tests, selection and fallback.
- Existing host history, saved preferences and spaced-repetition records can inform coaching. Persistent-memory consent/inspection controls and editable pronunciation are **future host features**, not implemented package features. The core has no persistent learner database and never modifies validated study knowledge.

## Compatibility and evidence

First target: foreground Android Chrome over HTTPS. Native applications, embedded browsers, background operation, Bluetooth routing and other browsers need explicit platform validation. Unsupported cases retain manual or typed recovery; do not represent them as certified hands-free operation.

The package's **28 unique new test groups passed**. Scoped repeats were limited to a failed capture-limit case and changed circle wording; offline shutdown was one additional previously uncovered case. Integration/provider mocks are separate evidence; see [validation status](docs/VALIDATION_STATUS.md). No physical-phone latency or echo-separation result follows from these checks.

To open the implemented second-host demo, run this from the repository root:

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000/demo/`. Synthetic input and fixed replies require no credentials or provider calls. Optional real-microphone capture still returns an explicitly simulated transcript; optional device speech is a demo feature, not StudyChat's production fallback.

For new changes, run only new or affected groups with `node --test --test-name-pattern='affected scope' tests/example.test.js`. `npm test` runs the full package suite; do not repeat passing groups without a relevant change or documented failure.

## Rights and distribution

All rights reserved pending the owner's license selection. Public GitHub visibility does not itself grant an open-source license. Use original design assets and preserve dependency notices. Do not use OpenAI/ChatGPT marks as product branding or claim affiliation. Authorized AI voices remain subject to provider terms and must be disclosed as AI-generated.

Implementation and local evidence are recorded. Android physical acceptance and measured response timing remain outstanding. No perfect accuracy or universal compatibility claim is made.

## Lean module use

Hosts that need only typed conversation or supply their own audio/UI adapters can import `createConversationAgent` from `@aibotjock/conversation-agent/core`. This entry loads only the coordinator; it does not import microphone capture or DOM presentation modules. Existing root, browser-audio, voice-circle and server exports remain compatible.

The voice-circle renderer now leaves unchanged captions and accessibility attributes untouched during timer-only updates. One focused regression test observed zero text/attribute writes for those ticks and one write for a changed caption. The eight existing circle/demo tests also pass. This is reduced browser work, not a measured provider, transcription, playback or physical-phone latency improvement. Public adapter hooks and the optional echo-reference interface remain because they are supported, tested capabilities, even where StudyChat does not currently use them. No runtime dependency was added.
