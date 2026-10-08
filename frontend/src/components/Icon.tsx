const PATHS = {
  home: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  patients: "M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M17.5 11.5a2.5 2.5 0 1 0 0-5M17 14.5c2.3.2 3.9 1.8 4.5 4.5",
  calendar: "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 10h18M8 3v4M16 3v4",
  tooth:
    "M8 3c-2 0-3.5 1.6-3.5 3.8 0 2.5 1.2 3.8 1.7 6.3.4 2.5.8 5.9 2 5.9s1.5-2.6 2-4.6c.3-.9.8-1.4 1.8-1.4s1.5.5 1.8 1.4c.5 2 .8 4.6 2 4.6s1.6-3.4 2-5.9c.5-2.5 1.7-3.8 1.7-6.3C19.5 4.6 18 3 16 3c-1.7 0-2.5.8-4 .8S9.7 3 8 3z",
  receipt: "M6 2h12v20l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6M9 15h4",
  flask: "M9 3h6M10 3v6l-5.5 9.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3M7.5 15h9",
  building: "M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M2 21h20M8 7h4M8 11h4M8 15h4",
  key: "M15 7a4 4 0 1 1-3.9 5H8v3H5v3H2v-3.5l6.6-6.6A4 4 0 0 1 15 7zM16 8h.01",
  badge: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1-4 4-6 8-6s7 2 8 6",
  list: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2",
  box: "M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  check: "M5 12l5 5 9-10",
  circle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
