import { eventOutcome, type LogEvent, type StreamPhase } from "@path/client-core";
import { useEffect, useRef, useState } from "react";
import { eventMessage } from "@path/client-core";
import { formatClockTime } from "./format-time.js";
import { STATUS_GLYPH } from "./status-glyph.js";

export interface NarrativeProps {
  /** The complete narrative as the view-model holds it: `seq`-ordered and deduped. */
  events: readonly LogEvent[];
  stream: StreamPhase;
}

/**
 * The live-narrative surface: the run tree's log-event stream as a dense, `seq`-ordered list, under
 * the tree in the centre pane (#44 Variant A). `seq` is monotonic per root run and *is* the ordering
 * truth — timestamps collide under parallelism (CONTEXT.md, *Log event*) — so the row leads with it
 * and the view renders the order the model already established. Ordering, dedupe and
 * `Last-Event-ID` replay all live in `@path/client-core`; this component formats and follows.
 */
export function Narrative({ events, stream }: NarrativeProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const [following, setFollowing] = useState(true);

  const newestSeq = events.at(-1)?.seq;

  useEffect(() => {
    if (!following) return;
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [following, newestSeq]);

  const onScroll = (): void => {
    const list = listRef.current;
    if (!list) return;
    setFollowing(isAtBottom(list));
  };

  const follow = (): void => {
    // Setting the flag is not enough on its own: it is already false→true here, but if the list is
    // re-pinned while no new event arrives the effect has nothing to react to, so scroll directly.
    setFollowing(true);
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  };

  return (
    <section className="narrative" aria-labelledby="narrative-title">
      <header className="card-head">
        <h3 className="card-title" id="narrative-title">
          Narrative
        </h3>
        <StreamIndicator phase={stream} />
        <span className="card-count">{countLabel(events)}</span>
        {!following && (
          <button type="button" className="card-action" data-testid="narrative-follow" onClick={follow}>
            Jump to newest
          </button>
        )}
      </header>

      {events.length === 0 ? (
        <p className="pane-note" data-testid="narrative-empty">
          Nothing logged yet.
        </p>
      ) : (
        <ol className="event-list" data-testid="narrative-events" ref={listRef} onScroll={onScroll}>
          {events.map((event) => (
            <EventRow event={event} key={event.seq} />
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * One event: `seq`, time of day, then the message led by the status glyph the event implies. The
 * glyph is what keeps the row's status legible without hue — `data-status` only tints what the glyph
 * and the message already say.
 */
function EventRow({ event }: { event: LogEvent }) {
  const outcome = eventOutcome(event);
  return (
    <li className="event-row" data-type={event.type} data-status={outcome ?? undefined} data-seq={event.seq}>
      <span className="event-seq" data-testid={`event-seq-${event.seq}`}>
        {event.seq}
      </span>
      <time className="event-ts" dateTime={event.ts}>
        {formatClockTime(event.ts)}
      </time>
      <span className="event-msg">
        {outcome !== null && (
          <span className="event-glyph" aria-hidden="true">
            {STATUS_GLYPH[outcome]}
          </span>
        )}
        {eventMessage(event)}
      </span>
    </li>
  );
}

/**
 * How live the narrative is. `reconnecting` is deliberately not an alert: the core resumes from the
 * high-water `seq` on its own and the events arrive intact, so this is a liveness note, not a
 * failure. `role="status"` announces the change without stealing focus.
 */
function StreamIndicator({ phase }: { phase: StreamPhase }) {
  return (
    <span className="stream-indicator" data-phase={phase} data-testid="stream-indicator" role="status">
      {phase !== "closed" && <span className="stream-dot" aria-hidden="true" />}
      {STREAM_LABEL[phase]}
    </span>
  );
}

/** `closed` reads as "complete" because that is what it means to a watcher: the run is over. */
const STREAM_LABEL: Record<StreamPhase, string> = {
  connecting: "connecting…",
  live: "live · SSE",
  reconnecting: "reconnecting…",
  closed: "complete",
  failed: "stream lost",
};

/** The seq range, not just a count: it says whether the narrative starts at the run's first event. */
function countLabel(events: readonly LogEvent[]): string {
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last) return "0 events";
  return `${events.length} events · seq ${first.seq}–${last.seq}`;
}

/** A few pixels of slack: a "bottom" that demands an exact match never registers as reached. */
const FOLLOW_SLACK_PX = 4;

function isAtBottom(list: HTMLElement): boolean {
  return list.scrollHeight - list.scrollTop - list.clientHeight <= FOLLOW_SLACK_PX;
}
