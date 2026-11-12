/** Bar-only preferences: no panel defaults or credential discovery on this path. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { getHudHome } from './hud-home.js';
import { resolveHudEnv } from './utils/hud-env.js';
import { BAR_FIELDS, resolveDisplayConfig, setDisplayConfig } from './render/hud-config.js';
export function applyBarSettings(): void {
  let fd: number | undefined;
  try {
    const file = resolveHudEnv(process.env, 'HUD_SETTINGS_PATH') || join(getHudHome(), 'hud-settings.json');
    let { barStyle, barFields } = resolveDisplayConfig();
    if (fs.existsSync(file)) {
      let raw;
      try {
        fd = fs.openSync(file, 'r');
        const buffer = Buffer.alloc(65537);
        let size = 0, n = 0;
        while (size < buffer.length && (n = fs.readSync(fd, buffer, size, buffer.length - size, null))) size += n;
        if (size > 65536) throw new Error('settings_too_large');
        raw = JSON.parse(buffer.subarray(0, size).toString('utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const values = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      barStyle = values.barStyle === 'p10k' ? 'p10k' : 'line';
      barFields = Array.isArray(values.barFields) && values.barFields.every((f: unknown) => BAR_FIELDS.includes(f as never))
        ? values.barFields : [...BAR_FIELDS];
    }
    setDisplayConfig({ barStyle, barFields });
  } catch {
    /* An unreadable settings file leaves the bar as it was. */
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
