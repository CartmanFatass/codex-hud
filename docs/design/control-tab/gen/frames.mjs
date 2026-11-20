// The frames of the Control tab sample, in one language at a time. `build('zh')` and `build('en')` draw the same states.
// Every row is checked to be exactly W cells (CJK = 2) when it is made. Synthetic data only (world.mjs).
import { W, row, lr, blank, sec, cut, mid, pad, len, width, plain, frame, foot } from './lib.mjs';
import { ROLES, GROUPS, MACHINE, BASE, switchOf, targetOf, evaluate, roleView, cycle } from './world.mjs';

export function build(lang) {
  const zh = lang === 'zh', T = (z, e) => (zh ? z : e);
  const H = 'auto';

  // ----------------------------------------------------------------------------------------------- words
  const w = {
    attention: T('需要处理', 'Needs attention'), healthy: T('正常', 'Healthy'), usage: T('用量', 'Usage'), files: T('文件', 'Files'),
    roles: T('角色', 'Roles'), harnesses: T('宿主', 'Harnesses'),
    group: { roles: T('角色', 'Roles'), project: T('项目角色', 'Project roles'), browser: T('浏览器任务', 'Browser tasks') },
    none: T('无', 'none'), custom: T('自定义', 'Custom'), off: T('已停用', 'off'), offGroup: T('已停用', 'Off'), missing: T('未安装', 'not installed'),
    installed: T('已安装', 'installed'), listed: T('已列出', 'listed'), notSeen: T('未见', 'not seen'),
    exhausted: T('已耗尽', 'exhausted'), next: T('下个任务', 'next job'), model: T('模型', 'model'), thinking: T('思考', 'thinking'),
    source: T('来源', 'source'), chain: T('备选链', 'Chain'), unsaved: T('未保存', 'Not saved'), default: T('默认', 'default'),
    src: { default: T('默认', 'default'), yours: T('你的', 'yours'), project: T('项目', 'project') },
    min: (n) => T(`${n}分钟`, `${n}m`),
  };
  const modelWord = w.model, thinkWord = w.thinking;

  // ----------------------------------------------------------------------------------------------- small pieces
  const chip = (s) => `{t/title ${s}}`;
  const E = (markup, item, bg) => row(markup, bg, item);
  const kv = (k, v, col = 9) => row(`{m ${pad(k, col)}} ${v}`);
  const MARK = { next: '{b ◉}', standby: '{m ○}', exhausted: '{a ✗}', off: '{m ⊘}', missing: '{m −}' };

  const tabRow = (open = 'control', badge = 2) => {
    const part = (name, n, on) => {
      const k = on ? 't/title' : 'm';
      return `{${k}  ${name}}${n ? `{${on ? 'a/title' : 'a'}  ?${n}}` : ''}{${k}  }`;
    };
    const left = [['home', T('首页', 'Home'), 0], ['project', T('项目', 'Project'), badge], ['control', T('控制', 'Control'), 0], ['exp', 'EXP', 0]]
      .map(([id, name, n]) => part(name, n, id === open)).join('');
    const models = `{m ${T('模型 开', 'models on')}}`;
    // The tabs come first; the models word goes when it does not fit whole.
    return width(left) + width(models) + 1 <= W ? lr(left, models) : row(left);
  };
  const nameRow = () => {
    const right = `{m ▾ ${T('项目', 'project')} 1/3}`;
    return lr(`{t* harbor-api} {f ${'─'.repeat(W - 12 - width(right))}}`, right);
  };
  const viewRow = (view) => row(view === 'roles'
    ? `{t/title  ${w.roles} }{m  ${w.harnesses} }` : `{m  ${w.roles} }{t/title  ${w.harnesses} }`);
  const machineNote = `{m ${T('本机 · 所有项目 · 角色文件不动', 'This machine · all projects')}}`;
  const head = (view, notice) => [tabRow(), nameRow(), viewRow(view),
    notice ? row(notice) : view === 'harnesses' ? row(machineNote) : blank()];

  // ----------------------------------------------------------------------------------------------- roles
  const presetText = (v) => (v.name ?? w.custom);
  const nextText = (v) => (v.next >= 0 ? targetOf(v.places[v.next]) : `{a ${w.none}}`);
  /** `✗ reviewer [pi] → claude`: the role, its preset, where the next job runs. */
  const roleLine = (v, mark) => `  ${mark} ${chip(v.role)} {m [${presetText(v)}] →} ${v.next >= 0 ? nextText(v) : nextText(v)}`;
  const placeBody = (p) => {
    const model = p.h === 'bro' ? p.kind : p.model, extra = p.h === 'pi' || (p.h === 'cli' && p.think) ? p.think : '';
    return [targetOf(p), model, extra].filter(Boolean).join('  ');
  };
  const reasonOf = (v, i) => {
    const p = v.places[i], s = v.st[i];
    if (s === 'off') return `{m ${w.off} · ${T('开关', 'switch')} ${switchOf(p)}}`;
    if (s === 'exhausted') return `{a ${w.exhausted} ${w.min(BASE.marks[`${v.role}:${i}`])}} {m · ${T('x 清除', 'x clears')}}`;
    if (s === 'missing') return `{m ${w.missing} · ${p.agent}}`;
    return '';
  };
  const chainRows = (v, indent = '  ') => v.places.flatMap((p, i) => {
    const s = v.st[i], ink = s === 'next' ? 't' : 'm';
    const rows = [row(`${indent}{m ${i + 1}} ${MARK[s]} {${ink} ${cut(placeBody(p), W - len(indent) - 4)}}`)];
    const why = reasonOf(v, i);
    if (why) rows.push(row(`${indent}    ${why}`));
    return rows;
  });
  const attentionReason = (v) => {
    const dead = v.st.findIndex((s) => s === 'exhausted');
    if (dead >= 0) return `{m ${targetOf(v.places[dead])}} {a ${w.exhausted} ${w.min(BASE.marks[`${v.role}:${dead}`])}}`;
    const off = v.st.findIndex((s) => s === 'off');
    return off >= 0 ? `{m ${switchOf(v.places[off])}} {m ${w.off}}` : `{m ${w.none}}`;
  };

  /** The Roles list as entries (rows that carry an `item`), for a state. */
  function rolesList(state, { open = false, notice } = {}) {
    const views = Object.keys(ROLES).sort().map((r) => roleView(r, state));
    const att = views.filter((v) => v.attention).sort((a, b) => Number(a.next < 0) - Number(b.next < 0));
    const out = [];
    out.push(sec(`{t ${w.attention}}`, `{a ${att.length + 1}}`));
    for (const v of att) {
      const item = `role:${v.role}`;
      out.push(E(roleLine(v, v.next < 0 ? '{a −}' : '{a ✗}'), item), E(`      ${attentionReason(v)}`, item));
    }
    out.push(Object.assign(lr(`  {a !} bad.json`, `{m ${T('JSON 无法解析', 'unparseable JSON')}}`), { item: 'file:bad' }));
    out.push(blank());
    const healthy = views.filter((v) => !v.attention);
    if (!open) {
      out.push(sec(`{t ▸ ${w.healthy}}`, `{m ${healthy.length}}`, 'fold:healthy'));
      const names = [];
      let line = '';
      for (const g of GROUPS) for (const v of healthy.filter((x) => x.def.group === g)) {
        if (line && len(line) + 2 + len(v.role) > W - 4) { names.push(line); line = ''; }
        line += (line ? '  ' : '') + v.role;
      }
      if (line) names.push(line);
      names.forEach((l, i) => out.push(E(`  ${i ? ' ' : '{b ◉}'} {t ${l}}`, 'fold:healthy')));
    } else {
      out.push(sec(`{t ${w.healthy}}`, `{m ${healthy.length}}`, 'fold:healthy'));
      for (const g of GROUPS) for (const v of healthy.filter((x) => x.def.group === g)) {
        // A project role says so at the right of its row: its file is the project's, the panel does not write it.
        out.push(Object.assign(lr(roleLine(v, '{b ◉}'), v.def.src === 'project' ? `{m ${w.src.project}}` : ''), { item: `role:${v.role}` }));
      }
    }
    out.push(blank());
    out.push(sec(`{t ▸ ${w.usage}}`, `{m ${T('codex 剩余 62% · pi $1.20', 'codex 62% left · pi $1.20')}}`, 'fold:usage'));
    out.push(sec(`{t ▸ ${w.files}}`, `{m ${T('密钥 3/5 · 浏览器 ✓', 'keys 3/5 · browser ✓')}}`, 'fold:files'));
    return out;
  }

  /** The preview of a role: where the next job runs and why, then the numbered chain with every skipped place. */
  function rolePreview(v, state, { extra = [] } = {}) {
    const nextP = v.next >= 0 ? v.places[v.next] : undefined;
    const rows = [
      kv(w.next, nextP ? targetOf(nextP) : `{a ${w.none}}`),
      ...(nextP ? [kv(modelWord, nextP.h === 'bro' ? nextP.kind : nextP.model ?? w.default),
        kv(thinkWord, (nextP.h === 'pi' || nextP.think) ? nextP.think : w.default)] : []),
      kv(w.source, `${w.src[v.def.src]} · ${v.def.file.split('/').pop()}`),
      ...extra,
      blank(),
      sec(`{m ${w.chain}}`, `{m ${v.places.length}}`),
      ...chainRows(v),
    ];
    return { rule: sec(v.role, `{m [${presetText(v)}]}`), rows };
  }

  // ----------------------------------------------------------------------------------------------- frame composers
  /** Split: head, the list (the cursor's rows are one band), a blank, the rule and the preview, then the footer. */
  function split({ name, head: top, list, cursor, compact = false, rule, preview, hints, left = '' }) {
    let shown = list;
    if (compact) {
      const at = list.findIndex((r) => r.item === cursor), last = list.map((r) => r.item).lastIndexOf(cursor);
      const start = Math.max(0, Math.min(list.length - 3, at - Math.floor((3 - (last - at + 1)) / 2)));
      shown = list.slice(start, start + 3);
    }
    const rows = [...top, ...shown.map((r) => (cursor && r.item === cursor ? { ...r, bg: 'sel' } : r)), blank(), rule, ...preview];
    return frame(rows, H, foot(left, hints), name);
  }
  /** Classic: head and one list, the cursor's rows banded; what a preview would say is expanded under the row. */
  function classic({ name, head: top, list, cursor, hints, left = '' }) {
    return frame([...top, ...list.map((r) => (cursor && r.item === cursor ? { ...r, bg: 'sel' } : r))], H, foot(left, hints), name);
  }

  // Hints are listed most important first; the footer cuts from the right, whole hints only, so at 40 cells the rest is in Help.
  const HINT = {
    roles: T('↑↓ 移动  ⏎ 备选链  c C 预设  p 选预设  h 宿主  ? 帮助', '↑↓ move  ⏎ chain  c C preset  p presets  h harnesses  ? help'),
    rolesX: T('↑↓ 移动  x 清除  c C 预设  p 选预设  ⏎ 备选链  h 宿主', '↑↓ move  x clear  c C preset  p presets  ⏎ chain  h harnesses'),
    classicRoles: T('↑↓ 移动  ⏎ 展开  c C 预设  p 选预设  h 宿主  ? 帮助', '↑↓ move  ⏎ open  c C preset  p presets  h harnesses  ? help'),
    pinned: T('↑↓ 移动  o 打开文件  ⏎ 备选链  h 宿主  ? 帮助', '↑↓ move  o open file  ⏎ chain  h harnesses  ? help'),
    harn: T('↑↓ 移动  空格 开关  i 添加  h 角色  r 刷新  ? 帮助', '↑↓ move  space on/off  i add  h roles  r refresh  ? help'),
    harnFold: T('↑↓ 移动  ⏎ 展开  i 添加  h 角色  r 刷新  ? 帮助', '↑↓ move  ⏎ open  i add  h roles  r refresh  ? help'),
    chainDraft: T('i 添加  s 保存  esc 放弃', 'i add  s save  esc discard'),
    chainDraft2: T('s 保存  esc 放弃  i 添加  ⏎ 编辑  K J 移动  Del 移除', 's save  esc discard  i add  ⏎ edit  K J move  Del remove'),
    sheet: T('↑↓ 字段  ⏎ 选择  esc 取消', '↑↓ field  ⏎ choose  esc cancel'),
    pick: T('输入筛选  ↑↓ 选择  ⏎ 填入  esc 取消', 'type to filter  ↑↓ pick  ⏎ fill  esc cancel'),
    name: T('输入名称  ⏎ 继续  esc 取消', 'type a name  ⏎ continue  esc cancel'),
    plist: T('输入筛选  ↑↓ 选择  ⏎ 应用  esc 取消', 'type to filter  ↑↓ pick  ⏎ apply  esc cancel'),
    add: T('输入筛选  ↑↓ 选择  ⏎ 恢复  esc 返回', 'type to filter  ↑↓ pick  ⏎ restore  esc back'),
  };

  // ----------------------------------------------------------------------------------------------- harnesses
  const offSet = (state) => new Set(state.off);
  /** The Harnesses list as entries: enabled items by section, then the folded Off (N) group. */
  function harnessList(state, { open = false } = {}) {
    const off = offSet(state), out = [], runnerOff = off.has('pi'), on = (id) => !off.has(id);
    const section = (label, n) => out.push(sec(`{t ${label}}`, `{m ${n}}`));
    const put = (id, name, rest, right) => out.push(Object.assign(
      lr(`  {b ◉} {t ${name}}${rest ? `  {m ${rest}}` : ''}`, `{m ${right}}`), { item: `sw:${id}` }));
    if (on('pi')) { section(T('运行器', 'Runner'), 1); put('pi', 'pi', '', w.installed); out.push(blank()); }
    const cliOn = MACHINE.cli.filter(([a]) => on(`cli:${a}`));
    section(T('CLI 代理', 'CLI agents'), cliOn.length);
    for (const [a, here] of cliOn) put(`cli:${a}`, a, '', here ? w.installed : w.missing);
    out.push(blank());
    const broOn = MACHINE.bro.filter(([t]) => on(`bro:${t}`));
    section(T('浏览器工具', 'Browser tools'), broOn.length);
    for (const [t, sites] of broOn) put(`bro:${t}`, t, sites.join(' '), w.installed);
    out.push(blank());
    const provOn = MACHINE.providers.filter(([p]) => on(`pi:${p}`));
    section(T('pi 提供方', 'Pi providers'), provOn.length);
    for (const [p] of provOn) put(`pi:${p}`, p, '', runnerOff ? T('pi 已停用', 'pi off') : w.listed);
    out.push(blank());
    const offIds = [...state.off].sort((a, b) => (a === 'pi' ? -1 : b === 'pi' ? 1 : a.localeCompare(b)));
    out.push(sec(`{t ${open ? '' : '▸ '}${w.offGroup}}`, `{m ${offIds.length}}`, 'fold:off'));
    if (open) for (const id of offIds) {
      const word = id === 'pi:deepseek' ? w.notSeen : id.startsWith('pi:') ? w.listed : w.installed;
      out.push(Object.assign(lr(`  {m ⊘} {m ${id}}`, `{m ${word}}`), { item: `sw:${id}` }));
    }
    return out;
  }

  // ============================================================================================================
  const frames = [];
  const add = (section, id, title, layout, cap, fr) => frames.push({ section, id, title, layout, cap, frame: fr });
  const S = BASE;
  const state = (extra = {}) => ({ ...S, ...extra, marks: S.marks, active: { ...S.active, ...(extra.active ?? {}) } });

  // ---- 1. Tab bar and landing
  {
    const st = state(), list = rolesList(st);
    const v = roleView('reviewer', st), pv = rolePreview(v, st);
    add(1, '1', 'Control tab · Roles landing', 'Split', 'Tab bar with Control selected; it opens on Needs attention, with Healthy, Usage and Files folded.',
      split({ name: 'landing', head: head('roles'), list, cursor: 'role:reviewer', rule: pv.rule, preview: pv.rows, hints: HINT.rolesX }));
  }

  // ---- 2. Roles: Healthy unfolded, Classic
  {
    const st = state(), list = rolesList(st, { open: true });
    const v = roleView('imp', st), pv = rolePreview(v, st);
    add(2, '2a', 'Roles · Healthy unfolded', 'Split', 'Enter on Healthy: one row per role, `imp [daily] → pi/xai`; the preview is its whole chain.',
      split({ name: '2a', head: head('roles'), list, cursor: 'role:imp', rule: pv.rule, preview: pv.rows, hints: HINT.roles }));
    // Classic: the landing, folded, and the same list unfolded with the chain expanded under the role.
    const folded = rolesList(st);
    add(2, '2b', 'Roles landing · Classic', 'Classic', 'Classic: the same landing without a preview; an attention role keeps its reason under its row.',
      classic({ name: '2b', head: head('roles'), list: folded, cursor: 'role:reviewer', hints: HINT.classicRoles }));
    const open = rolesList(st, { open: true }), at = open.findIndex((r) => r.item === 'role:imp');
    const chain = chainRows(v, '    ');
    const expanded = [...open.slice(0, at + 1), ...chain, row(`    {m ${w.source}} ${w.src[v.def.src]} · imp.json`), ...open.slice(at + 1)];
    add(2, '2c', 'One role expanded · Classic', 'Classic', 'Classic: Enter expands the chain under the role, read-only until a change makes a draft.',
      classic({ name: '2c', head: head('roles'), list: expanded, cursor: 'role:imp', hints: HINT.classicRoles }));
  }


  // ---- shared by the scenario frames
  const notice = (text) => `{s ✓} ${text}`;
  const usedBy = (id, st) => Object.keys(ROLES).sort().flatMap((r) => {
    const v = roleView(r, st), at = v.places.findIndex((p) => switchOf(p) === id || (id === 'pi' && p.h === 'pi'));
    return at >= 0 ? [{ role: r, v, at }] : [];
  });
  const hyp = (st, id, turnOff) => ({ ...st, off: turnOff ? [...st.off, id] : st.off.filter((x) => x !== id) });
  const nextOf = (v) => (v.next >= 0 ? targetOf(v.places[v.next]) : `{a ${w.none}}`);
  const roleAt = (u) => `${u.role} {m [${presetText(u.v)}]} ${T('第 ', '#')}${u.at + 1}${T(' 位', '')}`;
  /** What a harness item says in the preview: its facts, who uses it, and what a toggle does to the next job. */
  function harnessPreview(id, st, kind) {
    const off = id === 'pi' ? st.off.includes('pi') : st.off.includes(id), users = usedBy(id, st);
    const after = users.map((u) => ({ u, v: roleView(u.role, hyp(st, id, !off)) }));
    const facts = kind === 'provider'
      ? `${off ? w.off : T('已启用', 'on')} · ${id === 'pi:deepseek' ? w.notSeen : w.listed}`
      : `${off ? w.off : T('已启用', 'on')} · ${kind === 'cli' && MACHINE.cli.find(([a]) => `cli:${a}` === id)?.[1] === false ? w.missing : w.installed}`;
    const rows = [kv(T('状态', 'state'), facts)];
    if (kind === 'provider') {
      const n = MACHINE.providers.find(([p]) => `pi:${p}` === id)?.[1];
      if (n) rows.push(kv(w.model, T(`${n} 个 · 列表 2 小时前`, `${n} · list 2h old`)));
    }
    if (kind === 'bro') rows.push(kv(T('站点', 'sites'), MACHINE.bro.find(([t]) => `bro:${t}` === id)?.[1].join('  ')));
    rows.push(kv(T('用于', 'used by'), users.length ? roleAt(users[0]) : `{m ${w.none}}`));
    if (users.length) {
      const first = after[0];
      rows.push(off
        ? kv(w.next, `${first.u.role} → ${nextOf(roleView(first.u.role, st))}`)
        : kv(T('若停用', 'if off'), `${first.u.role} → ${nextOf(first.v)}`));
      rows.push(blank(), row(`{m ${off ? T('位置留在链里，下个任务跳过它', 'place stays in its chain, skipped')
        : T('停用后位置留在链里，被跳过', 'off: place stays in chain, skipped')}}`));
    }
    rows.push(row(`{m ${T('角色文件不改 · 随时恢复', 'role files untouched · restore any time')}}`));
    return rows;
  }
  const scope = `{m ${T('本机 · 所有项目', 'this machine · all projects')}}`;
  const hrule = (label) => sec(label, scope);

  // ---- 3. The scenario: pi:xai off, imp falls to agy, then restored
  {
    const st = state(), list = harnessList(st);
    add(3, '3a', 'Harnesses · xai on', 'Split', 'Cursor on provider xai: the preview says imp [daily] would move to agy if it goes off.',
      split({ name: '3a', head: head('harnesses'), list, cursor: 'sw:pi:xai', rule: hrule('pi:xai'), preview: harnessPreview('pi:xai', st, 'provider'), hints: HINT.harn }));
    const st2 = state({ off: [...st.off, 'pi:xai'] }), list2 = harnessList(st2, { open: true });
    add(3, '3b', 'Space · xai off', 'Split', 'Space: xai moves to Off at once; one switch written, no role file touched.',
      split({ name: '3b', head: head('harnesses', notice(T('已停用 pi:xai · 本机 · 所有项目', 'pi:xai off · all projects'))), list: list2, cursor: 'sw:pi:xai', rule: hrule('pi:xai'), preview: harnessPreview('pi:xai', st2, 'provider'), hints: HINT.harnFold }));
    const v2 = roleView('imp', st2), pv2 = rolePreview(v2, st2);
    add(3, '3c', 'Roles · with xai off', 'Split', 'Roles again: imp [daily] → agy; the off place stays first in the chain with its reason.',
      split({ name: '3c', head: head('roles'), list: rolesList(st2, { open: true }), cursor: 'role:imp', rule: pv2.rule, preview: pv2.rows, hints: HINT.roles }));
    const pv3 = rolePreview(roleView('imp', st), st);
    add(3, '3d', 'Roles · xai restored', 'Split', 'After `i` + Enter on xai (frame 7b): imp [daily] → pi/xai again, same preset all along.',
      split({ name: '3d', head: head('roles', notice(T('已恢复 pi:xai · imp → pi/xai', 'pi:xai restored · imp → pi/xai'))), list: rolesList(st, { open: true }), cursor: 'role:imp', rule: pv3.rule, preview: pv3.rows, hints: HINT.roles }));
  }

  // ---- 4. Presets: c, p, a pinned role
  {
    const st = state(), list = rolesList(st, { open: true });
    const before = rolePreview(roleView('imp', st), st);
    add(4, '4a', 'c · before', 'Split', 'Cursor on imp [daily]: one key switches the preset.',
      split({ name: '4a', head: head('roles'), list, cursor: 'role:imp', rule: before.rule, preview: before.rows, hints: HINT.roles }));
    const st2 = state({ active: { imp: cycle('imp', 'daily', 1) } }), v2 = roleView('imp', st2), pv2 = rolePreview(v2, st2);
    add(4, '4b', 'c · after', 'Split', '`c` wraps daily → default in effective order: no confirm, cursor stays, one field written.',
      split({ name: '4b', head: head('roles', notice(T('imp → 预设 default', 'imp → preset default'))), list: rolesList(st2, { open: true }), cursor: 'role:imp', rule: pv2.rule, preview: pv2.rows, hints: HINT.roles }));

    // p: the list of names plus Custom, each with where its next job would run.
    const names = ROLES.imp.order.map((n) => [n]);   // effective order: shipped names first, the owner's own after
    const pl = (name, cur, cursor) => {
      const v = roleView('imp', st, name), nx = v.next >= 0 ? targetOf(v.places[v.next]) : `{a ${w.none}}`;
      const why = v.next < 0 ? `  {m ${v.places.map(switchOf).join(' ')} ${w.off}}` : '';
      return Object.assign(row(`  ${cur ? '{b ◉}' : ' '} {${cursor ? 't' : 't'} ${pad(name, 9)}} {m →} ${nx}${why}`), { item: `pl:${name}` });
    };
    const customRow = Object.assign(row(`  {m  } {t ${pad(w.custom, 9)}} {m →} ${targetOf(ROLES.imp.presets.default[0])}  {m ${T('文件链', 'file chain')}}`), { item: 'pl:custom' });
    const rowsP = [
      lr(`{m /} {b ▌}`, `{m ${T('4', '4')}}`),
      ...names.map(([n]) => pl(n, n === 'daily')), customRow,
      blank(), row(`{m ${T('⏎ 直接应用 · 全部停用的预设显示“无”', '⏎ applies · an all-off preset: none')}}`),
    ].map((r, i) => (r.item === 'pl:default' ? { ...r, bg: 'sel' } : r));
    add(4, '4c', 'p · preset list', 'Split', '`p`: names plus Custom, Enter applies; the all-off grok preset reads none, it is not skipped.',
      split({ name: '4c', head: head('roles'), list, cursor: 'role:imp', compact: true, rule: sec('imp', `{m ${T('选择预设', 'choose preset')}}`), preview: rowsP, hints: HINT.plist }));

    // A project role: the lock and its source instead of the edit keys.
    const vc = roleView('notes', st), pc = rolePreview(vc, st, { extra: [kv(T('锁定', 'pinned'), T('项目文件 · 这里只读', 'project file · read-only here'))] });
    add(4, '4d', 'A project role', 'Split', 'A project role shows its source and lock; only `o` (open file) is offered, machine switches still apply.',
      split({ name: '4d', head: head('roles'), list, cursor: 'role:notes', rule: pc.rule, preview: pc.rows, hints: HINT.pinned }));
  }

  // ---- 5. A new preset from empty: name, "Not saved" draft, the add-place sheet
  const impList = (st) => rolesList(st, { open: true });
  const sheetRule = (label = 'nightly') => sec('imp', `{m ${label} · ${w.unsaved}}`);
  {
    const st = state(), list = impList(st);
    const savedLine = kv(T('已保存', 'saved'), `{m [daily] → pi/xai}`);
    add(5, '5a', 'I · name the preset', 'Split', '`I`: name the new preset (A–Z a–z 0–9 . _ -, 1–32); Enter continues, Esc cancels.',
      split({ name: '5a', head: head('roles'), list, cursor: 'role:imp', compact: true, rule: sec('imp', `{m ${T('新建 · 从空白', 'new · from empty')}}`),
        preview: [
          row(`{t ${T('新预设', 'New preset')}}`),
          lr(`{m ${pad(T('名称', 'name'), 5)}} {t nightly}{b ▌}`, `{m 7/32}`),
          row(`{m ${T('  A–Z a–z 0–9 . _ -  · 1–32 个字符', '  A–Z a–z 0–9 . _ -  · 1–32 chars')}}`),
          row(`{m ${T('  不能与 imp 的现有名称重复', '  must differ from imp\'s names')}}`),
          blank(), savedLine,
        ], hints: HINT.name }));
    add(5, '5b', 'Empty draft · Not saved', 'Split', 'The draft is marked Not saved; its chain is empty, so it cannot be saved or used yet.',
      split({ name: '5b', head: head('roles'), list, cursor: 'role:imp', compact: true, rule: sheetRule(),
        preview: [
          row(`{a ${w.unsaved}} {m · ${T('要有一个位置才能保存', 'needs a place to save')}}`),
          savedLine, kv(T('草稿', 'draft'), `{m ${w.none}}`), blank(),
          sec(`{m ${w.chain}}`, `{m 0}`),
          row(`  {m ${T('空 · 按 i 添加第一个位置', 'empty · i adds the first place')}}`),
        ], hints: HINT.chainDraft }));
    const field = (label, value, { cur, dim, hint } = {}) => Object.assign(
      lr(`  {m ${pad(label, 9)}} {${dim ? 'm' : 't'} ${value}}`, hint ? `{m ${hint}}` : ''), { item: `f:${label}` });
    const fields = (cursor, target = T('选择…', 'choose…'), model = T('选择…', 'choose…')) => [
      sec(`{t ${T('添加位置', 'Add place')}}`, `{m ${T('第 1 位', '#1')}}`),
      field(T('目标', 'target'), target), field(w.model, model, { dim: target.includes('…') }), field(w.thinking, T('默认', 'default'), { dim: true }),
      field(T('完成', 'done'), '', { dim: true, hint: T('目标和模型填好后可用', 'after target and model') }),
    ].map((r) => (r.item === `f:${cursor}` ? { ...r, bg: 'sel' } : r));
    add(5, '5c', 'Add place · the sheet', 'Split', '`i`: one sheet over the chain: Target, Model, Thinking, then Done.',
      split({ name: '5c', head: head('roles'), list, cursor: 'role:imp', compact: true, rule: sheetRule(), preview: fields(T('目标', 'target')), hints: HINT.sheet }));
    const opt = (name, mark, right, ink = 't', cursor = false) => Object.assign(
      lr(`      ${mark} {${ink} ${name}}`, right ? `{m ${right}}` : ''), { item: `o:${name}`, bg: cursor ? 'sel' : undefined });
    const chooser = [
      sec(`{t ${T('添加位置', 'Add place')}}`, `{m ${T('第 1 位', '#1')}}`),
      Object.assign(lr(`  {m ${pad(T('目标', 'target'), 9)}} {m /} {b ▌}`, `{m 5}`), { item: 'f:t' }),
      opt('pi', '{m ○}', '', 't', true), opt('agy', '{m ○}', ''), opt('claude', '{m ○}', ''),
      opt('codex', '{m −}', w.missing, 'm'), opt('grok', '{m ⊘}', w.off, 'm'),
      field(w.model, T('选择…', 'choose…'), { dim: true }), field(w.thinking, T('默认', 'default'), { dim: true }),
      field(T('完成', 'done'), '', { dim: true }),
      blank(), row(`{m ${T('已停用的不能选 · 未安装的会标明', 'off: not selectable · missing: marked')}}`),
    ];
    add(5, '5d', 'Add place · Target', 'Split', 'Enter on Target: an inline list; off targets cannot be picked, missing ones are marked.',
      split({ name: '5d', head: head('roles'), list, cursor: 'role:imp', compact: true, rule: sheetRule(), preview: chooser, hints: HINT.pick }));
    const done = roleView('imp', st), dv = { ...done, name: 'nightly', places: [ROLES.imp.presets.daily[0], ROLES.imp.presets.daily[1]], st: ['next', 'standby'], next: 0 };
    add(5, '5e', 'Draft with two places', 'Split', 'Two places in the draft; the draft’s next job is written apart from the saved one; `s` saves and selects.',
      split({ name: '5e', head: head('roles'), list, cursor: 'role:imp', compact: true, rule: sheetRule(),
        preview: [
          row(`{a ${w.unsaved}} {m · ${T('s 保存并选中', 's saves and selects')}}`), savedLine,
          kv(T('草稿', 'draft'), `{t pi/xai} {m ${T('（未保存）', '(unsaved)')}}`), blank(),
          sec(`{m ${w.chain}}`, `{m 2}`), ...chainRows(dv),
        ], hints: HINT.chainDraft2 }));
  }

  // ---- 6. The pi model picker, inside the sheet
  {
    const st = state(), list = impList(st);
    const pickHead = () => [sec(`{t ${T('模型', 'Model')}}`, `{m pi · ${T('列表 2 小时前', 'list 2h old')}}`)];
    const group = (name, n) => sec(`{i ${name}}`, `{m ${n}}`);
    const model = (id, { cur, cursor, mark } = {}) => Object.assign(
      row(`  ${cur ? '{b ◉}' : ' '} {t ${mid(id, W - 4)}}`), { bg: cursor ? 'sel' : undefined });
    const query = (text, count) => lr(`{m /} {t ${text}}{b ▌}`, `{m ${count}}`);
    const defaultRow = (cur, cursor) => [
      Object.assign(row(`  ${cur ? '{b ◉}' : ' '} {m ${w.default}} {m → openai/gpt-6.1-sol}`), { bg: cursor ? 'sel' : undefined }),
      row(`      {m ${T('来自 pi 设置', 'from pi settings')}}`),
    ];
    const count = (n) => T(`${n} 个`, `${n}`);
    add(6, '6a', 'Model picker · all', 'Split', 'One list grouped by provider, filter and match count pinned on top; the default row names its source.',
      split({ name: '6a', head: head('roles'), list, cursor: 'role:imp', compact: true, rule: sheetRule(),
        preview: [...pickHead(), query('', count(88)), ...defaultRow(true, false),
          group('anthropic', 9), model('claude-haiku-5-5'), model('claude-opus-5'), model('claude-opus-5-5', { cursor: true }), model('claude-sonnet-5'), model('claude-sonnet-5-5'),
          group('arena', 38), model('anthropic.claude-opus-5-5'), model('claude-opus-5-5'), model('deepseek-v4.1-flash'), model('gemini-4-hydrogen-high'),
          model('grok-4.7'), model('meta-llama/llama-4-maverick-17b-128e-instruct'), model('meta-llama/llama-4-maverick-17b-128e-instruct-fp8'),
          group('google', 12), model('gemini-4-flash'), model('gemini-4-hydrogen'), model('gemini-4-hydrogen-high')],
        hints: HINT.pick }));
    add(6, '6b', 'Model picker · typing grok', 'Split', 'Typing matches provider/model: ◉ is the current model, the band is the cursor; arena and xai both list grok-4.7.',
      split({ name: '6b', head: head('roles'), list, cursor: 'role:imp', compact: true, rule: sec('imp', `{m [daily] · ${T('第 1 位', 'place #1')}}`),
        preview: [...pickHead(), kv(T('当前', 'current'), 'xai/grok-4.7'), query('grok', T('5 个匹配', '5 matches')),
          group('arena', 2), model('grok-4.6'), model('grok-4.7'),
          group('xai', 3), model('grok-4.7', { cur: true }), model('grok-4.7-fast', { cursor: true }), model('grok-4.7-mini'),
        ], hints: HINT.pick }));
    // The whole id under the cursor wraps after a `/` or `-` where it can, so each row ends on a word.
    const full = 'arena/meta-llama/llama-4-maverick-17b-128e-instruct-fp8', wrapped = [];
    for (let rest = full; rest.length;) {
      if (rest.length <= W - 4) { wrapped.push(rest); break; }
      const cutAt = Math.max(rest.lastIndexOf('/', W - 4), rest.lastIndexOf('-', W - 5)) + 1 || W - 4;
      wrapped.push(rest.slice(0, cutAt)); rest = rest.slice(cutAt);
    }
    add(6, '6c', 'Model picker · a long ID', 'Split', 'A long ID is cut in the middle in its row; the whole ID under the cursor wraps below.',
      split({ name: '6c', head: head('roles'), list, cursor: 'role:imp', compact: true, rule: sheetRule(),
        preview: [...pickHead(), query('maverick', T('2 个匹配', '2 matches')),
          group('arena', 2), model('meta-llama/llama-4-maverick-17b-128e-instruct-fp8', { cursor: true }), model('meta-llama/llama-4-maverick-17b-128e-instruct'),
          blank(), sec(`{m ${T('所选的完整 ID', 'full ID under the cursor')}}`), ...wrapped.map((l) => row(`  {t ${l}}`)),
        ], hints: HINT.pick }));
  }

  // ---- 7. Harnesses: Runner, CLI agents, Browser tools, Pi providers; Off (N); Add back
  {
    const st = state(), list = harnessList(st);
    add(7, '7a', 'Harnesses · a browser tool', 'Split', 'Four sections, the switch (◉ ⊘) kept apart from installed; Off (N) folded; a browser row names its sites.',
      split({ name: '7a', head: head('harnesses'), list, cursor: 'sw:bro:jev-ask', rule: hrule('jev-ask'), preview: harnessPreview('bro:jev-ask', st, 'bro'), hints: HINT.harn }));
    const st2 = state({ off: [...st.off, 'pi:xai'] });
    const offIds = [['pi:xai', T('pi 提供方', 'Pi provider'), w.listed], ['cli:grok', T('CLI 代理', 'CLI agent'), w.installed],
      ['bro:jev-flow', T('浏览器工具', 'Browser tool'), w.installed], ['pi:deepseek', T('pi 提供方', 'Pi provider'), w.notSeen]];
    const addRow = ([id, kind, state_], i) => Object.assign(lr(`  {t ${pad(id, 13)}} {m ${kind}}`, `{m ${state_}}`), { item: `a:${id}`, bg: i === 0 ? 'sel' : undefined });
    add(7, '7b', 'i · Add back', 'Split', '`i`: one filterable list of off IDs, Enter restores; a provider not seen today (deepseek) can be restored too.',
      split({ name: '7b', head: head('harnesses'), list: harnessList(st2, { open: true }), cursor: 'sw:pi:xai', compact: true, rule: hrule(T('添加回', 'Add back')),
        preview: [lr(`{m /} {b ▌}`, `{m 4}`), ...offIds.map(addRow), blank(), row(`{m ${T('⏎ 恢复 · 角色文件不改', '⏎ restores · role files untouched')}}`)],
        hints: HINT.add }));
    const st3 = state({ off: [...st.off, 'pi'] }), pvRunner = (() => {
      const users = usedBy('pi', st3), rows = [kv(T('状态', 'state'), `${w.off} · ${w.installed}`),
        kv(T('影响', 'effect'), T('所有 pi 位置被跳过', 'every pi place is skipped')),
        kv(T('提供方', 'providers'), T('6 个，各留各的开关', '6, each keeps its own switch'), 10), blank()];
      for (const u of users.slice(0, 5)) rows.push(row(`  {m ${pad(u.role, 12)}} → ${nextOf(roleView(u.role, st3))}`));
      rows.push(row(`{m ${T('角色文件不改 · 随时恢复', 'role files untouched · restore any time')}}`));
      return rows;
    })();
    add(7, '7c', 'Runner off', 'Split', 'Runner off: providers keep their own switches but read “pi off”; the preview lists the roles that move.',
      split({ name: '7c', head: head('harnesses', notice(T('已停用 pi · 提供方各留各的开关', 'pi off · providers keep their switches'))), list: harnessList(st3, { open: true }), cursor: 'sw:pi', rule: hrule('pi'), preview: pvRunner, hints: HINT.harnFold }));
  }


  return { frames, w, T, H };
}
