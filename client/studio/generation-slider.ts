function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Maps a pointer position to the nearest evenly spaced slider stop. */
export function sliderIndexAtLocation(
  locationX: number,
  width: number,
  optionCount: number,
): number {
  if (optionCount <= 1 || width <= 0) return 0;
  const inset = width / (optionCount * 2);
  const trackWidth = width - inset * 2;
  if (trackWidth <= 0) return 0;
  const ratio = clamp((locationX - inset) / trackWidth, 0, 1);
  return Math.round(ratio * (optionCount - 1));
}
