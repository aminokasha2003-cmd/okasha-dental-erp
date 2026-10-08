import { useState, type KeyboardEvent } from "react";
import { useI18n, type TKey } from "../i18n";
import type { Surface, SurfaceState, ToothRecord } from "../types";

// FDI chart from the patient card handoff: patient's right on the left of the
// screen, five-surface diagram per tooth, same left/right layout in Arabic.

export const UPPER = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28];
export const LOWER = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38];
export const ALL_TEETH = [...UPPER, ...LOWER];
export const SURFACES: Surface[] = ["M", "D", "O", "B", "L"];
export const SURFACE_STATES: SurfaceState[] = ["sound", "caries", "filling", "rct"];

export const FILL: Record<SurfaceState, string> = { sound: "#FFFFFF", caries: "#E08A1E", filling: "#A9C0D3", rct: "#16242F" };
const CROWN = "#446681";

// Drawing positions: top, right, bottom, left trapezoids and the centre square.
const SHAPES = {
  top: "2,2 38,2 27,13 13,13",
  right: "38,2 38,38 27,27 27,13",
  bottom: "38,38 2,38 13,27 27,27",
  left: "2,38 2,2 13,13 13,27",
} as const;
type Side = keyof typeof SHAPES;

/** Which surface each side of the drawing shows for a tooth. */
export function surfaceAt(tooth: number): Record<Side, Surface> {
  const quadrant = Math.floor(tooth / 10);
  const upper = quadrant === 1 || quadrant === 2;
  const mesialRight = quadrant === 1 || quadrant === 4;
  return {
    top: upper ? "B" : "L",
    bottom: upper ? "L" : "B",
    right: mesialRight ? "M" : "D",
    left: mesialRight ? "D" : "M",
  };
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
  const sides = surfaceAt(tooth);
  const missing = Boolean(record?.missing && !record.implant);
  const stroke = missing ? "#C3D0DB" : "#7F95A8";
  const fillFor = (surface: Surface) => {
    if (missing) return "transparent";
    if (record?.crown) return CROWN;
    const state = record?.surfaces?.[surface];
    if (state) return FILL[state];
    if (surface === "O" && record?.root_canal_treated) return FILL.rct;
    return FILL.sound;
  };
  const interactive = (surface: Surface) =>
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
    <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden={onSurface ? undefined : true} className="surface-svg">
      {(Object.keys(SHAPES) as Side[]).map((side) => (
        <polygon key={side} points={SHAPES[side]} fill={fillFor(sides[side])} stroke={stroke} strokeWidth={1.4} strokeLinejoin="round" {...interactive(sides[side])} />
      ))}
      <rect x="13" y="13" width="14" height="14" fill={fillFor("O")} stroke={stroke} strokeWidth={1.4} {...interactive("O")} />
      {missing && (
        <g stroke="#7F95A8" strokeWidth={2.2} strokeLinecap="round" pointerEvents="none">
          <line x1="7" y1="7" x2="33" y2="33" />
          <line x1="33" y1="7" x2="7" y2="33" />
        </g>
      )}
    </svg>
  );
}

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
  const [focus, setFocus] = useState<number>(selected ?? 18);

  // Arrow keys move along the arch, so the chart works without a mouse.
  const onKey = (e: KeyboardEvent, tooth: number) => {
    const row = UPPER.includes(tooth) ? UPPER : LOWER;
    const i = row.indexOf(tooth);
    let next: number | undefined;
    if (e.key === "ArrowRight") next = row[i + 1];
    if (e.key === "ArrowLeft") next = row[i - 1];
    if (e.key === "ArrowDown" && row === UPPER) next = LOWER[i];
    if (e.key === "ArrowUp" && row === LOWER) next = UPPER[i];
    if (next !== undefined) {
      e.preventDefault();
      setFocus(next);
      document.querySelector<HTMLButtonElement>(`[data-tooth="${next}"]`)?.focus();
    }
  };

  const button = (tooth: number, upper: boolean) => {
    const rec = teeth[tooth];
    const tag = rec?.implant ? "IMP" : rec?.root_canal_treated ? "RCT" : "";
    const label = `${t("tooth.label", { n: tooth })}, ${toothName(tooth, t)}, ${toothStatus(rec, planned[tooth] ?? [], t)}`;
    const parts = [
      <span key="tag" className="tooth-tag">{tag}</span>,
      <span key="n" className="tooth-num">{tooth}</span>,
      <SurfaceDiagram key="svg" tooth={tooth} record={rec} />,
    ];
    return (
      <button
        key={tooth}
        type="button"
        data-tooth={tooth}
        className={`tooth ${planned[tooth]?.length ? "has-plan" : ""}`}
        aria-label={label}
        aria-pressed={selected === tooth}
        tabIndex={tooth === (selected ?? focus) ? 0 : -1}
        onClick={() => {
          setFocus(tooth);
          onSelect(tooth);
        }}
        onKeyDown={(e) => onKey(e, tooth)}
      >
        {upper ? parts : parts.reverse()}
      </button>
    );
  };

  return (
    <div className="chart-well" dir="ltr">
      <div className="chart-inner">
        <div className="chart-caption">
          <span>{t("chart.patientRight")}</span>
          <span>{t("chart.upper")}</span>
          <span>{t("chart.patientLeft")}</span>
        </div>
        <div className="chart-row" role="group" aria-label={t("chart.upper")}>
          <div className="chart-half">{UPPER.slice(0, 8).map((n) => button(n, true))}</div>
          <div className="chart-mid" aria-hidden="true" />
          <div className="chart-half">{UPPER.slice(8).map((n) => button(n, true))}</div>
        </div>
        <div className="chart-divider" aria-hidden="true" />
        <div className="chart-row" role="group" aria-label={t("chart.lower")}>
          <div className="chart-half">{LOWER.slice(0, 8).map((n) => button(n, false))}</div>
          <div className="chart-mid" aria-hidden="true" />
          <div className="chart-half">{LOWER.slice(8).map((n) => button(n, false))}</div>
        </div>
        <div className="chart-caption center">
          <span>{t("chart.lower")}</span>
        </div>
      </div>
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
      <span>
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
          <g stroke="#7F95A8" strokeWidth="2" strokeLinecap="round"><line x1="2" y1="2" x2="12" y2="12" /><line x1="12" y1="2" x2="2" y2="12" /></g>
        </svg>
        {t("tooth.missing")}
      </span>
      <span><span className="legend-plan" aria-hidden="true" />{t("chart.planned")}</span>
    </div>
  );
}
