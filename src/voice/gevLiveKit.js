const LIVEKIT_TOKEN_URL = '/api/livekit/token';
const TOOL_TOPIC = 'gev.tools';

function decodeLiveKitPayload(payload) {
  if (typeof payload === 'string') return payload;
  if (payload instanceof Uint8Array) return new TextDecoder().decode(payload);
  if (payload?.buffer) return new TextDecoder().decode(new Uint8Array(payload.buffer));
  return String(payload || '');
}

export class GevLiveKitController {
  constructor({ runner, ui, radioLayer = null, dataManager = null }) {
    this.runner = runner;
    this.ui = ui;
    this.radioLayer = radioLayer;
    this.dataManager = dataManager;
    this.room = null;
    this.micTrack = null;
    this.audioEls = new Set();
    this.status = 'idle';
    this.buttonHandler = null;
    this.tierHandler = null;
    this.annotationEventUnsubscribe = null;
    this.startEpoch = 0;
  }

  isActive() {
    return this.status !== 'idle' && this.status !== 'error';
  }

  bindPushToTalkShortcut() {
    // Push-to-talk remains OpenAI-only for now. LiveKit mode is continuous mic.
  }

  syncCostUi() {
    if (this.ui?.tierButton) this.ui.tierButton.hidden = true;
    if (this.ui?.costSummary) this.ui.costSummary.textContent = 'Self-hosted voice';
  }

  toggleVoiceTier() {
    this.syncCostUi();
    return 'livekit';
  }

  setStatus(status, detail) {
    this.status = status;
    if (this.ui?.status) this.ui.status.textContent = detail || status;
    if (this.ui?.button) {
      this.ui.button.dataset.status = status;
      this.ui.button.setAttribute('aria-pressed', this.isActive() ? 'true' : 'false');
      this.ui.button.textContent = this.isActive() ? 'Stop voice' : 'Start voice';
    }
  }

  reportError(source, error) {
    const message = error?.message || String(error || 'unknown error');
    console.error(`[GEV LiveKit] ${source}:`, error);
    this.setStatus('error', `${source}: ${message}`);
  }

  async start() {
    if (this.isActive()) return;
    const epoch = ++this.startEpoch;
    this.setStatus('connecting', 'Connecting LiveKit');

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone support unavailable');
      }
      const [{ Room, RoomEvent, Track, createLocalAudioTrack }, tokenResponse] = await Promise.all([
        import('livekit-client'),
        fetch(LIVEKIT_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      ]);
      if (epoch !== this.startEpoch) return;
      if (!tokenResponse.ok) {
        const body = await tokenResponse.text().catch(() => '');
        throw new Error(`LiveKit token failed: HTTP ${tokenResponse.status}${body ? ` ${body}` : ''}`);
      }
      const { url, token, room: roomName } = await tokenResponse.json();
      const room = new Room({ adaptiveStream: true, dynacast: true });
      this.room = room;

      room.on(RoomEvent.DataReceived, (payload, participant, kind, topic) => {
        if (topic !== TOOL_TOPIC) return;
        this.handleToolPacket(payload).catch((error) => this.reportError('LiveKit tool bridge', error));
      });
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach();
        el.autoplay = true;
        this.audioEls.add(el);
        document.body.appendChild(el);
      });
      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        for (const el of track.detach()) {
          this.audioEls.delete(el);
          el.remove();
        }
      });
      room.on(RoomEvent.Disconnected, () => {
        if (this.room === room) this.stop({ preserveStatus: this.status === 'error' });
      });

      await room.connect(url, token);
      if (epoch !== this.startEpoch) return;
      this.micTrack = await createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true });
      await room.localParticipant.publishTrack(this.micTrack, { name: 'microphone' });
      this.setStatus('listening', `LiveKit voice on${roomName ? ` (${roomName})` : ''}`);
    } catch (error) {
      if (epoch === this.startEpoch) {
        this.stop({ preserveStatus: true });
        this.reportError('LiveKit connection', error);
      }
    }
  }

  async handleToolPacket(payload) {
    const message = JSON.parse(decodeLiveKitPayload(payload));
    if (message.type !== 'gev.tool_call') return;
    const result = await this.runner(message.name, message.arguments || {}, {
      signal: new AbortController().signal,
      isCurrent: () => this.room?.state === 'connected',
    });
    await this.sendToolResult(message.call_id, result);
  }

  async sendToolResult(callId, result) {
    if (!this.room || !callId) return;
    const payload = new TextEncoder().encode(JSON.stringify({
      type: 'gev.tool_result',
      call_id: callId,
      result,
    }));
    await this.room.localParticipant.publishData(payload, { reliable: true, topic: TOOL_TOPIC });
  }

  notifyMapEvent(payload) {
    if (!this.room) return false;
    const data = new TextEncoder().encode(JSON.stringify({ type: 'gev.map_event', payload }));
    this.room.localParticipant.publishData(data, { reliable: true, topic: TOOL_TOPIC });
    return true;
  }

  sendTextCommand(text) {
    if (!this.room || !text) return false;
    const data = new TextEncoder().encode(JSON.stringify({ type: 'gev.text_command', text }));
    this.room.localParticipant.publishData(data, { reliable: true, topic: TOOL_TOPIC });
    return true;
  }

  stop({ preserveStatus = false, removeUi = false } = {}) {
    this.startEpoch += 1;
    if (this.micTrack) {
      this.micTrack.stop();
      this.micTrack = null;
    }
    for (const el of this.audioEls) el.remove();
    this.audioEls.clear();
    if (this.room) {
      const room = this.room;
      this.room = null;
      room.disconnect();
    }
    if (removeUi) this.ui?.root?.remove?.();
    if (!preserveStatus) this.setStatus('idle', 'Voice off');
  }
}
