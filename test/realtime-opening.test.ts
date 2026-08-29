import { afterEach, describe, expect, it, vi } from "vitest";
import { OpeningResponseCoordinator, REALTIME_INPUT_AUDIO_CONFIG } from "@/lib/volta/openai-agents-runtime";

describe("Realtime opening response", () => {
  afterEach(() => vi.useRealTimers());

  it("uses noise reduction and conservative semantic turn detection for phone audio", () => {
    expect(REALTIME_INPUT_AUDIO_CONFIG).toEqual({
      noiseReduction: { type: "far_field" },
      turnDetection: {
        type: "semantic_vad",
        eagerness: "low",
        createResponse: true,
        interruptResponse: true,
      },
    });
  });

  it("starts Luna after a short quiet window", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const opening = new OpeningResponseCoordinator(send);

    opening.request();
    vi.advanceTimersByTime(749);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("waits for a carrier or voicemail greeting to finish before speaking", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const opening = new OpeningResponseCoordinator(send);

    opening.request();
    vi.advanceTimersByTime(200);
    opening.onRemoteSpeechStarted();
    vi.advanceTimersByTime(2_000);
    expect(send).not.toHaveBeenCalled();

    opening.onRemoteSpeechStopped();
    vi.advanceTimersByTime(750);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate a server-VAD response and allows later control responses", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const opening = new OpeningResponseCoordinator(send);

    opening.request();
    opening.onResponseCreated();
    vi.advanceTimersByTime(2_000);
    expect(send).not.toHaveBeenCalled();

    opening.onAudioStopped();
    opening.request();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries when the opening is interrupted by remote speech", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const opening = new OpeningResponseCoordinator(send);

    opening.request();
    vi.advanceTimersByTime(750);
    opening.onResponseCreated();
    opening.onRemoteSpeechStarted();
    opening.onAudioInterrupted();
    opening.onResponseDone();
    vi.advanceTimersByTime(2_000);
    expect(send).toHaveBeenCalledTimes(1);

    opening.onRemoteSpeechStopped();
    vi.advanceTimersByTime(750);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
