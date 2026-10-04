/**
 * The Jev diamond. One glyph, used everywhere Jev is referenced: the
 * machine callout, the "jev is deciding" header, the chosen-action row and
 * the legend.
 */
export interface JevMarkProps {
  size?: number;
  color?: string;
  className?: string;
  title?: string;
}

/** The raw path, in a 16×16 box, for callers that draw inside an SVG. */
export const JEV_PATH = 'M8 1 L14 8 L8 15 L2 8 Z';

export function JevMark({ size = 12, color = '#34d399', className, title }: JevMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{ flexShrink: 0 }}
    >
      <path d={JEV_PATH} fill={color} />
    </svg>
  );
}
