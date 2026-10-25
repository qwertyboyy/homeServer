import type { Response } from "express";

/** Consistent envelope: { data, timestamp, error } */
export function ok<T>(res: Response, data: T, status = 200) {
  res.status(status).json({ data, timestamp: new Date().toISOString(), error: null });
}

export function fail(res: Response, status: number, message: string) {
  res.status(status).json({ data: null, timestamp: new Date().toISOString(), error: message });
}
