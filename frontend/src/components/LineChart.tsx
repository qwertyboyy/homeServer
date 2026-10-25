"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { clock } from "@/lib/format";

export interface Series {
  key: string;
  label: string;
  color: string; // CSS color / var
}

interface Point {
  t: number;
  values: Record<string, number | null>;
}

const BASE_PAD = { top: 12, right: 12, bottom: 22, left: 36 };

function niceMax(v: number) {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
}

/**
 * Dependency-free SVG line chart: one y-axis, recessive grid, 2px lines,
 * crosshair + tooltip on hover/touch, legend for ≥2 series.
 */
export function LineChart({
  points,
  series,
  format,
  max,
  height = 200,
  label,
}: {
  points: Point[];
  series: Series[];
  format: (v: number) => string;
  max?: number;
  height?: number;
  label: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const gradId = useId();

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const yMax = useMemo(() => {
    if (max !== undefined) return max;
    let m = 0;
    for (const p of points) for (const s of series) m = Math.max(m, p.values[s.key] ?? 0);
    return niceMax(m * 1.1);
  }, [points, series, max]);

  const ticks = [0, 0.5, 1].map((f) => f * yMax);
  // Left padding fits the widest y-axis label (10px monospace ≈ 6px per char).
  const PAD = { ...BASE_PAD, left: Math.max(BASE_PAD.left, Math.max(...ticks.map((v) => format(v).length)) * 6 + 12) };
  const innerW = Math.max(0, width - PAD.left - PAD.right);
  const innerH = height - PAD.top - PAD.bottom;

  const t0 = points[0]?.t ?? 0;
  const t1 = points[points.length - 1]?.t ?? 1;
  const x = (t: number) => PAD.left + (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * innerW);
  const y = (v: number) => PAD.top + innerH - (Math.min(v, yMax) / yMax) * innerH;

  const paths = series.map((s) => {
    let d = "";
    let pen = false;
    for (const p of points) {
      const v = p.values[s.key];
      if (v === null || v === undefined) {
        pen = false; // gap for missing data — never interpolate a fake value
        continue;
      }
      d += `${pen ? "L" : "M"}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  });

  const hp = hover !== null ? points[hover] : null;

  const onMove = (clientX: number) => {
    const el = wrap.current;
    if (!el || points.length === 0) return;
    const rel = clientX - el.getBoundingClientRect().left - PAD.left;
    const i = Math.round((rel / Math.max(1, innerW)) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };

  const last = points[points.length - 1];

  return (
    <div>
      {series.length >= 2 && (
        <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2" aria-label="Legenda">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} aria-hidden />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div
        ref={wrap}
        className="relative w-full touch-pan-y select-none"
        style={{ height }}
        onPointerMove={(e) => onMove(e.clientX)}
        onPointerDown={(e) => onMove(e.clientX)}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={label}
      >
        {width > 0 && (
          <svg width={width} height={height} className="block overflow-visible">
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={series[0]?.color} stopOpacity="0.22" />
                <stop offset="1" stopColor={series[0]?.color} stopOpacity="0" />
              </linearGradient>
            </defs>
            {ticks.map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={PAD.left + innerW} y1={y(v)} y2={y(v)} stroke="var(--grid)" />
                <text x={PAD.left - 8} y={y(v)} dy="0.32em" textAnchor="end" className="fill-muted font-mono text-[10px]">
                  {format(v)}
                </text>
              </g>
            ))}
            {points.length > 1 && (
              <>
                <text x={PAD.left} y={height - 4} className="fill-muted font-mono text-[10px]">
                  {clock(t0, false)}
                </text>
                <text x={PAD.left + innerW} y={height - 4} textAnchor="end" className="fill-muted font-mono text-[10px]">
                  {clock(t1, false)}
                </text>
              </>
            )}
            {series.length === 1 && paths[0] && (
              <path
                d={`${paths[0]}L${x(t1).toFixed(1)},${y(0)}L${x(t0).toFixed(1)},${y(0)}Z`}
                fill={`url(#${gradId})`}
              />
            )}
            {series.map((s, i) => (
              <path
                key={s.key}
                d={paths[i]}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {hp && (
              <g>
                <line x1={x(hp.t)} x2={x(hp.t)} y1={PAD.top} y2={PAD.top + innerH} stroke="var(--border-strong)" />
                {series.map((s) => {
                  const v = hp.values[s.key];
                  return v === null || v === undefined ? null : (
                    <circle key={s.key} cx={x(hp.t)} cy={y(v)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
                  );
                })}
              </g>
            )}
            {!hp &&
              last &&
              series.length === 1 &&
              last.values[series[0].key] !== null && (
                <circle cx={x(last.t)} cy={y(last.values[series[0].key]!)} r={4} fill={series[0].color} stroke="var(--surface)" strokeWidth={2} />
              )}
          </svg>
        )}
        {hp && (
          <div
            className="pointer-events-none absolute top-1 z-10 min-w-32 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-card"
            style={
              x(hp.t) > width / 2
                ? { right: width - x(hp.t) + 10 }
                : { left: x(hp.t) + 10 }
            }
          >
            <p className="mb-1 font-mono text-muted">{clock(hp.t)}</p>
            {series.map((s) => {
              const v = hp.values[s.key];
              return (
                <p key={s.key} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-ink-2">
                    <span className="size-2 rounded-full" style={{ background: s.color }} aria-hidden />
                    {s.label}
                  </span>
                  <span className="font-mono text-ink">{v === null || v === undefined ? "N/A" : format(v)}</span>
                </p>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** Accessible table view of the same data (most recent first). */
export function ChartTable({ points, series, format, rows = 12 }: { points: Point[]; series: Series[]; format: (v: number) => string; rows?: number }) {
  const recent = points.slice(-rows).reverse();
  return (
    <div className="max-h-64 overflow-auto rounded-lg border border-line">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-surface-2 text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Waktu</th>
            {series.map((s) => (
              <th key={s.key} className="px-3 py-2 text-right font-medium">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono">
          {recent.map((p) => (
            <tr key={p.t} className="border-t border-line">
              <td className="px-3 py-1.5 text-muted">{clock(p.t)}</td>
              {series.map((s) => {
                const v = p.values[s.key];
                return (
                  <td key={s.key} className="px-3 py-1.5 text-right">
                    {v === null || v === undefined ? "N/A" : format(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
