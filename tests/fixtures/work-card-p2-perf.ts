import { initialMonitorState, type MonitorState } from '../../src/render/monitor.js';

const work = (patch: Partial<MonitorState> = {}): MonitorState => ({
  ...initialMonitorState(),
  mainTab: 'work',
  ...patch,
});
export { work };
