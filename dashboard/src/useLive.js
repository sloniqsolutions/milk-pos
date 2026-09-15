import { useCallback, useEffect, useRef, useState } from 'react';
import { live } from './api';

/**
 * Poll the cloud, and keep track of how stale *our own* view is.
 *
 * This hook exists because of a failure that is easy to miss: if the polling
 * stops — the owner's connection drops, the server restarts, a laptop sleeps —
 * the last successful response keeps rendering. Every branch card still says
 * "live", because each was live when it was fetched. The page looks perfectly
 * healthy while showing figures from twenty minutes ago.
 *
 * So there are two independent staleness clocks:
 *
 *   1. **Per branch** — how long since the *cloud* heard from that till.
 *      Computed on the server, in routes/live.js.
 *   2. **The page itself** — how long since *we* heard from the cloud.
 *      Computed here. When this goes stale the whole page is greyed out, and
 *      nothing below it can be read as current.
 *
 * A per-card badge alone cannot catch the second one.
 */

const POLL_MS = 10 * 1000;

/** Past this without a successful fetch, nothing on screen may be trusted. */
export const PAGE_STALE_MS = 60 * 1000;

export function useLive(enabled) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [, setTick] = useState(0);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    // A slow response must not cause overlapping requests to pile up on a poor
    // connection; skipping a beat is always better than queueing them.
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await live.read();
      setData(next);
      setFetchedAt(Date.now());
      setError(null);
    } catch (err) {
      // Keep the last good data on screen — but the banner will now mark the
      // whole page as frozen, so it cannot be mistaken for current.
      setError(err);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    load();
    const poll = setInterval(load, POLL_MS);
    // A second, faster timer purely to re-render the relative times ("14s ago")
    // so ages stay honest between polls rather than freezing at their last value.
    const clock = setInterval(() => setTick(t => t + 1), 1000);
    return () => { clearInterval(poll); clearInterval(clock); };
  }, [enabled, load]);

  const pageAgeMs = fetchedAt == null ? null : Date.now() - fetchedAt;
  const pageStale = pageAgeMs == null ? false : pageAgeMs > PAGE_STALE_MS;

  return { data, error, fetchedAt, pageAgeMs, pageStale, reload: load };
}
