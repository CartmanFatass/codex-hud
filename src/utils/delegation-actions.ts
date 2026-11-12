/** Process the displayed input before invalidating its collection epoch. */
export function withInputRefresh<T>(hasInput: boolean, processInput: () => T, refresh: () => void): T {
  try {
    return processInput();
  } finally {
    if (hasInput) refresh();
  }
}
