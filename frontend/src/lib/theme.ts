"use client";

import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const EVENT = "nif-theme-change";
const KEY = "nif-theme";

export function setTheme(t: Theme) {
  document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* storage unavailable — theme still applies for this visit */
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

const read = (): Theme => (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, read, () => "dark");
}
