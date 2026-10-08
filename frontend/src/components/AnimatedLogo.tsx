// The Okasha tooth logo drawn in SVG so its lines can move.
// "intro": the outline draws itself, the red dot appears, then the lines keep cycling (sign-in).
// "loop": the lines cycle continuously (sidebar).
// People who ask their system for reduced motion get the still logo.

const LEFT =
  "M9.89 31.36A6.74 6.74 0 0 1 16.09 22.00L41.45 22.00A2.01 2.01 0 0 1 42.58 22.34L72.53 42.54A6.96 6.96 0 0 1 74.62 51.87L48.95 94.99A7.06 7.06 0 0 1 36.39 94.13Z";
const RIGHT =
  "M83.61 94.13A7.06 7.06 0 0 1 71.05 94.99L45.38 51.87A6.96 6.96 0 0 1 47.47 42.54L77.42 22.34A2.01 2.01 0 0 1 78.55 22.00L103.91 22.00A6.74 6.74 0 0 1 110.11 31.36Z";

export function AnimatedLogo({
  tone = "light",
  mode = "loop",
  size = 44,
  label,
}: {
  tone?: "light" | "dark";
  mode?: "intro" | "loop";
  size?: number;
  label?: string;
}) {
  const stroke = tone === "dark" ? "#ffffff" : "#446681";
  return (
    <svg
      className={`ok-logo ok-logo-${mode} ok-logo-${tone}`}
      viewBox="0 0 120 112"
      width={size}
      height={(size * 112) / 120}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <g fill="none" stroke={stroke} strokeWidth="4" strokeLinejoin="round" strokeLinecap="round">
        <path className="ok-logo-base" d={LEFT} pathLength={100} />
        <path className="ok-logo-base" d={RIGHT} pathLength={100} />
        <path className="ok-logo-run ok-logo-run-a" d={LEFT} pathLength={100} />
        <path className="ok-logo-run ok-logo-run-b" d={RIGHT} pathLength={100} />
      </g>
      <circle className="ok-logo-dot" cx="39.10" cy="6.24" r="2.86" fill="#E61B1B" />
    </svg>
  );
}
