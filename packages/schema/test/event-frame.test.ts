import { describe, expect, it } from "vitest";
import { createEventFrameDecoder, encodeEventFrame, eventStreamHeaders } from "../src/event-frame.js";
import type { LogEvent } from "../src/log-event.js";

function stepStarted(seq: number): LogEvent {
  return {
    type: "step-started",
    seq,
    ts: "2026-07-28T12:00:00.000Z",
    run_id: "run-1",
    node_id: "greet",
    node_name: "greet",
    step_type: "binary",
    worker: { type: "engine" },
  };
}

describe("encodeEventFrame", () => {
  it("puts the event's seq on the id line, which is what a reconnect sends back", () => {
    const frame = encodeEventFrame(stepStarted(7));

    expect(frame.startsWith("id: 7\n")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
  });

  it("carries the event JSON verbatim, already snake_case", () => {
    const event = stepStarted(1);
    const dataLine = encodeEventFrame(event).split("\n")[1]!;

    expect(JSON.parse(dataLine.slice("data: ".length))).toEqual(event);
  });
});

describe("eventStreamHeaders", () => {
  it("asks for the full history when no seq is given", () => {
    expect(eventStreamHeaders()).toEqual({ Accept: "text/event-stream" });
  });

  it("asks the server to replay past a seq via Last-Event-ID", () => {
    expect(eventStreamHeaders(12)["Last-Event-ID"]).toBe("12");
  });

  it("sends seq 0 rather than dropping it — 0 means 'replay everything after the start'", () => {
    expect(eventStreamHeaders(0)["Last-Event-ID"]).toBe("0");
  });
});

describe("createEventFrameDecoder", () => {
  it("round-trips what the encoder wrote, id included", () => {
    const decoder = createEventFrameDecoder();
    const event = stepStarted(3);

    const [frame] = decoder.push(encodeEventFrame(event));

    expect(frame).toEqual({ id: "3", event });
  });

  it("returns every frame completed by one chunk, in order", () => {
    const decoder = createEventFrameDecoder();
    const chunk = [1, 2, 3].map((seq) => encodeEventFrame(stepStarted(seq))).join("");

    expect(decoder.push(chunk).map((frame) => frame.event.seq)).toEqual([1, 2, 3]);
  });

  it("holds a frame split across chunks until the rest arrives", () => {
    const decoder = createEventFrameDecoder();
    const whole = encodeEventFrame(stepStarted(4));
    const split = Math.floor(whole.length / 2);

    expect(decoder.push(whole.slice(0, split))).toEqual([]);
    expect(decoder.push(whole.slice(split)).map((frame) => frame.event.seq)).toEqual([4]);
  });

  it("keeps a trailing partial frame out of the results and completes it later", () => {
    const decoder = createEventFrameDecoder();
    const whole = encodeEventFrame(stepStarted(5));

    expect(decoder.push(`${encodeEventFrame(stepStarted(4))}${whole.slice(0, 10)}`).map((f) => f.event.seq)).toEqual([
      4,
    ]);
    expect(decoder.push(whole.slice(10)).map((frame) => frame.event.seq)).toEqual([5]);
  });

  it("reads `data:` with or without the leading space — the drift between the hand-written copies", () => {
    const decoder = createEventFrameDecoder();
    const event = stepStarted(6);

    const compact = decoder.push(`id:6\ndata:${JSON.stringify(event)}\n\n`);

    expect(compact).toEqual([{ id: "6", event }]);
  });

  it("skips a frame with no data line, so comments and keep-alives are not events", () => {
    const decoder = createEventFrameDecoder();

    expect(decoder.push(": keep-alive\n\n")).toEqual([]);
    expect(decoder.push(encodeEventFrame(stepStarted(1))).map((frame) => frame.event.seq)).toEqual([1]);
  });

  it("reports no id when the peer omitted the line, rather than inventing one", () => {
    const decoder = createEventFrameDecoder();
    const event = stepStarted(8);

    expect(decoder.push(`data: ${JSON.stringify(event)}\n\n`)).toEqual([{ id: undefined, event }]);
  });
});
