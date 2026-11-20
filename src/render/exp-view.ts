/** Shared EXP form for Classic and Split. Data comes from the panel; input returns edits, never writes. */
import { basename } from 'node:path';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import {
  EXP_ACCOUNTS,
  expAlias,
  expApproxUsd,
  expInteger,
  expTimeZone,
  expUsd,
  parseExpUsd,
  type ExpAccount,
  type ExpBalance,
  type ExpData,
  type ExpEdit,
} from '../exp-config.js';
import {
  proxyDueAt,
  proxyStale,
  windowLabel,
  windowPending,
  windowRemaining,
  type ExpProxyError,
  type ExpProxyWindow,
} from '../exp-proxy.js';
import type { MonitorContext, MonitorOutcome, MonitorRow, MonitorState } from './monitor.js';
import { monitorRowAt } from './monitor-input.js';
import { theme, visualLength } from './colors.js';
import { flowLines, monitorText, pair } from './monitor-text.js';
import { boardRow, section } from './workboard-rows.js';
import { t } from './i18n.js';

type Detail = ExpAccount | 'codex-help' | 'proxy-status';
interface Choice {
  label: string;
  change: ExpEdit;
}
type Editor = { choices: Choice[]; initial: number } | { hint: string; parse: (value: string) => ExpEdit | undefined };
interface Entry {
  id: string;
  label: string;
  value?: string;
  reading?: [string, string];
  edit?: Editor;
  detail?: Detail;
}
interface Draft {
  text: string;
  pick: number;
  preview?: Extract<ExpEdit, { field: 'grant' | 'renewal' | 'calibration' }>;
}
export interface ExpPage {
  detail?: Detail;
  cursor?: string;
  scroll?: number;
  edit?: Draft;
  notice?: 'Saved' | 'Could not save EXP setting' | 'Invalid value';
}

const enabled = (on: boolean) => t(on ? 'on' : 'off');
const offline = () => t('not connected');
const remaining = (balance: ExpBalance | undefined) =>
  !balance
    ? t('unavailable')
    : balance.remainingMicros === null
      ? t('uncalibrated')
      : expApproxUsd(Math.max(0, balance.remainingMicros));
function accountReadings(balance: ExpBalance | undefined): [string, string][] {
  const unknown = t('unavailable');
  const calibration = balance?.lastCalibration;
  return [
    ['Estimated remaining', remaining(balance)],
    ['Current period', balance ? `${balance.startDate} → ${balance.endDate} · ${balance.timeZone}` : unknown],
    ['Billed this period', balance ? `$${expUsd(balance.billedMicros)}` : unknown],
    ['Unpriced requests', balance ? String(balance.unpriced) : unknown],
    [
      'Recent calibration',
      balance
        ? calibration
          ? `${calibration.at.slice(0, 16).replace('T', ' ')} UTC · $${expUsd(calibration.remainingMicros)}`
          : t('none')
        : unknown,
    ],
    ...(balance?.remainingMicros != null && balance.remainingMicros < 0
      ? [['Estimated overage', `$${expUsd(-balance.remainingMicros)}`] as [string, string]]
      : []),
  ];
}
const toggle = (id: string, label: string, on: boolean, change: (value: boolean) => ExpEdit): Entry => ({
  id,
  label,
  value: enabled(on),
  edit: {
    choices: [false, true].map((value) => ({ label: enabled(value), change: change(value) })),
    initial: Number(on),
  },
});
const input = (
  id: string,
  label: string,
  value: string,
  hint: string,
  parse: (value: string) => ExpEdit | undefined
): Entry => ({ id, label, value, edit: { hint, parse } });
const link = (detail: Detail, label: string, value?: string): Entry => ({ id: detail, label, value, detail });
const parseInteger = (s: string, min: number, max: number) =>
  /^\d+$/.test(s) && expInteger(Number(s), min, max) ? Number(s) : undefined;
const profileLabel = (data: ExpData, home: string) => {
  const name = monitorText(data.profiles.find((p) => p.home === home)?.name ?? basename(home));
  const alias = data.config.codex.aliases[home];
  return alias ? `${monitorText(alias)} (${name})` : name;
};

const PROXY_ERROR_LABEL: Record<ExpProxyError, string> = {
  not_logged_in: 'Codex sign-in required',
  binding_changed: 'Codex account changed',
  rate_limited: 'Rate limited',
  timeout: 'Timed out',
  unavailable: 'Codex unavailable',
  invalid_response: 'Invalid quota response',
  request_failed: 'Quota request failed',
};
const time = (at?: number | null) =>
  at == null ? '—' : new Date(at).toISOString().slice(0, 16).replace('T', ' ') + 'Z';

function proxyReadings(data: ExpData, nowMs: number): [string, string][] {
  const { proxy } = data.config;
  const snapshot = data.proxySnapshot;
  const stale = snapshot && proxyStale(snapshot.observedAtMs, proxy.intervalMinutes, nowMs);
  const window = (w?: ExpProxyWindow) => {
    if (!w) return '—';
    const label = windowLabel(w);
    const value = windowPending(w, nowMs) ? t('refresh pending') : `≈${windowRemaining(w)}%`;
    return [label, value].filter(Boolean).join(' ');
  };
  const next = proxyDueAt(snapshot, proxy.intervalMinutes);
  return [
    [t('Codex profile'), proxy.profile ? profileLabel(data, proxy.profile) : t('Unbound')],
    [t('Primary window'), window(snapshot?.primary)],
    [t('Primary reset'), time(snapshot?.primary?.resetsAt == null ? null : snapshot.primary.resetsAt * 1000)],
    [t('Secondary window'), window(snapshot?.secondary)],
    [t('Secondary reset'), time(snapshot?.secondary?.resetsAt == null ? null : snapshot.secondary.resetsAt * 1000)],
    [
      t('Source'),
      snapshot?.observedAtMs != null ? `${t('Codex proxy')}${stale ? ` · ${t('Stale reading')}` : ''}` : '—',
    ],
    [t('Last success'), time(snapshot?.observedAtMs)],
    [t('Last error'), snapshot?.error ? t(PROXY_ERROR_LABEL[snapshot.error]) : '—'],
    [
      t('Next attempt'),
      !proxy.enabled || !proxy.profile
        ? '—'
        : next === null
          ? t('Paused')
          : next <= nowMs
            ? t('On next pi draw')
            : time(next),
    ],
  ];
}

function groups(
  data: ExpData,
  detail: Detail | undefined
): { label: string; entries?: Entry[]; readings?: (string | [string, string])[]; notes?: string[] }[] {
  const { config, profiles } = data;
  if (detail === 'codex-help')
    return [
      {
        label: 'Codex setup / restore',
        notes: [
          'In ordinary Codex, open /experimental and enable custom status lines, then restart.',
          'Open /statusline. Choose MyHUD once it is available.',
          'To restore, select the previous status line in /statusline or use codexH. The tmux bar stays unchanged.',
          'Tracking records observations only; /statusline controls what Codex displays.',
        ],
      },
    ];
  if (detail === 'proxy-status')
    return [
      {
        label: 'Proxy readings',
        notes:
          data.proxySnapshot?.error === 'not_logged_in'
            ? ['Sign in to the bound profile, then turn Auto-refresh off and on.']
            : data.proxySnapshot?.error === 'binding_changed'
              ? ['Verify and reselect the Codex profile to resume.']
              : [],
      },
    ];
  if (detail) {
    const grant = config.grants[detail];
    return [
      {
        label: detail,
        entries: [
          toggle('grant-enabled', t('Enabled'), grant.enabled, (value) => ({
            field: 'grant-enabled',
            account: detail,
            value,
          })),
          input('grant', t('Grant per period'), `$${expUsd(grant.grantMicros)}`, 'Enter a USD amount', (s) => {
            const value = parseExpUsd(s);
            return value === undefined ? undefined : { field: 'grant', account: detail, value };
          }),
          input('renewal', t('Renewal day'), String(grant.renewalDay), 'Enter a day from 1 to 31', (s) => {
            const value = parseInteger(s, 1, 31);
            return value === undefined ? undefined : { field: 'renewal', account: detail, value };
          }),
          input('zone', t('Time zone'), grant.timeZone, 'Enter a time zone, e.g. Asia/Shanghai', (value) =>
            expTimeZone(value) ? { field: 'zone', account: detail, value } : undefined
          ),
          input('calibration', t('Calibrate remaining now'), '', 'Enter a USD amount', (s) => {
            const value = parseExpUsd(s);
            return value === undefined ? undefined : { field: 'calibration', account: detail, value };
          }),
        ],
        readings: accountReadings(data.balances?.[detail]),
        notes: [
          detail === 'openai-api'
            ? 'Only oapi requests observed by the installed pi HUD are counted.'
            : 'Only direct Anthropic API-key requests observed by the installed pi HUD are counted.',
        ],
      },
    ];
  }
  const choices: Choice[] = [
    { label: t('Unbound'), change: { field: 'binding', value: null } },
    ...profiles.map(({ home }): Choice => ({
      label: profileLabel(data, home),
      change: { field: 'binding', value: home },
    })),
  ];
  const binding = config.proxy.profile;
  return [
    {
      label: 'Codex native status line',
      entries: [
        toggle('codex-enabled', t('Track native status line'), config.codex.enabled, (value) => ({
          field: 'codex-enabled',
          value,
        })),
        ...profiles.map(({ home, lastNativeSeenAt }): Entry => ({
          ...input(
            `alias:${home}`,
            profileLabel(data, home),
            '',
            'Enter an alias; empty restores the directory name',
            (value) => (expAlias(value) ? { field: 'alias', profile: home, value } : undefined)
          ),
          reading: ['Last native bar seen', time(lastNativeSeenAt)],
        })),
        link('codex-help', t('Codex setup / restore')),
      ],
      readings: profiles.length ? [] : ['Local Codex profiles'],
    },
    {
      label: 'pi subscription proxy',
      entries: [
        {
          id: 'binding',
          label: t('Codex profile'),
          value: binding ? profileLabel(data, binding) : t('Unbound'),
          edit: { choices, initial: Math.max(0, profiles.findIndex((p) => p.home === binding) + 1) },
        },
        toggle('proxy-enabled', t('Auto-refresh'), config.proxy.enabled, (value) => ({
          field: 'proxy-enabled',
          value,
        })),
        input(
          'interval',
          t('Interval'),
          t('{n} min', { n: config.proxy.intervalMinutes }),
          'Enter a number from 5 to 60',
          (s) => {
            const value = parseInteger(s, 5, 60);
            return value === undefined ? undefined : { field: 'interval', value };
          }
        ),
        link(
          'proxy-status',
          t('Proxy readings'),
          !binding || !config.proxy.enabled
            ? t('off')
            : data.proxySnapshot?.error
              ? t(PROXY_ERROR_LABEL[data.proxySnapshot.error])
              : data.proxySnapshot
                ? t('Codex proxy')
                : t('On next pi draw')
        ),
      ],
    },
    {
      label: 'API grants',
      entries: EXP_ACCOUNTS.map((account) =>
        link(
          account,
          account,
          `${enabled(config.grants[account].enabled)} · ${remaining(data.balances?.[account])}`
        )
      ),
    },
  ];
}

export function expRows(page: ExpPage, data: ExpData | undefined, width: number, nowMs: number): MonitorRow[] {
  const text = (s: string, ink = theme.board.text) => flowLines(s, width).map((line) => boardRow(ink(line)));
  if (!data) return [];
  const sections = groups(data, page.detail);
  const labeled = (label: string, value = '') =>
    value && visualLength(label) + visualLength(value) + 2 <= width
      ? [boardRow(pair(label, theme.board.muted(value), width))]
      : [...text(label), ...text(value, theme.board.muted)];
  const entry = sections.flatMap((g) => g.entries ?? []).find((e) => e.id === page.cursor);
  if (page.edit && entry?.edit) {
    const { edit } = page;
    const rows = text(entry.label, theme.board.title);
    if (edit.preview) {
      return [
        ...rows,
        boardRow(''),
        ...text(t('Old estimate → new base')),
        ...text(
          `${remaining(data.balances?.[edit.preview.account])} → $${expUsd(edit.preview.value)}`,
          theme.board.active
        ),
        ...text(t('This does not change the next grant.'), theme.board.muted),
      ];
    }
    if ('choices' in entry.edit) {
      const { choices } = entry.edit;
      return [
        ...rows,
        boardRow(''),
        ...text(`${edit.pick + 1}/${choices.length}`, theme.board.muted),
        ...text(choices[edit.pick]?.label ?? '', theme.board.active),
      ];
    }
    const account = page.detail === 'openai-api' || page.detail === 'anthropic-api' ? page.detail : undefined;
    const grant = account && data.config.grants[account];
    const endDate = account && data.balances?.[account]?.endDate;
    return [
      ...rows,
      boardRow(''),
      ...text(t(entry.edit.hint), theme.board.muted),
      ...(endDate && grant && (grant.schedule || grant.enabled) && ['grant', 'renewal', 'zone'].includes(entry.id)
        ? text(t('Effective at next renewal: {date}', { date: endDate }), theme.board.muted)
        : []),
      ...text(`> ${monitorText(edit.text)}${edit.text ? ' ' : ''}▌`, theme.board.active),
    ];
  }
  return [
    ...text(t('Local · all projects'), theme.board.muted),
    ...(data.unreadable ? text(t('Could not read EXP configuration'), theme.board.danger) : []),
    ...sections.flatMap(({ label, entries, notes, readings }) => [
      section(t(label), width),
      ...(entries ?? []).flatMap((entry) => [
        ...labeled(entry.label, entry.value).map((row, i) => (i ? row : { ...row, item: entry.id })),
        ...(entry.reading ? labeled(t(entry.reading[0]), entry.reading[1]) : []),
      ]),
      ...(readings ?? []).flatMap((reading) =>
        typeof reading === 'string' ? labeled(t(reading), offline()) : labeled(t(reading[0]), reading[1])
      ),
      ...(page.detail === 'proxy-status'
        ? proxyReadings(data, nowMs).flatMap(([name, value]) => labeled(name, value))
        : []),
      ...(notes ?? []).flatMap((note) => text(t(note))),
    ]),
  ];
}

export const expHints = (page: ExpPage, data?: ExpData): string => {
  if (page.detail === 'proxy-status') return '↑↓ scroll  esc back';
  if (!page.edit) return page.detail ? '↑↓ select  ⏎ edit  esc back' : '↑↓ select  ⏎ edit  ←→ tab';
  if (page.edit.preview) return '⏎ save  esc cancel';
  const entry =
    data &&
    groups(data, page.detail)
      .flatMap((g) => g.entries ?? [])
      .find((e) => e.id === page.cursor);
  return entry?.edit && 'choices' in entry.edit
    ? '↑↓ pick  ⏎ save  esc cancel'
    : page.cursor === 'calibration'
      ? '⏎ preview  esc cancel'
      : '⏎ save  esc cancel';
};

export function expInput(state: MonitorState, key: WorkbenchInput, ctx: MonitorContext): MonitorOutcome | null {
  const page = { ...state.expPage },
    data = ctx.frame?.expData;
  const out = (edit?: ExpEdit): MonitorOutcome => ({
    state: { ...state, expPage: page },
    close: false,
    action: edit && { type: 'exp-save', edit },
  });
  const pane = ctx.frame?.panes.find((p) => p.id === 'agents');
  const name = key.type === 'key' ? key.key : '';
  const entries = data ? groups(data, page.detail).flatMap((g) => g.entries ?? []) : [];
  const at = entries.findIndex((e) => e.id === page.cursor);
  const current = entries[at];
  if (page.edit) {
    const draft = { ...page.edit },
      editor = current?.edit;
    const leave = () => {
      page.edit = undefined;
      page.scroll = 0;
      page.notice = undefined;
    };
    if (!editor || name === 'escape') {
      leave();
      return out();
    }
    if (key.type !== 'key') return out();
    page.edit = draft;
    page.notice = undefined;
    if (name === 'enter') {
      const change =
        draft.preview ?? ('choices' in editor ? editor.choices[draft.pick]?.change : editor.parse(draft.text.trim()));
      if (!change) page.notice = 'Invalid value';
      else if (change.field === 'calibration' && !draft.preview) draft.preview = change;
      else return out(change); // The panel closes the editor only after a successful write.
    } else if (!draft.preview) {
      if ('choices' in editor) {
        if (['up', 'down', 'left', 'right'].includes(name)) {
          const n = editor.choices.length;
          draft.pick = (draft.pick + n + (name === 'up' || name === 'left' ? -1 : 1)) % n;
        }
      } else if (name === 'backspace') draft.text = [...draft.text].slice(0, -1).join('');
      else if (key.text !== undefined && draft.text.length < 80) draft.text += key.text;
    }
    return out();
  }
  if (page.detail && name === 'escape') {
    page.cursor = page.detail;
    page.detail = undefined;
    page.scroll = 0;
    page.notice = undefined;
    return out();
  }
  const enter = (entry: Entry | undefined) => {
    if (entry?.detail) {
      page.detail = entry.detail;
      page.cursor = undefined;
    } else if (entry?.edit) page.edit = { text: '', pick: 'choices' in entry.edit ? entry.edit.initial : 0 };
    if (entry) {
      page.scroll = 0;
      page.notice = undefined;
    }
    return out();
  };
  const scroll = (step: number) => {
    page.scroll = Math.max(
      0,
      Math.min(Math.max(0, (pane?.contentLength ?? 0) - (pane?.height ?? 0)), (page.scroll ?? 0) + step)
    );
    return out();
  };
  if (key.type === 'mouse') {
    if (key.button !== 'left') return scroll(key.button === 'wheel-down' ? 3 : -3);
    const row = pane && monitorRowAt(pane, key.x, key.y);
    const entry = row?.item ? entries.find((e) => e.id === row.item) : undefined;
    if (!entry) return out();
    if (entry === current) return enter(entry);
    page.cursor = entry.id;
    return out();
  }
  if (name === 'enter' && key.text !== ' ') return enter(current);
  if (['up', 'down', 'home', 'end', 'page-up', 'page-down'].includes(name)) {
    const step = name === 'up' ? -1 : name === 'page-up' ? -5 : name === 'page-down' ? 5 : 1;
    if (!entries.length) return scroll(name === 'home' ? -Infinity : name === 'end' ? Infinity : step);
    page.cursor =
      entries[
        name === 'home' ? 0 : name === 'end' ? entries.length - 1 : Math.max(0, Math.min(entries.length - 1, at + step))
      ].id;
    return out();
  }
  return null;
}
