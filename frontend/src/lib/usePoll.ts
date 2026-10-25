"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

export interface PollState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  updatedAt: string | null;
  refresh: () => void;
}

interface Snapshot<T> {
  path: string | null;
  data: T | null;
  error: string | null;
  updatedAt: string | null;
  settled: boolean;
}

/**
 * Polls an API path. Pauses while the tab is hidden and refreshes once it
 * becomes visible again, so idle tabs do not load the server.
 */
export function usePoll<T>(path: string | null, intervalMs: number): PollState<T> {
  const [snap, setSnap] = useState<Snapshot<T>>({ path, data: null, error: null, updatedAt: null, settled: false });
  const inFlight = useRef<string | null>(null);
  const pathRef = useRef(path);

  const load = useCallback(async () => {
    const current = pathRef.current;
    if (!current || inFlight.current === current) return;
    inFlight.current = current;
    try {
      const res = await api<T>(current);
      if (pathRef.current !== current) return; // a newer path superseded this request
      setSnap({ path: current, data: res.data, error: null, updatedAt: res.timestamp, settled: true });
    } catch (e) {
      if (pathRef.current !== current) return;
      const error = e instanceof Error ? e.message : "Gagal memuat data";
      // Keep the last good data on screen and flag it as stale.
      setSnap((s) => (s.path === current ? { ...s, error, settled: true } : { path: current, data: null, error, updatedAt: null, settled: true }));
    } finally {
      if (inFlight.current === current) inFlight.current = null;
    }
  }, []);

  useEffect(() => {
    pathRef.current = path;
    if (!path) return;

    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      void load();
      timer = setInterval(() => void load(), intervalMs);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [path, intervalMs, load]);

  // Data belonging to a previous path is never shown for the new one.
  const fresh = snap.path === path;
  return {
    data: fresh ? snap.data : null,
    error: fresh ? snap.error : null,
    loading: !fresh || !snap.settled,
    updatedAt: fresh ? snap.updatedAt : null,
    refresh: () => void load(),
  };
}
