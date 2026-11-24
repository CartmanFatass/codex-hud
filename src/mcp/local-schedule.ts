import { readObjectives } from '../collectors/objectives.js';
import {
  DAY_MS, SCHEDULE_BYTES, SCHEDULE_ID, SCHEDULE_MAX_OPEN, SCHEDULE_TEXT_MAX, readSchedule, scheduleDate, schedulePath, scheduleText,
  scheduleTiming, type ScheduleItem,
} from '../collectors/schedule.js';
import { projectList, registeredProject } from '../roles/projects.js';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { writePrivateFile } from '../utils/atomic-fs.js';

const fields = {
  add: ['date', 'text', 'project', 'objective'],
  done: ['id', 'note'],
  move: ['id', 'date'],
  list: ['due'],
};
const itemId = new RegExp(SCHEDULE_ID);
const invalid = (field: string): never => { throw new Error(`invalid_arguments: ${field}`); };

function links(home: string, project: unknown, objective: unknown) {
  if (project === undefined) {
    if (objective !== undefined) invalid('objective requires a project');
    return {};
  }
  if (typeof project !== 'string' || !project.trim() || project.includes('\0')) return invalid('project');
  const { root, registered } = registeredProject(home, project);
  if (!registered) return invalid('project is not registered');
  if (objective === undefined) return { project: root };
  if (typeof objective !== 'string' || !readObjectives(root)?.objectives.some(({ id }) => id === objective))
    return invalid('unknown Objective');
  return { project: root, objective };
}

function views(home: string, items: ScheduleItem[], nowMs: number) {
  const roots = items.some(({ project }) => project) ? new Set(projectList(home, process.cwd()).map(({ root }) => root)) : undefined;
  return items.map(({ project, objective, ...item }) => ({
    ...item, ...(project && roots?.has(project) ? { project, ...(objective && { objective }) } : {}),
    ...scheduleTiming(item.date, nowMs),
  }));
}

export function callSchedule(home: string, args: Record<string, unknown>) {
  const { op, date, text, id, note, due } = args;
  if (op !== 'add' && op !== 'done' && op !== 'move' && op !== 'list') return invalid('op');
  if (Object.keys(args).some((key) => key !== 'op' && !fields[op].includes(key))) return invalid(`${op} fields`);
  if (op === 'list') {
    if (due !== undefined && typeof due !== 'boolean') return invalid('due');
    const { items } = readSchedule(home);
    const open = views(home, items.filter(({ done_at }) => !done_at), Date.now());
    return { items: open.filter((item) => due !== true || item.due).sort((a, b) => a.days_until_due - b.days_until_due) };
  }
  if ((op === 'add' || op === 'move') && !scheduleDate(date)) return invalid('date (YYYY-MM-DD or YYYY-MM)');
  if (op === 'add' && !scheduleText(text)) return invalid(`text (one line, at most ${SCHEDULE_TEXT_MAX} characters)`);
  if (op !== 'add' && (typeof id !== 'string' || !itemId.test(id))) return invalid('id');
  if (note !== undefined && typeof note !== 'string') return invalid('note');

  return withAbstractLock('schedule', home, () => {
    const nowMs = Date.now(), at = new Date(nowMs).toISOString(), state = readSchedule(home);
    state.items = state.items.filter(({ done_at }) => !done_at || nowMs - Date.parse(done_at) < 30 * DAY_MS);
    let open = state.items.filter(({ done_at }) => !done_at).length;
    let item: ScheduleItem;
    if (op === 'add') {
      if (open >= SCHEDULE_MAX_OPEN) throw new Error(`Schedule already has ${SCHEDULE_MAX_OPEN} open items; mark one done before adding another`);
      if (state.seq === Number.MAX_SAFE_INTEGER) throw new Error('Schedule sequence exhausted');
      item = { id: `s${++state.seq}`, date: date as string, text: text as string, ...links(home, args.project, args.objective), created_at: at };
      state.items.push(item);
      open++;
    } else {
      const found = state.items.find((row) => row.id === id && !row.done_at);
      if (!found) return invalid('unknown open schedule item');
      item = found;
      if (op === 'move') item.date = date as string;
      else item.done_at = at;
    }

    const json = JSON.stringify(state) + '\n';
    // Leave enough space to mark open items done without evicting recent completions.
    const reserved = op === 'done' ? 0 : open * `,"done_at":"${at}"`.length;
    if (Buffer.byteLength(json) + reserved > SCHEDULE_BYTES) throw new Error('Schedule exceeds its 64 KiB storage limit');
    const result = op === 'done' ? { id: item.id, done_at: at } : op === 'add'
      ? { item: { ...item, ...scheduleTiming(item.date, nowMs) } } : { item: views(home, [item], nowMs)[0] };
    writePrivateFile(schedulePath(home), json);
    return result;
  });
}
