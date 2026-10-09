import { useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useI18n, type TKey } from "../i18n";
import type { Surface, SurfaceState, ToothRecord } from "../types";

// FDI chart drawn as two arches of real tooth outlines seen from the biting side,
// after Amin's oral check reference. The patient's right is on the left of the
// screen in both languages. Each tooth shows its five surfaces inside its outline.

export const UPPER = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28];
export const LOWER = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38];
export const ALL_TEETH = [...UPPER, ...LOWER];
export const SURFACES: Surface[] = ["M", "D", "O", "B", "L"];
export const SURFACE_STATES: SurfaceState[] = ["sound", "caries", "filling", "rct"];

export const FILL: Record<SurfaceState, string> = { sound: "#FFFFFF", caries: "#E3957F", filling: "#A9C0D3", rct: "#16242F" };
const CROWN = "#446681";

type Side = "top" | "right" | "bottom" | "left";

/** Which surface each side of an upright drawing shows (used by the surface editor). */
export function surfaceAt(tooth: number): Record<Side, Surface> {
  const quadrant = Math.floor(tooth / 10);
  const mesialRight = quadrant === 1 || quadrant === 4;
  return { top: "B", bottom: "L", right: mesialRight ? "M" : "D", left: mesialRight ? "D" : "M" };
}

const QUADRANT: Record<number, TKey> = { 1: "tooth.q1", 2: "tooth.q2", 3: "tooth.q3", 4: "tooth.q4" };

export function toothName(tooth: number, t: (k: TKey, v?: Record<string, string | number>) => string) {
  return t("tooth.name", { kind: t(`tooth.kind${tooth % 10}` as TKey), side: t(QUADRANT[Math.floor(tooth / 10)]) });
}

export function emptyTooth(patient: number, tooth: number): ToothRecord {
  return { patient, tooth, missing: false, crown: false, implant: false, root_canal_treated: false, surfaces: {}, note: "" };
}

/** Plain-language status such as "Root canal treated · Crown planned". */
export function toothStatus(rec: ToothRecord | undefined, planned: string[], t: (k: TKey) => string) {
  const parts: string[] = [];
  if (rec?.missing) parts.push(t("tooth.missing"));
  if (rec?.implant) parts.push(t(rec.crown ? "tooth.implantCrown" : "tooth.implant"));
  else if (rec?.crown) parts.push(t("tooth.crown"));
  if (rec?.root_canal_treated) parts.push(t("tooth.rct"));
  const states = new Set(Object.values(rec?.surfaces ?? {}));
  if (states.has("caries")) parts.push(t("surface.caries"));
  if (states.has("filling")) parts.push(t("surface.filling"));
  if (!parts.length) parts.push(t("tooth.sound"));
  return [...parts, ...planned].join(" · ");
}

/* ----------------------------------------------------------- tooth shapes */

// Outlines seen from the biting side, centred on 0,0: x runs front to back
// along the arch, -y faces the cheek or lip.
const OUTLINE = {
  molar:
    "M -18 -19 C -8 -24 8 -24 18 -19 C 24 -14 24 -5 21.5 0 C 24 6 24 15 17 20 C 8 24 -8 24 -17 20 C -24 15 -24 6 -21.5 0 C -24 -5 -24 -14 -18 -19 Z",
  premolar:
    "M -11 -17 C -4 -21 4 -21 11 -17 C 16 -12 16.5 -4 14 0 C 16.5 5 16 12 11 17 C 4 21 -4 21 -11 17 C -16 12 -16.5 5 -14 0 C -16.5 -4 -16 -12 -11 -17 Z",
  canine: "M 0 -18 C 8 -17 15 -9 15 0 C 15 9 8 16 0 16 C -8 16 -15 9 -15 0 C -15 -9 -8 -17 0 -18 Z",
  incisor: "M -16 -4 C -10 -11 10 -11 16 -4 C 17.5 2 12 9 0 10 C -12 9 -17.5 2 -16 -4 Z",
};
type Kind = keyof typeof OUTLINE;

function kindOf(tooth: number): Kind {
  const d = tooth % 10;
  return d <= 2 ? "incisor" : d === 3 ? "canine" : d <= 5 ? "premolar" : "molar";
}

// Width along the arch and drawing scale for each tooth position (1 = central incisor).
const UPPER_SIZE: Record<number, number> = { 1: 1.05, 2: 0.86, 3: 1, 4: 1, 5: 0.96, 6: 1.04, 7: 0.98, 8: 0.88 };
const LOWER_SIZE: Record<number, number> = { 1: 0.72, 2: 0.78, 3: 0.95, 4: 0.98, 5: 1, 6: 1.08, 7: 1.02, 8: 0.92 };
const BASE_WIDTH: Record<Kind, number> = { incisor: 34, canine: 30, premolar: 31, molar: 46 };

// The outlines are drawn small; this sets their size in the arch drawing.
const ARCH_SCALE = 1.4;

function scaleOf(tooth: number) {
  const q = Math.floor(tooth / 10);
  return (q === 1 || q === 2 ? UPPER_SIZE : LOWER_SIZE)[tooth % 10];
}

const WEDGE: Record<Side, string> = {
  top: "0,0 -40,-40 40,-40",
  right: "0,0 40,-40 40,40",
  bottom: "0,0 40,40 -40,40",
  left: "0,0 -40,40 -40,-40",
};

function fillFor(record: ToothRecord | undefined, surface: Surface) {
  if (record?.crown) return CROWN;
  const state = record?.surfaces?.[surface];
  if (state) return FILL[state];
  if (surface === "O" && record?.root_canal_treated) return FILL.rct;
  return null;
}

/** One tooth outline with its five surfaces. Used in the arch and, large, in the surface editor. */
function ToothGlyph({
  tooth,
  record,
  sides,
  onSurface,
  labelFor,
}: {
  tooth: number;
  record?: ToothRecord;
  sides: Record<Side, Surface>;
  onSurface?: (surface: Surface) => void;
  labelFor?: (surface: Surface) => string;
}) {
  const kind = kindOf(tooth);
  const clip = `tooth-clip-${tooth}-${onSurface ? "edit" : "chart"}`;
  const missing = Boolean(record?.missing && !record.implant);
  const centre = kind === "incisor" ? "scale(0.62 0.22)" : kind === "canine" ? "scale(0.3)" : "scale(0.42)";
  const hit = (surface: Surface) =>
    onSurface
      ? {
          role: "button",
          tabIndex: 0,
          "aria-label": labelFor?.(surface),
          className: "surface-hit",
          onClick: () => onSurface(surface),
          onKeyDown: (e: KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSurface(surface);
            }
          },
        }
      : {};
  return (
    <>
      <defs>
        <clipPath id={clip}>
          <path d={OUTLINE[kind]} />
        </clipPath>
      </defs>
      <path d={OUTLINE[kind]} className={`tooth-base ${missing ? "is-missing" : ""} ${record?.crown ? "is-crown" : ""}`} />
      {!missing && (
        <g clipPath={`url(#${clip})`}>
          {(Object.keys(WEDGE) as Side[]).map((side) => {
            const fill = fillFor(record, sides[side]);
            return <polygon key={side} points={WEDGE[side]} fill={fill ?? "transparent"} className="tooth-wedge" {...hit(sides[side])} />;
          })}
          <path d={OUTLINE[kind]} transform={centre} fill={fillFor(record, "O") ?? "transparent"} className="tooth-centre" {...hit("O")} />
        </g>
      )}
      <path d={OUTLINE[kind]} className={`tooth-outline ${missing ? "is-missing" : ""}`} />
      {record?.implant && (
        <g className="tooth-implant" aria-hidden="true">
          <circle r="5.5" />
          <path d="M -3 0 H 3 M 0 -3 V 3" />
        </g>
      )}
    </>
  );
}

export function SurfaceDiagram({
  tooth,
  record,
  size = 34,
  onSurface,
  labelFor,
}: {
  tooth: number;
  record?: ToothRecord;
  size?: number;
  onSurface?: (surface: Surface) => void;
  labelFor?: (surface: Surface) => string;
}) {
  return (
    <svg viewBox="-28 -28 56 56" width={size} height={size} aria-hidden={onSurface ? undefined : true} className="surface-svg tooth-svg">
      <ToothGlyph tooth={tooth} record={record} sides={surfaceAt(tooth)} onSurface={onSurface} labelFor={labelFor} />
    </svg>
  );
}

/* ------------------------------------------------------------- the arches */

interface Placed {
  tooth: number;
  x: number;
  y: number;
  angle: number;
  scale: number;
  sides: Record<Side, Surface>;
  labelX: number;
  labelY: number;
  order: number;
}

const W = 760;
const H = 700;
const CX = W / 2;

/** Puts each tooth on an ellipse, spaced by its own width, facing outwards. */
function layout(): Placed[] {
  const placed: Placed[] = [];
  const arches = [
    { upper: true, cy: 334, rx: 300, ry: 268, teeth: [11, 12, 13, 14, 15, 16, 17, 18], other: [21, 22, 23, 24, 25, 26, 27, 28] },
    { upper: false, cy: 368, rx: 288, ry: 268, teeth: [41, 42, 43, 44, 45, 46, 47, 48], other: [31, 32, 33, 34, 35, 36, 37, 38] },
  ];
  for (const arch of arches) {
    for (const [side, row] of [
      [-1, arch.teeth],
      [1, arch.other],
    ] as const) {
      const point = (th: number) => ({ x: CX + side * arch.rx * Math.sin(th), y: arch.upper ? arch.cy - arch.ry * Math.cos(th) : arch.cy + arch.ry * Math.cos(th) });
      let th = 0;
      let walked = 0;
      let target = 2.5;
      row.forEach((tooth, i) => {
        const width = BASE_WIDTH[kindOf(tooth)] * scaleOf(tooth) * ARCH_SCALE;
        target += width / 2 + (i === 0 ? 0 : 0);
        while (walked < target) {
          const a = point(th);
          const b = point(th + 0.002);
          walked += Math.hypot(b.x - a.x, b.y - a.y);
          th += 0.002;
        }
        const p = point(th);
        const q = point(th + 0.002);
        const tx = q.x - p.x;
        const ty = q.y - p.y;
        // Outward normal: away from the arch centre.
        let nx = ty;
        let ny = -tx;
        if (nx * (p.x - CX) + ny * (p.y - arch.cy) < 0) {
          nx = -nx;
          ny = -ny;
        }
        const len = Math.hypot(nx, ny);
        nx /= len;
        ny /= len;
        const angle = Math.atan2(nx, -ny);
        // Local +x points along (cos, sin); the front of the mouth is back along the tangent.
        const plusXIsMesial = Math.cos(angle) * -tx + Math.sin(angle) * -ty > 0;
        const scale = scaleOf(tooth) * ARCH_SCALE;
        const depth = (kindOf(tooth) === "incisor" ? 11 : 21) * scale;
        placed.push({
          tooth,
          x: p.x,
          y: p.y,
          angle: (angle * 180) / Math.PI,
          scale,
          sides: { top: "B", bottom: "L", right: plusXIsMesial ? "M" : "D", left: plusXIsMesial ? "D" : "M" },
          labelX: p.x + nx * (depth + 17),
          labelY: p.y + ny * (depth + 17),
          order: i,
        });
        target += width / 2 + 4;
      });
    }
  }
  return placed;
}

const PLACED = layout();

export function DentalChart({
  teeth,
  planned,
  selected,
  onSelect,
}: {
  teeth: Record<number, ToothRecord>;
  planned: Record<number, string[]>;
  selected: number | null;
  onSelect: (tooth: number) => void;
}) {
  const { t } = useI18n();
  const [focus, setFocus] = useState<number>(selected ?? 11);
  const counts = useMemo(() => {
    const recs = Object.values(teeth);
    return {
      caries: recs.filter((r) => Object.values(r.surfaces ?? {}).includes("caries")).length,
      missing: recs.filter((r) => r.missing && !r.implant).length,
      treated: recs.filter((r) => r.crown || r.implant || r.root_canal_treated || Object.values(r.surfaces ?? {}).includes("filling")).length,
      planned: Object.values(planned).filter((p) => p.length).length,
    };
  }, [teeth, planned]);

  // Arrow keys move along the arch, so the chart works without a mouse.
  const onKey = (e: KeyboardEvent, tooth: number) => {
    const row = UPPER.includes(tooth) ? UPPER : LOWER;
    const i = row.indexOf(tooth);
    let next: number | undefined;
    if (e.key === "ArrowRight") next = row[i + 1];
    if (e.key === "ArrowLeft") next = row[i - 1];
    if (e.key === "ArrowDown" && row === UPPER) next = LOWER[i];
    if (e.key === "ArrowUp" && row === LOWER) next = UPPER[i];
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(tooth);
      return;
    }
    if (next !== undefined) {
      e.preventDefault();
      setFocus(next);
      document.querySelector<SVGGElement>(`[data-tooth="${next}"]`)?.focus();
    }
  };

  const sel = PLACED.find((p) => p.tooth === selected);

  return (
    <div className="arch-well" dir="ltr">
      <svg viewBox={`0 0 ${W} ${H}`} className="arch-svg" role="group" aria-label={t("chart.title")}>
        <text x={18} y={30} className="arch-caption">{t("chart.patientRight")}</text>
        <text x={W - 18} y={30} className="arch-caption" textAnchor="end">{t("chart.patientLeft")}</text>
        <text x={CX} y={H / 2 - 120} className="arch-jaw" textAnchor="middle">{t("chart.upper")}</text>
        <text x={CX} y={H / 2 + 132} className="arch-jaw" textAnchor="middle">{t("chart.lower")}</text>
        <line x1={CX} y1={44} x2={CX} y2={H - 44} className="arch-midline" />

        {sel && <circle cx={sel.x} cy={sel.y} r={30 * sel.scale} className="arch-halo" />}

        {PLACED.map((p) => {
          const rec = teeth[p.tooth];
          const plan = planned[p.tooth]?.length;
          const label = `${t("tooth.label", { n: p.tooth })}, ${toothName(p.tooth, t)}, ${toothStatus(rec, planned[p.tooth] ?? [], t)}`;
          const tag = rec?.implant ? "IMP" : rec?.root_canal_treated ? "RCT" : "";
          return (
            <g key={p.tooth}>
              <g
                data-tooth={p.tooth}
                role="button"
                tabIndex={p.tooth === (selected ?? focus) ? 0 : -1}
                aria-label={label}
                aria-pressed={selected === p.tooth}
                className={`arch-tooth ${selected === p.tooth ? "is-selected" : ""} ${plan ? "has-plan" : ""}`}
                transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${p.angle.toFixed(1)}) scale(${p.scale})`}
                onClick={() => {
                  setFocus(p.tooth);
                  onSelect(p.tooth);
                }}
                onKeyDown={(e) => onKey(e, p.tooth)}
              >
                <g className="arch-tooth-body" style={{ "--i": p.order } as CSSProperties}>
                  <title>{label}</title>
                  <ToothGlyph tooth={p.tooth} record={rec} sides={p.sides} />
                </g>
              </g>
              <text x={p.labelX} y={p.labelY} className={`arch-num ${selected === p.tooth ? "is-selected" : ""}`} textAnchor="middle" dominantBaseline="central">
                {p.tooth}
              </text>
              {tag && (
                <text x={p.labelX} y={p.labelY + (p.labelY < H / 2 ? -12 : 12)} className="arch-tag" textAnchor="middle" dominantBaseline="central">
                  {tag}
                </text>
              )}
              {plan ? <circle cx={p.labelX + 11} cy={p.labelY - 7} r={3.6} className="arch-plan-dot" /> : null}
            </g>
          );
        })}

        <g className="arch-centre" transform={`translate(${CX} ${H / 2 + 6})`}>
          {sel ? (
            <>
              <text y={-14} textAnchor="middle" className="arch-centre-num">{sel.tooth}</text>
              <text y={16} textAnchor="middle" className="arch-centre-sub">{toothName(sel.tooth, t)}</text>
            </>
          ) : (
            <>
              <text y={-10} textAnchor="middle" className="arch-centre-sub strong">{t("chart.tapTooth")}</text>
              <text y={14} textAnchor="middle" className="arch-centre-sub">
                {t("chart.counts", { caries: counts.caries, treated: counts.treated, planned: counts.planned })}
              </text>
            </>
          )}
        </g>
      </svg>
    </div>
  );
}

export function ChartLegend() {
  const { t } = useI18n();
  const swatch = (bg: string, border = "#7F95A8") => <span className="swatch" aria-hidden="true" style={{ background: bg, borderColor: border }} />;
  return (
    <div className="chart-legend">
      <span>{swatch(FILL.sound)}{t("surface.sound")}</span>
      <span>{swatch(FILL.caries)}{t("surface.caries")}</span>
      <span>{swatch(FILL.filling)}{t("surface.filling")}</span>
      <span>{swatch(CROWN, CROWN)}{t("tooth.crown")}</span>
      <span>{swatch(FILL.rct, FILL.rct)}{t("surface.rct")}</span>
      <span><span className="legend-tag" aria-hidden="true">IMP</span>{t("tooth.implant")}</span>
      <span><span className="swatch swatch-missing" aria-hidden="true" />{t("tooth.missing")}</span>
      <span><span className="legend-plan" aria-hidden="true" />{t("chart.planned")}</span>
    </div>
  );
}
