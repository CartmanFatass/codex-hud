**Stance:** active

## pivot: HUD as the operational workbench: workers off the owner's desk, load without the panel, outcomes across projects

**State:** done
**Result:** M1–M3 accepted; the M3 Try passed (paused project and ticketless result found on Home, evidence opened, request resolved and cleared)
**Evidence:** docs/spec.md, 9342cacd
**Features:** pivot-m1, pivot-m2, pivot-m3

## glance: Home shows every project's progress at a glance; Project carries the depth without repeating it
**Result:** Home shows today's projects with per-Objective ticket bars, folds the rest behind one key, and ends with Today and Schedule cards.

**State:** done
**Next:** Nothing. Verified live 2026-11-24 at 40x48, 40x24 and 80x40 (zh) on a HUD home copy: today's projects, fold row with a, Today and Schedule cards, short-height card folding.
**Evidence:** 06386505, 1ddabcbb, 532f865e, docs/design/home-cards/README.md
**Features:** home-portfolio, home-cards

## handoff: HUD takes over the mechanical handoff steps between jobs, while the main session keeps the judgement
**Result:** handoff/01–03 已落地：队列等待其他 feature、设计预览自动打开、纯文档提交

**State:** done
**Next:** 用 toktrack 测交接等待的前后对比，按你 11-25 的意思留到之后做 toktrack 时再说
**Features:** handoff

## engine: 一个工作流引擎运行 HUD 的固定流程（批次、prewalk、council、land），MCP 重启不再丢流程

**State:** active
**Next:** workflow/02 prewalk、03 council 在做，04 land 排队；05–07 复杂工作流按 D-2026-11-25-08 搁置
**Result:** 引擎和批次模板已落地（4dbb54ab），真实 4 项 Sonic 批次冒烟通过
**Evidence:** 4dbb54ab, docs/decisions-log.md
**Features:** workflow, batch, council

## pi-worker: HUD 用自己的 pi worker 扩展启动 pi worker，不再依赖 pi-roles

**State:** done
**Next:** 
**Result:** Sonic 已改走 HUD 扩展（e86ed24c），含联网搜索的 5 个真实 Sonic 冒烟通过
**Evidence:** e86ed24c, 599d2644
**Features:** pi-worker

## advisor: Advisor 影子模式：推荐技能、指出违反的规则，只展示不注入

**State:** active
**Next:** 等你试用影子模式（2 张待你试的工单），之后再定注入范围（advisor/03）
**Features:** advisor

## herdr-fork: HUD 运行在自己维护的 herdr fork 上，进程身份、tab 身份和关闭由 herdr 直接提供

**State:** active
**Next:** 构建 fork（Zig 工具链、关闭自更新）；安装切换需 owner 确认
**Evidence:** docs/spec.md, docs/decisions-log.md, tmp/tasks/herdr-fork/brief.md
**Features:** herdr-fork

## unattended: 无人值守服务：你选定目标后，工单队列在没人时继续推进，只在删除或改 spec 时交回

**State:** active
**Features:** unattended, chores, mcp-latency

## interaction: 单项目执行页、选中文字直达 job、通用状态栏和精细交互

**State:** active
**Features:** exec-page, select-send, universal-bar, fine-interact, home-tidy, nav-redesign

## ticket-store: 工单成为 MCP 自有的数据结构：编辑即时生效不等 land，面板直接读结构化事实
**Features:** ticket-store

**State:** active
**Next:** ticket-store/01 after chores/13-15 land
**Evidence:** docs/decisions-log.md
