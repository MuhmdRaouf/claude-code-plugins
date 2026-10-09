/**
 * Line icons drawn on Lucide's 24-unit grid from the shape data in icons.ts; the logo is the colour mark from
 * logo.ts. Decorative by default (aria-hidden); a `label` makes the icon an announced image.
 */

import { ICONS, type IconName, type Shape } from "../icons.ts";
import { LOGO_SVG, svgDataUri } from "../logo.ts";

function ShapeEl({ shape }: { shape: Shape }) {
  if ("d" in shape) return <path d={shape.d} />;
  if ("circle" in shape) {
    const [cx, cy, r] = shape.circle;
    return <circle cx={cx} cy={cy} r={r} />;
  }
  if ("rect" in shape) {
    const [x, y, width, height, rx] = shape.rect;
    return <rect x={x} y={y} width={width} height={height} rx={rx} />;
  }
  if ("line" in shape) {
    const [x1, y1, x2, y2] = shape.line;
    return <line x1={x1} y1={y1} x2={x2} y2={y2} />;
  }
  return <polyline points={shape.points} />;
}

export function Icon({
  name,
  class: cls = "icon",
  label,
}: {
  name: IconName;
  class?: string;
  label?: string;
}) {
  if (name === "logo") {
    return (
      <img class={cls} src={svgDataUri(LOGO_SVG)} alt={label ?? ""} data-icon="logo" draggable={false} />
    );
  }
  return (
    <svg
      class={cls}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      data-icon={name}
      aria-hidden={label === undefined ? "true" : undefined}
      role={label === undefined ? undefined : "img"}
      aria-label={label}
    >
      {ICONS[name].map((shape, i) => (
        <ShapeEl key={i} shape={shape} />
      ))}
    </svg>
  );
}
