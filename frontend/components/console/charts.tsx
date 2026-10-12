'use client';

import { useEffect, useId, useRef, useState } from 'react';

export interface Point {
  label: string;
  value: number;
}

/** Measures the element's width so the SVG renders at real pixel size. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * mag;
}

const HEIGHT = 300;
const PAD = { top: 16, bottom: 34, left: 60 };
const AXIS = { fontSize: 12, fill: 'var(--muted)' };

interface Hover { x: number; y: number; label: string; value: string }

function Tooltip({ h, width }: { h: Hover | null; width: number }) {
  if (!h) return null;
  const left = Math.min(Math.max(h.x - 80, 0), width - 160);
  return (
    <div role="status" className="pointer-events-none absolute z-10 w-[160px] rounded-lg px-3.5 py-2.5"
         style={{ left, top: Math.max(h.y - 78, 0), background: '#0d1728', border: '1px solid var(--line)', boxShadow: '0 8px 24px rgba(0,0,0,.35)' }}>
      <div className="num text-[17px] font-medium" style={{ color: 'var(--ink)' }}>{h.value}</div>
      <div className="mt-0.5 text-[12px]" style={{ color: 'var(--muted)' }}>{h.label}</div>
    </div>
  );
}

/** Single series area: soft gradient wash, 2.25px line, end label, crosshair. */
export function AreaChart({ points, width, format, axisFormat, color = 'var(--profit)' }: {
  points: Point[]; width: number; format: (v: number) => string; axisFormat: (v: number) => string; color?: string;
}) {
  const id = useId().replace(/:/g, '');
  const [hover, setHover] = useState<Hover | null>(null);
  const endText = points.length ? format(points[points.length - 1].value) : '';
  const padRight = Math.max(30, endText.length * 8.4 + 20);
  const plotW = Math.max(10, width - PAD.left - padRight);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const min = Math.min(0, ...points.map((p) => p.value));
  const max = niceMax(Math.max(...points.map((p) => p.value), 0));
  const x = (i: number) => PAD.left + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - ((v - min) / (max - min || 1)) * plotH;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${y(min)} L${x(0).toFixed(1)},${y(min)} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => min + (max - min) * f);
  const every = Math.ceil(points.length / Math.max(2, Math.floor(plotW / 110)));
  const last = points[points.length - 1];

  return (
    <div className="relative">
      <svg width={width} height={HEIGHT} role="img" aria-label="Area chart">
        <defs>
          <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.28} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} stroke="var(--line-soft)" strokeWidth={1} />
            <text x={PAD.left - 12} y={y(t) + 4} textAnchor="end" className="num" {...AXIS}>{axisFormat(t)}</text>
          </g>
        ))}
        {points.map((p, i) => {
          const isLast = i === points.length - 1;
          const show = isLast || (i % every === 0 && points.length - 1 - i >= every * 0.75);
          return show ? <text key={p.label} x={x(i)} y={HEIGHT - 10} textAnchor={isLast ? 'end' : 'middle'} {...AXIS}>{p.label}</text> : null;
        })}
        <path d={area} fill={`url(#g${id})`} />
        <path d={line} fill="none" stroke={color} strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" />
        {last && (
          <>
            <circle cx={x(points.length - 1)} cy={y(last.value)} r={8} fill={color} opacity={0.18} />
            <circle cx={x(points.length - 1)} cy={y(last.value)} r={4.5} fill={color} stroke="var(--panel)" strokeWidth={2} />
            <text x={x(points.length - 1) + 12} y={y(last.value) + 5} fontSize={14} fontWeight={500} fill="var(--ink)" className="num">{endText}</text>
          </>
        )}
        {hover && (
          <>
            <line x1={hover.x} x2={hover.x} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--faint)" strokeWidth={1} />
            <circle cx={hover.x} cy={hover.y} r={5} fill={color} stroke="var(--panel)" strokeWidth={2} />
          </>
        )}
        <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} fill="transparent"
              onPointerMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const i = Math.min(points.length - 1, Math.max(0, Math.round(((e.clientX - rect.left) / rect.width) * (points.length - 1))));
                setHover({ x: x(i), y: y(points[i].value), label: points[i].label, value: format(points[i].value) });
              }}
              onPointerLeave={() => setHover(null)} />
      </svg>
      <Tooltip h={hover} width={width} />
    </div>
  );
}

/** Single series columns: at most 24px wide, 4px rounded tops, square at the baseline. */
export function ColumnChart({ points, width, format, color = 'var(--profit)' }: {
  points: Point[]; width: number; format: (v: number) => string; color?: string;
}) {
  const [hover, setHover] = useState<(Hover & { i: number }) | null>(null);
  const plotW = Math.max(10, width - PAD.left - 20);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(...points.map((p) => p.value), 1));
  const band = plotW / Math.max(points.length, 1);
  const barW = Math.min(24, Math.max(3, band - 4));
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  const every = Math.ceil(points.length / Math.max(2, Math.floor(plotW / 110)));
  const peak = points.reduce((best, p, i) => (p.value > points[best].value ? i : best), 0);

  return (
    <div className="relative">
      <svg width={width} height={HEIGHT} role="img" aria-label="Column chart">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} stroke="var(--line-soft)" strokeWidth={1} />
            <text x={PAD.left - 12} y={y(t) + 4} textAnchor="end" className="num" {...AXIS}>{format(t)}</text>
          </g>
        ))}
        {points.map((p, i) => {
          const cx = PAD.left + band * i + band / 2;
          const h = Math.max(0, y(0) - y(p.value));
          const r = Math.min(4, h, barW / 2);
          const x0 = cx - barW / 2;
          const top = y(p.value);
          const d = h > 0 ? `M${x0},${y(0)} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + barW - r} Q${x0 + barW},${top} ${x0 + barW},${top + r} V${y(0)} Z` : '';
          const tip = { i, x: cx, y: top, label: p.label, value: format(p.value) };
          return (
            <g key={p.label}>
              {d && <path d={d} fill={color} opacity={hover && hover.i !== i ? 0.5 : 1} />}
              {i % every === 0 && <text x={cx} y={HEIGHT - 10} textAnchor="middle" {...AXIS}>{p.label}</text>}
              {i === peak && p.value > 0 && <text x={cx} y={top - 8} textAnchor="middle" fontSize={13} fontWeight={500} fill="var(--ink)" className="num">{format(p.value)}</text>}
              <rect x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} fill="transparent" tabIndex={0}
                    aria-label={`${p.label}: ${format(p.value)}`}
                    onPointerEnter={() => setHover(tip)} onFocus={() => setHover(tip)}
                    onPointerLeave={() => setHover(null)} onBlur={() => setHover(null)} />
            </g>
          );
        })}
        <line x1={PAD.left} x2={PAD.left + plotW} y1={y(0)} y2={y(0)} stroke="var(--line)" strokeWidth={1} />
      </svg>
      <Tooltip h={hover} width={width} />
    </div>
  );
}

/** Table twin for any chart: every value is reachable without hovering. */
export function DataTable({ columns, rows, maxHeight = 300 }: { columns: string[]; rows: string[][]; maxHeight?: number }) {
  return (
    <div className="c-table-wrap" style={{ maxHeight }}>
      <table className="c-table">
        <thead><tr>{columns.map((c, i) => <th key={c} className={i ? 'r' : ''}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[0]}>{row.map((cell, i) => <td key={i} className={i ? 'r num' : ''}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
