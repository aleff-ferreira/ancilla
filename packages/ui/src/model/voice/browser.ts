import { CAPTURE_PROCESSOR, CAPTURE_WORKLET_SOURCE } from "./capture.js";
import { WebPlayer, type Player } from "./player.js";
import type { CallIO, MicHandle, SocketLike } from "./session.js";

/**
 * The call's machine, in a browser: a WebSocket, the microphone through a worklet, the speakers through Web Audio. One
 * audio context serves both directions, so that the browser's echo canceller, which works from what the page itself plays,
 * can take the assistant's voice out of what the microphone hears.
 */

export function browserCallIO(socketUrl: () => string | null): CallIO & { dispose(): void } {
  let context: AudioContext | null = null;

  const ensureContext = (): AudioContext => {
    if (!context || context.state === "closed") context = new AudioContext({ latencyHint: "interactive" });
    if (context.state === "suspended") void context.resume();
    return context;
  };

  return {
    socketUrl,
    openSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    async startMic(onFrame): Promise<MicHandle> {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("no microphone support"), { name: "NotFoundError" });
      const audio = ensureContext();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      try {
        const blob = new Blob([CAPTURE_WORKLET_SOURCE], { type: "application/javascript" });
        const address = URL.createObjectURL(blob);
        try {
          await audio.audioWorklet.addModule(address);
        } finally {
          URL.revokeObjectURL(address);
        }
        const source = audio.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(audio, CAPTURE_PROCESSOR, { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
        node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => onFrame(new Int16Array(event.data.pcm), event.data.rms);
        source.connect(node);
        const settings = stream.getAudioTracks()[0]?.getSettings();
        return {
          echoCancelled: settings?.echoCancellation !== false,
          stop: () => {
            node.port.onmessage = null;
            try {
              source.disconnect();
              node.disconnect();
            } catch {
              /* already disconnected */
            }
            for (const track of stream.getTracks()) track.stop();
          },
        };
      } catch (error) {
        for (const track of stream.getTracks()) track.stop();
        throw error;
      }
    },
    createPlayer: (sampleRate): Player => new WebPlayer(ensureContext(), sampleRate),
    dispose: () => {
      const closing = context;
      context = null;
      if (closing && closing.state !== "closed") void closing.close().catch(() => undefined);
    },
  };
}
