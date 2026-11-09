import { CAPTURE_PROCESSOR, CAPTURE_WORKLET_SOURCE } from "./capture.js";
import { WebPlayer, type Player } from "./player.js";
import type { CallIO, MicHandle, MicState, SocketLike } from "./session.js";

/**
 * The call's machine, in a browser: a WebSocket, the microphone through a worklet, the speakers through Web Audio. One
 * audio context serves both directions, so that the browser's echo canceller, which works from what the page itself plays,
 * can take the assistant's voice out of what the microphone hears.
 */

/** How a person would name a microphone: the browser's name for it without the "Default - " it puts in front on Windows. */
export function micName(label: string): string {
  return label.replace(/^\s*(?:default|communications)\s+-\s+/i, "").trim();
}

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
        const track = stream.getAudioTracks()[0];
        const settings = track?.getSettings();
        // The browser says when the system or the device holds the microphone muted, and when it is lost; both leave a call
        // that listens to nothing, so both are passed on to be said.
        let listener: ((state: MicState) => void) | null = null;
        const onMute = () => listener?.("muted");
        const onUnmute = () => listener?.("live");
        const onEnded = () => listener?.("ended");
        track?.addEventListener("mute", onMute);
        track?.addEventListener("unmute", onUnmute);
        track?.addEventListener("ended", onEnded);
        return {
          echoCancelled: settings?.echoCancellation !== false,
          label: micName(track?.label ?? ""),
          muted: () => track?.muted === true,
          watch: (next) => {
            listener = next;
          },
          stop: () => {
            listener = null;
            track?.removeEventListener("mute", onMute);
            track?.removeEventListener("unmute", onUnmute);
            track?.removeEventListener("ended", onEnded);
            node.port.onmessage = null;
            try {
              source.disconnect();
              node.disconnect();
            } catch {
              /* already disconnected */
            }
            for (const each of stream.getTracks()) each.stop();
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
