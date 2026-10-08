# Okasha Dental ERP — Patient Card handoff

Implement the patient card screen in the ERP from this package. Open `patient-card-reference.html` in a browser first: it is the approved design as plain HTML with inline styles, and it is the source of truth for spacing, sizes and colours. Rebuild it with the project's own stack and components; do not paste the inline styles in. All patient data, prices and IDs in the reference are sample values and must come from the database.

## Files

| File | Use |
|---|---|
| `patient-card-reference.html` | Design reference. Fluid from 390 px to 1440 px. Tooth selection works. |
| `assets/okasha-logo.svg` | Logo with red dot, for light surfaces. |
| `assets/okasha-logo-white.svg` | Logo with red dot, for dark surfaces. |
| `assets/okasha-mark.svg` | Mark without the dot. Used for the large watermark. |
| `assets/okasha-pattern-light.svg` | 168 × 148 repeating tile for the light background. |
| `assets/okasha-pattern-dark.svg` | Same tile for a dark background (`#16242F`). |
| `assets/okasha-logo-2400.png` | Transparent PNG for places that cannot take SVG. |

## Design tokens

```css
:root {
  /* colour */
  --ok-ground: #F3F6F9;      /* page */
  --ok-surface: #FFFFFF;     /* cards */
  --ok-surface-2: #F7F9FB;   /* insets: chart well, note */
  --ok-line: #DCE4EB;        /* card borders */
  --ok-line-soft: #E6EDF3;   /* row dividers */
  --ok-line-strong: #C3D0DB; /* control borders, table head rule */
  --ok-ink: #16242F;         /* text */
  --ok-ink-2: #3A4B5A;       /* secondary text */
  --ok-muted: #5A6B7B;       /* labels, captions (4.5:1 on white) */
  --ok-brand: #446681;       /* logo slate: primary buttons, selection, done */
  --ok-brand-deep: #2F4A61;  /* links, text on tint, appointment card */
  --ok-brand-tint: #E6EDF3;  /* selected, done chip, ID chip */
  --ok-alert: #E61B1B;       /* logo red: alert dots only */
  --ok-alert-text: #B91414;
  --ok-alert-tint: #FDECEC;
  --ok-alert-line: #F3B4B4;
  --ok-amber: #E08A1E;       /* caries, in progress */
  --ok-amber-text: #8A4F00;
  --ok-amber-tint: #FCF1E0;
  /* type */
  --ok-font-display: 'Outfit', system-ui, sans-serif;              /* 600 */
  --ok-font-body: 'IBM Plex Sans', 'IBM Plex Sans Arabic', system-ui, sans-serif;
  --ok-font-mono: 'IBM Plex Mono', ui-monospace, monospace;         /* IDs, tooth numbers, dates in timeline */
  /* shape */
  --ok-radius-card: 16px;
  --ok-radius-inset: 12px;
  --ok-radius-control: 10px;
  --ok-shadow-card: 0 1px 2px rgba(22,36,47,0.05);
  --ok-control-h: 44px;
}
```

Type scale: patient name 32/600 display; section title 20/600 (18 in the side column); stat figure 19/600 and billing figure 24/600 display; body 14; secondary 13; caption 12; overline label 11, uppercase, letter-spacing 0.12em, colour muted.

Colour rules: red is reserved for medical alerts and always appears as the logo dot plus text, never as a button colour. "Done" is slate, "In progress" is amber, "Planned" is an outlined neutral chip. There is no green; state is never shown by colour alone.

## Background

```css
.ok-page { position: relative; background-color: var(--ok-ground); overflow: hidden; }
.ok-page::before { /* logo pattern */
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background: url(assets/okasha-pattern-light.svg) 0 0 / 168px 148px repeat;
}
.ok-page__watermark { /* <img src="assets/okasha-mark.svg" alt=""> */
  position: absolute; top: 40px; right: -150px; width: 760px; opacity: 0.07; pointer-events: none;
}
```

The pattern only shows in page gutters; cards stay solid white so text never sits on it. Dark variant: ground `#16242F`, `okasha-pattern-dark.svg`, watermark at opacity 0.35. Use the same background on the login screen and empty states.

## Layout

- Top bar: logo, breadcrumb, patient search, signed-in user. Replace with the ERP's existing shell if it has one.
- Container: max-width 1376 px, 32 px side padding, 20 px gap between cards.
- Summary card, then section navigation (anchor links to each section), then two columns: main `flex: 999 1 640px`, side `flex: 1 1 340px`. Columns stack below about 1050 px. Tables and the dental chart scroll horizontally inside their own box on phones.

## Sections and fields

1. **Summary**: initials avatar, name (English and Arabic), file number, gender, age, phone, patient-since date, alert chips, actions (New visit, Book appointment, Add payment, Print). Four stats: last visit, next appointment, plan progress (one segment per procedure), balance due.
2. **Dental chart**: see below.
3. **Treatment plan**: tooth, procedure, status (`done | in_progress | planned`), date, fee. Footer totals: done and in progress, planned, plan total.
4. **Visit history**: newest first; date, title, clinical note, dentist.
5. **Billing and payments**: billed to date, paid, balance due, paid/billed bar; payments with date, receipt number, what it was for, method (`cash | instapay | card`), amount in EGP.
6. **Medical history**: alerts (allergies, conditions) each with a guidance line; medications, blood pressure, bleeding disorders, pregnancy, smoking, anaesthesia reactions; last-reviewed date.
7. **Next appointment**: date, time, duration, reason, dentist; WhatsApp reminder and reschedule.
8. **Lab orders** (in-house lab): order number, restoration, tooth, shade, due date, and the stage list: scan received, CAD design, milling, sintering and glaze, ready for try-in. Stages are done, current or pending.
9. **Personal details**: date of birth, phone, WhatsApp, address, occupation, referral source, emergency contact, insurance.
10. **Files and X-rays**: type, title, date, thumbnail (X-ray, STL scan, PDF).
11. **Notes**: staff-only notes with author and date, plus an add-note field.

## Dental chart

- FDI numbering, permanent teeth. Upper row `18…11 | 21…28`, lower row `48…41 | 31…38`. The patient's right is on the left of the screen.
- Each tooth is a 44 px-wide button containing a five-surface diagram (40 × 40 viewBox: four trapezoids and a centre square), the tooth number, and an optional tag (`RCT`, `IMP`).
- Surface codes: `M` mesial, `D` distal, `O` occlusal/incisal (centre), `B` buccal, `L` lingual/palatal. Mapping to the drawing: upper teeth buccal = top, lower teeth buccal = bottom; mesial faces the midline (right side of the drawing in quadrants 1 and 4, left side in 2 and 3).
- Surface state fills: sound `#FFFFFF`, caries `#E08A1E`, filling `#A9C0D3`, root-canal access `#16242F`. Whole-tooth states: crown fills all five surfaces `#446681`; missing draws no fill and a cross; implant shows the `IMP` tag (with crown fill if restored).
- Selecting a tooth sets `aria-pressed`, gives the button a 2 px slate border on slate tint, and fills the record panel under the chart (tooth name, status, latest note, Add procedure, Edit surfaces).

Suggested shape:

```ts
type Surface = 'M' | 'D' | 'O' | 'B' | 'L';
type SurfaceState = 'sound' | 'caries' | 'filling' | 'rct';
interface ToothRecord {
  fdi: number;                       // 11–48
  missing?: boolean;
  crown?: boolean;
  implant?: boolean;
  rootCanalTreated?: boolean;
  surfaces?: Partial<Record<Surface, SurfaceState>>;
  statusLabel: string;
  note?: string;
}
```

## Accessibility and language

- Controls are real `button`, `a`, `input`, `textarea` elements with labels; minimum target 44 px; visible focus ring `3px solid #7FA3C2`.
- Each tooth button has an `aria-label` of the form "Tooth 26, Upper left first molar, Root canal treated".
- Use logical CSS properties so an Arabic (RTL) layout can be added. The dental chart keeps its left/right orientation in RTL.
