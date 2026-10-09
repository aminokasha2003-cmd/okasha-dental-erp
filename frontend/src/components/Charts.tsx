import { useState, type CSSProperties } from "react";

// Small charts for the dashboards: columns over time (one or two series) and
// ranked horizontal bars. Colours come from --series-1 / --series-2, checked for
// colour-blind separation in light and dark.

export interface ColumnPoint {
  label: string;
  values: number[];
}

function niceMax(n: number) {
  if (n <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(n));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * pow >= n) ?? 10;
  return step * pow;
}

export function ColumnChart({
  points,
  series,
  format = (n) => String(n),
  height = 200,
}: {
  points: ColumnPoint[];
  series: string[];
  format?: (n: number) => string;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...points.flatMap((p) => p.values)));
  const ticks = [0, max / 2, max];
  return (
    <figure className="chart">
      {series.length > 1 && (
        <figcaption className="chart-legend-row">
          {series.map((s, i) => (
            <span key={s}>
              <i className={`chart-key s${i + 1}`} aria-hidden="true" /> {s}
            </span>
          ))}
        </figcaption>
      )}
      <div className="col-chart" style={{ "--h": `${height}px` } as CSSProperties} onMouseLeave={() => setHover(null)}>
        <div className="col-grid" aria-hidden="true">
          {ticks
            .slice()
            .reverse()
            .map((tk) => (
              <span key={tk}>
                <em>{format(tk)}</em>
              </span>
            ))}
        </div>
        <div className="col-plot" role="list">
          {points.map((p, i) => (
            <div
              key={p.label + i}
              role="listitem"
              className={`col-group ${hover === i ? "is-hover" : ""}`}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              tabIndex={0}
              aria-label={`${p.label}: ${p.values.map((v, k) => `${series[k]} ${format(v)}`).join(", ")}`}
              style={{ "--i": i } as CSSProperties}
            >
              <div className="col-bars">
                {p.values.map((v, k) => (
                  <span key={k} className={`col-bar s${k + 1}`} style={{ height: `${(v / max) * 100}%` }} />
                ))}
              </div>
              <span className="col-label">{p.label}</span>
              {hover === i && (
                <span className="chart-tip" role="tooltip">
                  <strong>{p.label}</strong>
                  {p.values.map((v, k) => (
                    <span key={k}>
                      <i className={`chart-key s${k + 1}`} aria-hidden="true" /> {series[k]}: {format(v)}
                    </span>
                  ))}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </figure>
  );
}

export function BarList({
  rows,
  format = (n) => String(n),
  empty,
}: {
  rows: { key: string; label: string; value: number; note?: string }[];
  format?: (n: number) => string;
  empty: string;
}) {
  if (!rows.length) return <p className="muted small">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  return (
    <ul className="bar-list">
      {rows.map((r, i) => (
        <li key={r.key} style={{ "--i": i } as CSSProperties} title={`${r.label}: ${format(r.value)}${r.note ? ` · ${r.note}` : ""}`}>
          <span className="bar-list-label">{r.label}</span>
          <span className="bar-list-track">
            <span className="bar-list-fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
          <span className="bar-list-value">
            {format(r.value)}
            {r.note && <small>{r.note}</small>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Headline number with a label and an optional line underneath. */
export function KpiTile({ label, value, sub, tone, i = 0 }: { label: string; value: string; sub?: string; tone?: "warn" | "good" | "accent"; i?: number }) {
  return (
    <div className={`kpi ${tone ? `kpi-${tone}` : ""}`} style={{ "--i": i } as CSSProperties}>
      <p className="kpi-label">{label}</p>
      <p className="kpi-value">{value}</p>
      {sub && <p className="kpi-sub">{sub}</p>}
    </div>
  );
}
