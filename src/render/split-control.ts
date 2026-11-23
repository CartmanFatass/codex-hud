/** Split-only adapter for Control's role rows and editor sheets. */
import type { ProjectSnapshot } from '../collectors/project-board.js';
import type { MonitorState } from './monitor.js';
import { controlRoleItem } from './monitor-state.js';
import { controlHints, controlList, roleDetail } from './control-page.js';
import { presetTag, roleName } from './control-view.js';
import { projectSplitScene, type Shown } from './split-project.js';
import { splitPreviewRoom } from './split-frame.js';
import { presetSheet } from './preset-input.js';
import { chainSheet } from './chain-input.js';

export function controlScene(data: ProjectSnapshot, state: MonitorState, listWidth: number, now: number, previewWidth: number, height: number, notes: number) {
  const view = state.control.roles, list = controlList(data, view, listWidth, now, false);
  const preview = (item?: string): Shown => {
    const role = data.roles.find((r) => controlRoleItem(r.role) === item);
    const hints = controlHints(data, item);
    return role ? { label: roleName(role), right: presetTag(role.preset), rows: roleDetail(data, role, previewWidth, now), hints }
      : { label: '', rows: [], hints };
  };
  const hints = controlHints(data), overlay = state.overlay;
  const preset = overlay?.kind === 'control-preset' ? overlay.sheet : undefined;
  const scene = projectSplitScene(view.nav, { list, preview, hints, start: list.find((r) => r.item)?.item },
    `control|${state.selectedProject ?? ''}|${preset?.mode ?? ''}`);
  if (overlay?.kind === 'control-chain' || overlay?.kind === 'control-preset') {
    const room = splitPreviewRoom({ ...scene, compact: true }, state.prefs.splitRatio, scene.nav.split.focus, height, notes);
    const sheet = overlay.kind === 'control-chain' ? chainSheet(overlay, data.models, previewWidth, room, now)
      : presetSheet(overlay.sheet, previewWidth, room);
    return { ...scene, rule: sheet.rule, preview: sheet.rows, sub: sheet.cursor, hints: sheet.hints, compact: true };
  }
  return scene;
}
