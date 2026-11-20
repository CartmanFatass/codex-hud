// The frames of the model picker sample, one language at a time. `build('zh')` and `build('en')` draw the same states.
// Every row is checked to be exactly W cells (CJK = 2) when it is made. Synthetic data only (world.mjs).
//
// Two grids: `g` is the panel at 40 columns (the Control tab as CONTROL-TAB-03 ships it); `G` is the same panel pane zoomed,
// 120 columns by 36 rows. `notes` are annotations drawn beside a frame, not cells of it.
import { cw, len, width, plain, parse, cut, mid, pad, padl, padm, wrap, band, grid } from './lib.mjs';
import { ROLES, BASE, MACHINE, targetOf, roleView, usedBy, infoOf, LISTED, PROVIDER_COUNT, TOTAL } from './world.mjs';

export function build(lang) {
  const zh = lang === 'zh', T = (z, e) => (zh ? z : e);
  const g = grid(40), G = grid(120);

  // ----------------------------------------------------------------------------------------------- words
  const w = {
    model: T('模型', 'Model'), pinned: T('置顶', 'Pinned'), selected: T('所选', 'Selected'),
    off: T('已停用', 'off'), exhausted: T('已耗尽', 'exhausted'), unknown: T('未知', 'unknown'), current: T('当前', 'current'),
    on: T('已启用', 'on'), listed: T('已列出', 'listed'),
    min: (n) => T(`${n}分钟`, `${n}m`), place1: T('第 1 位', 'place #1'), nth: (n) => T(`第 ${n} 位`, `#${n}`),
    ctx: T('上下文', 'ctx'), out: T('输出', 'out'), think: T('思考', 'think'), img: T('图片', 'img'), note: T('备注', 'note'),
    matches: (n) => T(`${n} 个匹配`, `${n} matches`), more: (n) => T(`↓ 还有 ${n} 个`, `↓ ${n} more`),
    d: { provider: T('提供方', 'provider'), context: T('上下文', 'context'), maxOut: T('最大输出', 'max out'), caps: T('能力', 'features'),
      thinking: T('思考', 'thinking'), images: T('图片', 'images'), state: T('状态', 'state'), current: T('当前', 'current'),
      usedBy: T('用于', 'used by'), list: T('列表', 'list'), also: T('同名于', 'also in') },
    age: T('列表 2 小时前', 'list 2h old'),
  };
  const ok = '{s ✓}', no = '{m –}';

  // ----------------------------------------------------------------------------------------------- the 40-column panel
  const chip = (s) => `{t/title ${s}}`;
  const tabRow = () => {
    const part = (name, n, on) => {
      const k = on ? 't/title' : 'm';
      return `{${k}  ${name}}${n ? `{${on ? 'a/title' : 'a'}  ?${n}}` : ''}{${k}  }`;
    };
    const left = [['home', T('首页', 'Home'), 0], ['project', T('项目', 'Project'), 2], ['control', T('控制', 'Control'), 0], ['exp', 'EXP', 0]]
      .map(([id, name, n]) => part(name, n, id === 'control')).join('');
    const models = `{m ${T('模型 开', 'models on')}}`;
    return width(left) + width(models) + 1 <= 40 ? g.lr(left, models) : g.row(left);
  };
  const nameRow = () => {
    const right = `{m ▾ ${T('项目', 'project')} 1/3}`;
    return g.lr(`{t* harbor-api} {f ${'─'.repeat(40 - 12 - width(right))}}`, right);
  };
  const viewRow = () => g.row(`{t/title  ${T('角色', 'Roles')} }{m  ${T('宿主', 'Harnesses')} }`);
  const head = (notice) => [tabRow(), nameRow(), viewRow(), notice ? g.row(notice) : g.blank()];
  /** The three list rows the Split layout keeps while keys are in the preview, around imp. */
  const miniList = () => ['frontend-imp', 'imp', 'oracle'].map((r) => {
    const v = roleView(r, BASE);
    return g.row(`  {b ◉} ${chip(r)} {m [${v.name}] →} ${targetOf(v.places[v.next])}`, undefined, `role:${r}`);
  });
  /** Split: head, the three list rows (the cursor's one is banded), a blank, the rule and the preview, then the footer. */
  function split({ name, notice, rule, preview, hints }) {
    const list = miniList().map((r) => (r.item === 'role:imp' ? { ...r, bg: 'sel' } : r));
    const top = head(notice);
    const rows = [...top, ...list, g.blank(), rule, ...preview];
    return { ...g.frame(rows, 'auto', g.foot('', hints), name), at: top.length + list.length + 2 };
  }
  const impRule = (right) => g.sec('imp', `{m ${right}}`);

  const HINT = {
    chain: T('↑↓ 移动  m 模型  ⏎ 编辑  K J 移位  s 保存  esc 返回', '↑↓ move  m model  ⏎ edit  K J move  s save  esc back'),
    pick: T('↑↓ 选择  ⏎ 设为  esc 取消  ^R 刷新', '↑↓ pick  ⏎ set  esc cancel  ^R refresh'),
    zoom: T('输入筛选  ↑↓ 选择  ⏎ 设为  点标题 折叠  ^R 刷新  esc 关闭并还原', 'type to filter  ↑↓ pick  ⏎ set  click a header: fold  ^R refresh  esc close and restore'),
  };

  // ----------------------------------------------------------------------------------------------- facts and models
  const FACT = { exh: (n) => `{a ✗ ${w.min(n)}}`, off: `{m ⊘ ${w.off}}`, unk: `{o ? ${w.unknown}}` };
  const unknownBy = (id) => Object.keys(LISTED).filter((p) => LISTED[p].some((x) => x.id === id));   // ['arena', 'xai']
  const CUR = 'xai/grok-4.7', EXH = { 'openai/gpt-6.1-sol': 42 };
  const factOf = (full, st = {}) => (st.off?.includes(full.split('/')[0]) ? FACT.off : EXH[full] ? FACT.exh(EXH[full]) : '');
  const recent = [['anthropic/claude-opus-5-5', T('2小时', '2h')], ['mistral/mistral-small-4', T('1天', '1d')]];

  /** The pinned rows, in order: the current model, the models of this role's presets, the recently set. */
  const pinned = (st = {}) => {
    const rows = [{ full: CUR, cur: true, fact: st.off?.includes('xai') ? FACT.off : '' }];
    rows.push({ full: 'openai/gpt-6.1-sol', fact: FACT.exh(42), tag: '[default]' });
    rows.push({ full: 'grok-4.7', bare: true, fact: FACT.unk, tag: '[lab]' });
    for (const [full, age] of recent) rows.push({ full, tag: age });
    return rows;
  };

  // ---- narrow rows (40 columns)
  const gut = (cursor, cur) => `${cursor ? '{b ›}' : ' '} ${cur ? '{b ◉}' : ' '} `;
  /** `› ◉ id        ✗ 42m [default]`: the right side is the fact, then the tag, whole, as far as they fit; the id gives way last. */
  function mrow({ shown, cursor, cur, fact = '', tag = '' }) {
    const cands = [];
    if (fact && tag) cands.push(`${fact} {m ${tag}}`);
    if (fact || tag) cands.push(fact || `{m ${tag}}`);
    cands.push('');
    const room = (c) => 40 - 4 - (c ? width(c) + 2 : 0);
    const pick = cands.find((c) => len(shown) <= room(c)) ?? cands[cands.length - 2] ?? '';
    const id = mid(shown, room(pick));
    const left = `${gut(cursor, cur)}{t ${id}}`;
    return pick ? g.lr(left, pick, cursor ? 'sel' : undefined) : g.row(left, cursor ? 'sel' : undefined);
  }
  const pRow = (p, cursor) => mrow({ shown: p.full, cursor, cur: p.cur, fact: p.fact, tag: p.tag });
  const pickTitle = () => g.sec(`{t ${w.model}}`, `{m pi · ${w.age}}`);
  const qrow = (text, count) => g.lr(`{m /} {t ${text}}{b ▌}`, `{m ${count}}`);
  const hdr = (name, n, open) => g.sec(`{i ${open ? '▾' : '▸'} ${name}}`, `{m ${n}}`, `h:${name}`);
  const offRow = (names = 'deepseek') => g.row(`{m ⊘ ${T(`已停用，不在列表：${names}`, `off, not listed: ${names}`)}}`);
  /** The strip under the list: the whole id (wrapped), then what `pi --list-models` says about it, then a status line. */
  function strip(full, status = '', ids) {
    const info = ids ?? infoOf(full);
    const caps = `{m ${info.ctx} ${w.ctx}  ${info.out} ${w.out}  ${w.think} }${info.think ? ok : no}{m   ${w.img} }${info.img ? ok : no}`;
    return [g.sec(`{m ${w.selected}}`), ...wrap(full, 38).map((l) => g.row(`  {t ${l}}`)), g.row(`  ${caps}`), ...(status ? [g.row(`  ${status}`)] : [])];
  }
  const sCur = `{b ◉} {m ${w.current} · imp [daily] ${w.place1}}`;
  const sExh = `{a ✗ ${w.exhausted}} {m · ${T('42分钟后恢复', 'resets in 42m')}}`;

  // ============================================================================================================
  const frames = [];
  const add = (section, id, title, layout, cap, fr, notes = []) => frames.push({ section, id, title, layout, cap, frame: fr, notes });
  const N = '40 col';

  // ---- 1. Entry: the Control role chain
  {
    const chainRow = (n, cursor, mark, target, model, think) => {
      const left = `${cursor ? '{b ›}' : ' '} {m ${n}} ${mark} {t ${pad(target, 7)}} {m [}{n ${model} ▾}{m ]}`;
      return think ? g.lr(left, `{m ${think}}`, cursor ? 'sel' : undefined, `place:${n}`) : g.row(left, cursor ? 'sel' : undefined, `place:${n}`);
    };
    const chain = (model1, notice) => [
      g.row(`{m ${T('下个任务', 'next job')}  }{t pi/xai}`),
      g.blank(),
      g.sec(`{m ${T('备选链', 'Chain')}}`, `{m 3}`),
      chainRow(1, true, '{b ◉}', 'pi/xai', model1, 'high'),
      chainRow(2, false, '{m ○}', 'agy', 'gemini-4-hydrogen-high', ''),
      chainRow(3, false, '{m ○}', 'claude', 'claude-opus-5-5', 'high'),
      g.blank(),
      g.row(`  {m ${T('点 [模型 ▾] 或按 m：选择模型', 'click [model ▾] or press m to choose')}}`),
    ];
    const a = split({ name: '1a', rule: impRule('[daily]'), preview: chain('grok-4.7'), hints: HINT.chain });
    add(1, '1a', 'The chain with a model field on each place', N,
      T('每个位置行末尾是 `[模型 ▾]` 字段，可点击；光标在位置上按 `m` 打开选择器；`m 模型` 排在页脚提示最前。', 'Each place row ends in a `[model ▾]` field you can click; `m` on a place opens the picker, and `m model` is the first hint in the footer.'),
      a, [
        { row: a.at + 3, text: T('点这个字段，或在这一行按 m', 'click the field, or press m on the row') },
        { row: a.at + 5, text: T('每个位置都有；没设模型的显示 `[默认 ▾]`', 'every place has one; a place with no model reads `[default ▾]`') },
        { row: a.h - 1, text: T('页脚：m 在最前面，窄屏也不会被截掉', 'footer: m comes first, so a narrow footer never cuts it') },
      ]);
    const b = split({ name: '1b', notice: `{s ✓} ${T('imp [daily] 第1位 → xai/grok-4.7-fast', 'imp [daily] #1 → xai/grok-4.7-fast')}`,
      rule: impRule('[daily]'), preview: chain('grok-4.7-fast'), hints: HINT.chain });
    add(1, '1b', 'After Enter in the picker', N,
      T('设定后选择器关闭、面板还原，位置行显示新模型。写入与今天的“改模型”相同；第 5 号票之后它先成为“未保存”草稿。', 'After Enter the picker closes, the panel is restored and the place shows the new model. The write is today\'s model edit; after ticket 05 it becomes a Not saved draft.'),
      b);
  }

  // ---- 2. The 40-column picker
  const placeRule = () => impRule(`[daily] · ${w.place1}`);
  {
    const p = pinned();
    // 2a: opened, empty query, every group folded, the cursor on the current model.
    const prev = [
      pickTitle(), qrow('', TOTAL),
      g.sec(`{t ${w.pinned}}`, `{m ${p.length}}`),
      ...p.map((x, i) => pRow(x, i === 0)),
      ...Object.entries(PROVIDER_COUNT).map(([n, c]) => hdr(n, c, false)),
      offRow(),
      g.blank(),
      ...strip(CUR, sCur),
    ];
    const a = split({ name: '2a', rule: placeRule(), preview: prev, hints: HINT.pick });
    const k = a.at;
    add(2, '2a', 'Picker opened · pinned section', N,
      T('置顶区在分组列表之上：当前模型、本角色各预设用到的模型、最近设定的；分组默认折叠，显示数量；下方的条带给出完整 ID 和 pi 的各列。', 'A pinned section sits above the grouped list: the current model, the models this role\'s presets use, the recently set. Groups start folded with their counts; the strip below gives the whole ID and the columns pi lists.'),
      a, [
        { row: k + 1, text: T('输入即筛选，匹配数固定在这一行', 'typing filters; the match count stays pinned on this row') },
        { row: k + 4, text: T('点一行：光标移到该行，下方条带跟着变；按 Enter 或再点一次才设定', 'click a row: the cursor moves and the strip follows. Enter or a second click sets it') },
        { row: k + 9, text: T('点提供方标题：折叠或展开这一组（仅鼠标；标题不在光标路径上）', 'click a provider header: folds or unfolds the group (mouse only; headers are not on the cursor path)') },
        { row: k + 13, text: T('滚轮滚动列表，查询行和条带不动', 'the wheel scrolls the list; the query row and the strip stay') },
      ]);

    // 2b: typed `grok`; a click moved the cursor onto grok-4.7-fast.
    const gm = (id, o = {}) => mrow({ shown: id, ...o });
    const prevB = [
      pickTitle(), qrow('grok', w.matches(8)),
      hdr('arena', 2, true), gm('grok-4.6'), gm('grok-4.7'),
      hdr('xai', 6, true), gm('grok-4.5'), gm('grok-4.6'), gm('grok-4.7', { cur: true }), gm('grok-4.7-code'),
      gm('grok-4.7-fast', { cursor: true }), gm('grok-4.7-mini'),
      g.blank(),
      ...strip('xai/grok-4.7-fast', `{m ${T('Enter 设定 · 与当前不同', 'Enter sets it · not the current model')}}`),
    ];
    const b = split({ name: '2b', rule: placeRule(), preview: prevB, hints: HINT.pick });
    add(2, '2b', 'Typing grok · a click selected a row', N,
      T('筛选时置顶区收起，只剩一个分组列表。`◉` 是当前模型，`›` 加色带是光标；点击只选中，不设定。', 'While a filter is typed the pinned section steps aside: one grouped list remains. `◉` is the current model, `›` and the band the cursor; a click selects, it does not set.'),
      b, [
        { row: b.at + 8, text: T('◉ 当前模型；› 光标', '◉ current model; › cursor') },
        { row: b.at + 10, text: T('刚点的一行：光标和条带在这里；Enter 或再点一次才写入', 'the row just clicked: cursor and strip are here; Enter or a second click writes') },
      ]);

    // 2c: openai unfolded, scrolled by the wheel; the exhausted model carries its fact on its row.
    const oa = LISTED.openai.map((x) => x.id);
    const shownO = oa.slice(0, 12);
    const prevC = [
      pickTitle(), qrow('', TOTAL),
      hdr('mistral', 8, false), hdr('openai', 15, true),
      ...shownO.map((id) => gm(id, { cursor: id === 'gpt-6.1-sol', fact: id === 'gpt-6.1-sol' ? FACT.exh(42) : '' })),
      g.row(`    {m ${w.more(3)}}`),
      g.blank(),
      ...strip('openai/gpt-6.1-sol', sExh),
    ];
    const c = split({ name: '2c', rule: placeRule(), preview: prevC, hints: HINT.pick });
    add(2, '2c', 'An unfolded group · a model that cannot run', N,
      T('展开 openai 并用滚轮往下：已耗尽的模型在行尾带 `✗ 42分钟`，条带说明何时恢复。照样可以设定，位置会被跳过直到恢复。', 'openai unfolded and scrolled with the wheel: the exhausted model carries `✗ 42m` at its row end and the strip says when it comes back. It can still be set; the place is skipped until then.'),
      c, [
        { row: c.at + 3, text: T('点这个标题：折叠 openai', 'click this header: folds openai') },
        { row: c.at + 13, text: T('状态在行里，不用进详情就能看到', 'the state is on the row, no detail view needed') },
        { row: c.at + 16, text: T('列表被滚动；查询行和条带仍在', 'the list is scrolled; the query row and strip are still there') },
      ]);

    // 2d: a long id; the row is cut in the middle, the strip wraps the whole id.
    const lm = LISTED.arena.filter((x) => x.id.includes('maverick'));
    const prevD = [
      pickTitle(), qrow('maverick', w.matches(2)),
      hdr('arena', 2, true), gm(lm[0].id), gm(lm[1].id, { cursor: true }),
      g.blank(),
      ...strip(`arena/${lm[1].id}`, '', lm[1]),
    ];
    const d = split({ name: '2d', rule: placeRule(), preview: prevD, hints: HINT.pick });
    add(2, '2d', 'A long ID', N,
      T('长 ID 在行里从中间省略，头和尾都留着；光标所在项的完整 ID 在条带里换行显示。', 'A long ID is cut in the middle in its row, head and tail kept; the whole ID of the cursor row wraps in the strip.'),
      d);
  }

  // ----------------------------------------------------------------------------------------------- the zoomed panel (120 x 36)
  const L = 70, R = 49;   // list pane, divider, detail pane
  const ID_W = 32;
  const ctr = (s, n) => ' '.repeat(Math.floor((n - len(s)) / 2)) + s + ' '.repeat(n - len(s) - Math.floor((n - len(s)) / 2));
  const lrm = (left, right, n) => `${left}${' '.repeat(Math.max(1, n - width(left) - width(right)))}${right}`;
  const zsec = (label, right) => `${label} {f ${'─'.repeat(L - width(label) - width(right) - 2)}} ${right}`;
  const zhdr = (name, n, open) => zsec(`{i ${open ? '▾' : '▸'} ${name}}`, `{m ${n}}`);
  const colHead = `    {m ${pad(w.model, ID_W)} ${padl(w.ctx, 6)} ${padl(w.out, 5)} ${ctr(w.think, 5)} ${ctr(w.img, 4)} ${w.note}}`;
  /** One model row of the zoomed list: gutter, id, pi's columns, then the HUD fact (else the pinned tag). */
  function zrow({ shown, info, cursor, cur, fact = '', tag = '' }) {
    const mk = (v, n, at) => `${' '.repeat(at)}${v ? ok : no}${' '.repeat(n - at - 1)}`;
    const cols = info
      ? `{m ${padl(info.ctx, 6)}} {m ${padl(info.out, 5)}} ${mk(info.think, 5, 2)} ${mk(info.img, 4, 1)}`
      : `{m ${padl('·', 6)}} {m ${padl('·', 5)}} {m ${ctr('·', 5)}} {m ${ctr('·', 4)}}`;
    return { markup: `${gut(cursor, cur)}${padm(`{t ${mid(shown, ID_W)}}`, ID_W)} ${cols} ${fact || (tag ? `{m ${tag}}` : '')}`, cursor };
  }
  const zp = (p, cursor) => {
    const ids = p.bare ? (unknownBy(p.full).length && LISTED[unknownBy(p.full)[0]].find((x) => x.id === p.full)) : infoOf(p.full);
    return zrow({ shown: p.full, info: ids, cursor, cur: p.cur, fact: p.fact, tag: p.tag });
  };
  const zm = (prov, x, o = {}) => zrow({ shown: x.id, info: x, ...o });

  /** The right pane. `kv` wraps a value under its label; ids wrap after `/` and `-`. */
  const kv = (label, value, ink = 't') => wrap(value, R - 12).map((l, i) => (i ? `${' '.repeat(11)}{${ink} ${l}}` : `{m ${pad(label, 10)}} {${ink} ${l}}`));
  const rule = () => `{f ${'─'.repeat(R - 2)}}`;
  const usedLines = (full) => {
    const by = {};
    for (const u of usedBy(full)) (by[u.role] ??= []).push(u);
    return Object.entries(by).map(([role, us]) => `${role} ${us.map((u) => `[${u.preset}] ${w.nth(u.place)}`).join(' · ')}`);
  };
  const capsLines = (info) => [
    ...kv(w.d.context, `${info.ctx}    ${w.d.maxOut} ${info.out}`),
    `{m ${pad(w.d.caps, 10)}} {t ${w.d.thinking}} ${info.think ? ok : no}    {t ${w.d.images}} ${info.img ? ok : no}`,
  ];
  const listLine = (extra = '') => kv(w.d.list, T(`2 小时前发现 · ^R 刷新${extra}`, `discovered 2h ago · ^R refreshes${extra}`), 'm');
  const action = (text) => [`{m ⏎} {t ${text}}`];

  function zoom({ name, count, query, qcount, list, detail, rightTitle }) {
    if (list.length > 32) throw new Error(`${name}: ${list.length} list rows do not fit 32`);
    const left = [
      { markup: lrm(`{m /} {t ${query}}{b ▌}`, `{m ${qcount}}`, L) },
      { markup: colHead },
      ...list.map((x) => (typeof x === 'string' ? { markup: x } : x)),
    ];
    const rows = [G.lr(`{t/title  ${w.model} · imp [daily] ${w.place1} · pi}`, `{t/title ${rightTitle} }`, 'title')];
    for (let i = 0; i < 34; i++) {
      const l = left[i] ?? { markup: '' };
      let ls = parse(padm(l.markup, L));
      if (l.cursor) ls = band(ls);
      rows.push(G.fromSegs([...ls, { t: '│', k: 'f' }, ...parse(padm(detail[i] ? ` ${detail[i]}` : '', R))]));
    }
    return G.frame(rows, 36, G.foot('', HINT.zoom), name);
  }
  const zTitle = (n, extra = '') => T(`${n} 个模型 · ${w.age}${extra} · 已放大`, `${n} models · ${w.age}${extra} · zoomed`);
  const Z = 'zoom 120×36';
  const zHeads = () => Object.entries(PROVIDER_COUNT);

  // ---- 3a. The zoom itself: a schematic, not to scale
  {
    const seg = (title, n) => `─ ${title} ${'─'.repeat(Math.max(0, n - len(title) - 3))}`;
    const two = (cols, lw, lt, rt, lines) => {
      const rw = cols - lw - 3;
      return [`┌${seg(lt, lw)}┬${seg(rt, rw)}┐`, ...lines.map(([l, r]) => `│${pad(l, lw)}│${pad(r, rw)}│`), `└${'─'.repeat(lw)}┴${'─'.repeat(rw)}┘`];
    };
    const one = (cols, title, lines) => [`┌${seg(title, cols - 2)}┐`, ...lines.map((l) => `│${pad(l, cols - 2)}│`), `└${'─'.repeat(cols - 2)}┘`];
    const before = two(56, 32, T('主会话', 'session'), T('面板', 'panel'), [
      [' claude code · harbor-api', ' ' + T('控制', 'Control')], ['', ' imp [daily]'], [' > hud_roster', ' ' + T('备选链', 'Chain')],
      ['', ' 1 ◉ pi/xai'], ['', '   [grok-4.7 ▾]'], ['', ' 2 ○ agy'], ['', ' 3 ○ claude'], ['', ''], ['', ' m ' + T('模型', 'model')], ['', ''],
    ]);
    const after = one(56, T('面板 · 已放大', 'panel · zoomed'), [
      [''], ['  ' + T(`选择模型 · imp [daily] ${w.place1}`, `Model · imp [daily] ${w.place1}`)], [''],
      ['  ' + T('左：分组列表和 pi 的各列', 'left: the grouped list, pi\'s columns')], ['  ' + T('右：所选模型的详情', 'right: detail of the selected model')], [''],
      ['  ' + T('主会话窗格仍在，只是被盖住', 'the session pane is still there, covered')], [''], ['  esc ' + T('或设定后：还原', 'or a set: restored')], [''],
    ].map(([l]) => l));
    const midc = Array.from({ length: 12 }, () => '        ');
    midc[4] = ' m ───▶ '; midc[7] = '◀── esc ';
    // Box-drawing characters in the frame ink, the words between them in the text ink.
    const inked = (line) => line.replace(/([┌┬┐└┴┘│─]+)|([^┌┬┐└┴┘│─]+)/g, (_, box, txt) => (box ? `{f ${box}}` : `{t ${txt}}`));
    const rows = before.map((l, i) => G.row(`${inked(l)}{a ${midc[i]}}${inked(after[i])}`));
    add(3, '3a', 'Opening zooms the panel pane, closing restores it', Z,
      T('打开选择器时对面板自己的窗格执行 herdr 的 pane zoom，Esc 或设定后还原；示意图，不按比例。窄于约 100 列、不在 herdr 里或缩放被拒时，改用上面 40 列的选择器。', 'Opening the picker zooms the panel\'s own pane with herdr\'s pane zoom; Esc or a set restores it. A schematic, not to scale. Below about 100 columns, outside herdr, or if the zoom is refused, the 40-column picker above is used.'),
      { rows, h: rows.length, W: 120, used: rows.length });
  }

  // ---- 3b. Grouped: the pinned section, folded groups, one unfolded, the HUD facts
  {
    const p = pinned();
    const oa = LISTED.openai;
    const list = [
      zsec(`{t ${w.pinned}}`, `{m ${p.length}}`),
      ...p.map((x, i) => zp(x, i === 1)),
      zhdr('anthropic', 9, false), zhdr('arena', 38, false), zhdr('google', 12, false), zhdr('mistral', 8, false),
      zhdr('openai', 15, true),
      ...oa.map((x) => zm('openai', x, { fact: x.id === 'gpt-6.1-sol' ? FACT.exh(42) : '' })),
      zhdr('xai', 6, false),
      `{m ⊘ ${T('已停用，不在列表：deepseek', 'off, not listed: deepseek')}}`,
    ];
    const info = infoOf('openai/gpt-6.1-sol');
    const detail = [
      `{t* openai/gpt-6.1-sol}`, rule(),
      ...kv(w.d.provider, `openai · ${w.on} · ${w.listed}`),
      ...capsLines(info), '',
      ...kv(w.d.state, T('✗ 已耗尽 · 42分钟后恢复', '✗ exhausted · resets in 42m'), 'a'),
      ...kv('', T('仍可设定；这个位置会被跳过，直到恢复', 'it can still be set; the place is skipped until then'), 'm'),
      ...kv(w.d.current, T('否 · 第 1 位现在是 xai/grok-4.7', 'no · place #1 is now xai/grok-4.7')),
      ...usedLines('openai/gpt-6.1-sol').flatMap((l, i) => kv(i ? '' : w.d.usedBy, l)),
      ...listLine(), '',
      ...action(T('把 imp [daily] 第 1 位设为它', 'sets imp [daily] #1 to this model')),
    ];
    const fr = zoom({ name: '3b', count: TOTAL, query: '', qcount: TOTAL, list, detail, rightTitle: zTitle(TOTAL) });
    add(3, '3b', 'Zoomed · grouped', Z,
      T('置顶区 + 分组列表（只展开了 openai）。列来自 `pi --list-models`；HUD 的事实在备注列：`✗ 42分钟` 已耗尽并带恢复时间，`? 未知` 提供方无法确定；底部一行说明已停用的提供方。右侧是光标所在模型的详情。', 'The pinned section and the grouped list (only openai unfolded). Columns come from `pi --list-models`; the HUD\'s facts are in the note column: `✗ 42m` exhausted with its reset, `? unknown` provider cannot be attributed; one line at the bottom names the providers that are off. The right pane details the cursor row.'),
      fr);
  }

  // ---- 3c. Filtered: typing grok; the unknown provider resolves here
  {
    const ar = LISTED.arena.filter((x) => x.id.startsWith('grok')), xa = LISTED.xai;
    const list = [
      zhdr('arena', 2, true), ...ar.map((x) => zm('arena', x, { cursor: x.id === 'grok-4.7' })),
      zhdr('xai', 6, true), ...xa.map((x) => zm('xai', x, { cur: x.id === 'grok-4.7' })),
    ];
    const info = infoOf('arena/grok-4.7');
    const detail = [
      `{t* arena/grok-4.7}`, rule(),
      ...kv(w.d.provider, `arena · ${w.on} · ${w.listed}`),
      ...capsLines(info), '',
      ...kv(w.d.also, T('xai/grok-4.7，imp [daily] 第 1 位正在用它', 'xai/grok-4.7, which imp [daily] #1 uses now')),
      ...kv(w.d.current, T('否', 'no')),
      ...kv(w.d.usedBy, T('imp [lab] 第 1 位，文件里写的是 grok-4.7', 'imp [lab] #1, the file says plain grok-4.7')),
      ...kv('', T('提供方未知：arena 和 xai 都列出了它', 'provider unknown: arena and xai both list it'), 'o'),
      ...listLine(), '',
      ...action(T('把 imp [daily] 第 1 位设为它', 'sets imp [daily] #1 to this model')),
    ];
    const fr = zoom({ name: '3c', count: TOTAL, query: 'grok', qcount: T(`${8} / ${TOTAL} 个匹配`, `${8} / ${TOTAL} matches`), list, detail, rightTitle: zTitle(TOTAL) });
    add(3, '3c', 'Zoomed · filtered', Z,
      T('输入 `grok`：全部提供方里匹配的 8 个，置顶区让位。同名模型在两个提供方下各占一行；右侧说明 imp [lab] 文件里只写了 grok-4.7，所以它的提供方是“未知”：从那个位置打开选择器，选一行就写下完整的 `provider/model`。', 'Typing `grok`: the 8 matches across all providers, the pinned section steps aside. One name under two providers is two rows; the detail says imp [lab] names plain grok-4.7 in its file, so its provider is unknown: opened from that place, a pick writes the full `provider/model`.'),
      fr);
  }

  // ---- 3d. A long id
  {
    const lm = LISTED.arena.filter((x) => x.id.includes('maverick'));
    const full = `arena/${lm[1].id}`;
    const list = [zhdr('arena', 2, true), ...lm.map((x, i) => zm('arena', x, { cursor: i === 1 }))];
    const detail = [
      ...wrap(full, R - 1).map((l, i, a) => `{t* ${l}}`), rule(),
      ...kv(w.d.provider, `arena · ${w.on} · ${w.listed}`),
      ...capsLines(lm[1]), '',
      ...kv(w.d.state, T('已列出', 'listed')),
      ...kv(w.d.current, T('否', 'no')),
      ...kv(w.d.usedBy, T('无', 'nothing'), 'm'),
      ...listLine(), '',
      ...action(T('把 imp [daily] 第 1 位设为它', 'sets imp [daily] #1 to this model')),
    ];
    const fr = zoom({ name: '3d', count: TOTAL, query: 'maverick', qcount: T(`2 / ${TOTAL} 个匹配`, `2 / ${TOTAL} matches`), list, detail, rightTitle: zTitle(TOTAL) });
    add(3, '3d', 'Zoomed · a long ID', Z,
      T('列表行把长 ID 从中间省略（头和尾都留着），右侧标题换行显示完整 ID；有 120 列也不需要再往下探。', 'The list row cuts the long ID in the middle (head and tail kept); the detail title wraps the whole ID. With 120 columns nothing needs a second look.'),
      fr);
  }

  // ---- 3e. Provider off: the current model stays visible, the list does not offer its provider
  {
    const st = { off: ['xai'] };
    const p = pinned(st);
    const list = [
      zsec(`{t ${w.pinned}}`, `{m ${p.length}}`),
      ...p.map((x, i) => zp(x, i === 0)),
      zhdr('anthropic', 9, false), zhdr('arena', 38, false), zhdr('google', 12, false), zhdr('mistral', 8, false), zhdr('openai', 15, false),
      `{m ⊘ ${T('已停用，不在列表：xai · deepseek', 'off, not listed: xai · deepseek')}}`,
    ];
    const info = infoOf(CUR);
    const detail = [
      `{t* ${CUR}}`, rule(),
      ...kv(w.d.provider, `xai · ${T('⊘ 已停用（在 Harnesses 里）', '⊘ off (in Harnesses)')}`, 'm'),
      ...capsLines(info), '',
      ...kv(w.d.state, T('这个位置被跳过：imp [daily] → agy', 'this place is skipped: imp [daily] → agy'), 'a'),
      ...kv('', T('⏎ 保留它；要让位置重新生效，选别的模型或在 Harnesses 里把 xai 恢复', '⏎ keeps it; to make the place count again pick another model or restore xai in Harnesses'), 'm'),
      ...kv(w.d.current, T('是 · imp [daily] 第 1 位', 'yes · imp [daily] #1')),
      ...usedLines(CUR).flatMap((l, i) => kv(i ? '' : w.d.usedBy, l)),
      ...kv(w.d.list, T('xai 的模型不在列表里：提供方已停用', 'xai\'s models are not listed: the provider is off'), 'm'),
      '', ...action(T('保留 xai/grok-4.7', 'keeps xai/grok-4.7')),
    ];
    const fr = zoom({ name: '3e', count: 82, query: '', qcount: 82, list, detail, rightTitle: zTitle(82, ' · xai ⊘') });
    add(3, '3e', 'Zoomed · the provider of the current model is off', Z,
      T('xai 在 Harnesses 里停用后：xai 的模型不再出现在列表里（总数 82），但当前模型仍留在置顶区并标 `⊘ 已停用`，详情说明这个位置被跳过。', 'With xai off in Harnesses its models leave the list (total 82), but the current model stays in the pinned section marked `⊘ off`, and the detail says the place is skipped.'),
      fr);
  }

  return { frames, w, T };
}
