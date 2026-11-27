/** A request for none (0, from older settings) uses DEFAULT_WIDTH. */
export const DEFAULT_WIDTH = 56;
/** Default bottom-dock height in rows (matches the herdr fork default). */
export const DEFAULT_HEIGHT = 12;
/** Home's width presets; other saved widths still draw. */
export const PANEL_WIDTHS: readonly number[] = [40, 48, 56, 64, 80, 100];
/** Bottom-dock height presets; other saved heights still draw. */
export const PANEL_HEIGHTS: readonly number[] = [6, 8, 10, 12, 16, 20, 24];

export function clampDockWidth(columns: number): number {
  return Math.max(16, Math.min(200, Math.round(columns)));
}

export function clampDockHeight(rows: number): number {
  return Math.max(2, Math.min(100, Math.round(rows)));
}

/** Size a panel while reserving room for the main pane. Herdr sizes its dock on the server. */
export function panelWidth(requested: number, windowWidth: number): number {
  const desired = requested > 0 ? requested : DEFAULT_WIDTH;
  const max = windowWidth - 41 >= 10 ? windowWidth - 41 : Math.floor(windowWidth / 3);
  return Math.max(1, Math.min(max, Math.max(16, desired)));
}
