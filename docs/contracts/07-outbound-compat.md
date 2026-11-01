# 07：材料外发、版本与兼容 facade

- 版本：`v0.1 draft`（2026-11-01；A2）。外发与 v3 是待实现规格，不把现有单 Codex 代码写成已通过通用来源隔离。
- depends-on：[01 身份](./01-identity.md) I-01-1、I-01-6、I-01-8；[02 执行](./02-execution.md)「ledger schema v1」、I-02-14；[03 生命周期](./03-lifecycle.md)「报告与 status」；[04 托管](./04-supervision.md)「文件、字段与原子提交」；[05 能力](./05-capabilities.md)；[06 观测](./06-observation.md)；[概念 v2.3](../universal-hud-concept.md) G8/G9、§6.11、§9、§11–12；[计划](../universal-hud-engineering-plan.md) A6/B17/D2/E；[Oracle](../reviews/2026-11-01-astra-contracts.md) C04、C11、C13。
- 只规定材料/存储/命令的边界；信息呈现由 [Fable 设计](../design/hud-information-design.md) 决定。新通用数据时间为毫秒 epoch，旧 --json v2 的既有 ISO 格式是显式兼容边界。

## 数据模型

### 三个独立的范围

| 范围 | 默认与授权对象 | 不自动授予的权限 |
|---|---|---|
| 本地读取 | 当前绑定会话及原生子代理；账本已确认 delegated 的公开内容可读（可配置为仅元数据）；候选默认仅元数据 | 不授予模型材料/外发；可读 report/日志不等于可送模型 |
| 模型材料 | 每 source 的正向范围，含明确 ref/原生或 delegated 范围与字段白名单；新 cc/pi/Jev/delegated 正文默认关闭 | 现有 Codex 的 native 范围不扩到同 home 的 delegated 节点；模型输出/前次摘要也不豁免来源检查 |
| 外发 | `$HUD_HOME/sources/<sourceId>/outbound.json` 中按 source × purpose × recipient 授权 | brief 不授权 routing，API-A 不授权 API-B，展示设置不授权生成，外发不授权自动执行/预算消费 |

`OutboundPolicy={schemaVersion:1,sourceId,revision,grants:[{purpose,recipientId,decision:allow|deny,grantedAt}]}` 是待冻结的授权形态；缺文件/缺项/无效文件/未知版本/无法确定来源一律 deny。时间为毫秒 epoch；revision 单调，deny/撤销优先，不支持隐含的所有 source/目的/接收方通配授权。model.json 中的模型连接、材料范围与 outbound.json 的外发许可分开；HUD_HOME/settings.json 只放显示设置。私有目录0700、文件0600，完整原子写，不能以损坏文件的默认值变成 allow。

recipient 是已解析的具体目标身份：API 包含 backend/provider、规范 endpoint（scheme/host/port/base path）及有关账号；CLI backend 包含可执行文件/后端档案与可确定的 provider/账号/目标；Jev 为 provider/account 与实际路由；typesafe 为实际端点。密钥不构成 recipientId，也不进入日志/hash身份；endpoint 不能包含凭据明文。不能解析 CLI 的下游目标时，必须显式授权该受信档案的 outbound 能力或拒绝，不能因本机 subprocess 而当纯本地。目标/账号/档案发生影响接收方的变化后重新匹配授权，不静默回退另一模型服务。实际模型/endpoint/语言仍进入缓存身份，但同一接收方的模型配置不代替预算检查。

| purpose | 当前/未来功能的归属 | 需要的材料白名单与独立授权 |
|---|---|---|
| brief | 周期 agent brief / stage 概况 | 原来 briefAgents 的公开名称/角色、任务/intent、公开更新、阶段结果、前次笔记；限定原有大小预算 |
| recap | 主会话 recap | briefMain 的公开用户/assistant 文本、plan/goal/approval概况；子正文另需其来源许可 |
| progress | 可见 live progress | agentProgress 的当前公开 reports、intent、action、plaintext task/charge、名称/角色；没有公开进展证据不生成 |
| digest | result/stage digest、未来 delegated 摘要 | 仅公开结果与已授权的派生材料；不因节点来自 Codex 而继承父范围 |
| label / title | agentLabels 与 session title | 已通过公开 channel/phase 白名单的 charge/任务/首条prompt；密封 Fernet task 不提取 |
| cause / changes / approval | failureCause / changeSummary / approvalDescription，各为独立 purpose | 各自公开错误/命令、受限 diff、待批命令；打开 Changes/卡片不授外发 |
| probe | 显式连接测试 | 固定合成文本，无会话材料；仅目标明确且用户显式触发，沿用预算与 backend 门禁；不授普通生成 |
| jev_task | C 阶段 Job 后端 | 用户指定 prompt/文件与被显式选入且已授权的来源材料；provider/account 分别匹配 |
| routing | F 阶段远程建议 | brief摘要/仓库信号也带来源；单独 typesafe 许可；auto 另需执行白名单与预算 |

所有目的还受各自生成开关、backend off、pause、可见目标范围/预算约束。现有 explicit probe 可在普通生成 paused 时运行，但 off 不联网，且永远只合成文本。上述 purpose 名是内部契约，不改变旧设置键/用户界面。本地 HUD 的授权不替代 harness 自己的权限；显式 delegate_spawn 的任务提交按01–04，但把采集正文拼进 brief 或 Jev/任何模型材料仍须经下面入口，不把一次委派当整 source 外发许可。

### B17：唯一材料入口与来源传播

`buildMaterials({subjects,purpose,resolvedRecipient,limits}) → MaterialEnvelope | denied` 是 B17 拥有的唯一逻辑入口。`MaterialEnvelope` 至少包含正向挑出的公开片段、来源集合（含 origin/ref、原始字段/记录指纹）、purpose、recipientId、policyRevision、材料指纹/覆盖边界、允许的缓存域。片段/摘要的来源继承原文来源；合并材料取 provenance 并集，不能把子文本贴上父 source。元数据也必须符合目的字段白名单，不能用「仅标题」绕过。

处理顺序固定：

1. 按01的 source/ref和06的coverage识别每个候选材料；适配器只提取公开正向白名单，thinking/reasoning/api-request-blob/未知类型/图片与密封任务不进入材料，不保留到模型缓存。
2. 检查本地读取范围与每来源的模型材料范围；本地可读而模型禁用的文本在 prompt拼装/缓存键计算前排除。旧摘要、跨节点结果、report路径指向的内容同样带来源；原始 stdout/stderr 不直接成为材料。
3. 确定本次 purpose 和实际 recipient（含配置/env后的目标），检查每个来源的外发 grant。混合来源先逐片段过滤，完全无可用材料则 denied；有部分授权时必须能独立构造有意义的部分材料并标 partial，不能把未授权段落混进 system/previous_brief/repair prompt。
4. 只有通过检查的材料才可构造 prompt、计算模型输入缓存键、查询/写入模型缓存、入队和送 transport。cache hit 也须复核范围/授权；格式修复重试、摘要翻译、持久笔记重用都走同一入口，不借模型生成文本洗掉 provenance。
5. 排队到发送前再核对实际路由与 policyRevision；撤销、source/目标变化就取消或重新取料授权。重试不换接收方；缓存回复入库也检查当前来源/授权，撤销期间的迟回不写成通用材料。

缓存按 source/目的/接收方/实际模型/材料口径及授权范围隔离，聚合缓存保存全部 provenance，不能给无权消费者命中。新来源未授权正文不得出现在任何 HUD 模型请求或新缓存里，连缓存键的输入也不包含该正文。旧缓存没有可靠 provenance 时不能拿来混合通用来源，保留原文件、只限可证的旧 Codex 用途；拒绝复用不等于自动删除用户缓存。预算协调、单飞、取消与重试沿用现有 SmallModel 实现，不在材料入口另建网络队列/服务。

现状依据（只读）：[SmallModel](../../src/collectors/small-model.ts) 的 submit 是 transport/队列/缓存入口，当前 ModelRequest 无 source/grant provenance；[briefing](../../src/collectors/briefing.ts)、[model-jobs](../../src/collectors/model-jobs.ts)、[progress-summary](../../src/collectors/progress-summary.ts)、[model-probe](../../src/collectors/model-probe.ts) 各自取料。B17 必须把全部功能及 repair/cache 路径纳入，不只包住 brief。现有 [隐私清单](../ARCHITECTURE.md#54-privacy-by-setting) 与 [reference](../reference.md#llm) 的字段/大小边界继续适用；新增材料要登记在清单，不扩大旧权限。

### 四套独立版本

| 版本域 | 本批基线 / 目标 | 兼容/未知版本处理 |
|---|---|---|
| public snapshot | [snapshot.ts](../../src/snapshot.ts) 当前 SNAPSHOT_VERSION=2；A6 起草加法 v3，E才切换新的默认出口并公告v2退役 | v2 facade 保留原格式；v3在独立出口/路径显式选择，不以同名v2文件写v3；未知主版本拒绝解码或标unavailable，不猜字段 |
| checkpoint schema | 06 新 ReaderCheckpoint 的 schemaVersion 从候选1起；另记 readerVersion/sourceGeneration/leaseGeneration/commitSeq | parser语义变化须新reader版本/缓存失效，结构不兼容升schema；旧reader不覆盖较新checkpoint，至多只读旧摘要/明确缺失；受控重建也要采集租约和一致提交 |
| ledger | 02 的 PRAGMA user_version=1 是A9待冻结的SQL schema；HUD只读 | 0由写者在受控初始化/迁移路径处理；已知版本正常，更高版本拒写，不回退JSON控制或自动降级；HUD未知版本不能执行迁移，可拒绝投影并给诊断 |
| SCAN_VERSION | [tree-scan-store.ts](../../src/collectors/tree-scan-store.ts) 当前3；A6因新增读取语义+1 | 内部可重建缓存，不是public snapshot版本。任何树扫描解释/提取字段变化都bump；版本不匹配忽略该缓存并预算内重建，不删用户state/日志/模型授权 |

public v3 与内部 scan v3 恰好数字相同不表示兼容。版本检查先于读写；旧新进程不得争写同一格式/路径，checkpoint和summary即使有schema标签仍须06同一次提交。ledger的迁移仅在短事务检查版本，备份/文件准备在事务外；schema冲突不通过重新发外部动作解决。Jev jobs/browser存储和grant/close完整协议按Oracle C04延期，不为v3草案提前冻结不可达DDL。

v3 的加法槽为 `universal`：`rootRef,sourceId,asOfSeq,asOf,observedAt,coverage,tree{nodes,counts,continuation?},notices`；每node含ref/harness/depth/loaded、06 Metric/五维projection/conflict、03关系/本轮run/报告/候选/parent/reconciliation/resumable、05 host定位结果。新字段时间统一ms epoch，旧字段保持原单位/格式，不能给同名字段改单位。这里是B16/B10/D3共同消费的数据槽，最终类型由A4/A6按本契约落地；counts只用其口径，不能改旧agents为跨harness计数。statusline廉价摘要从同一已提交观测生成，读取边界按06；不写第二套全树snapshot生成器。

### 旧命令与 --json v2 的冻结边界

A–D 的 `codex-hud …` facade 保留现有启动默认（新session；显式--attach/原env策略才复用）、参数透传、cwd+effective CODEX_HOME 的session选择。早期命令 --help/--self-check/--kill/--list/--json、brief --dry-run [FILE] 继续工作；只有带 --dry-run 的 brief 被拦截，裸 brief 仍是Codex输入，`--`终止wrapper解析。不得因改名引入新的启动/授权副作用。

`--json` 仍选择本目录及home的最新匹配tmux session并输出已存的v2 JSON，不现场collect、不发模型请求、不迁移存储、不加外层wrapper。state位于该session的 @codex_hud_codex_home（缺失才回CODEX_HOME默认）下hud/state/<sanitized-session>.json；不能改成按cwd跨home挑最新文件。错误行为保留：无session stderr为 `codex-hud: no session for this directory`、exit1；无可读snapshot为 `codex-hud: no state recorded yet for session …`、exit1，stdout不伪造成功对象。

以下为真实v2字段及语义保留表，不是v3已实现声明；完整形状以 HudSnapshot/SnapshotAgentNode/SnapshotSegment 和现有snapshot单测为基线：

| v2字段 | 保留含义/形状 |
|---|---|
| version、updatedAt | version=2；updatedAt为ISO字符串的上次实际写入时间，不是心跳 |
| session? | id、model?、effort?、cwd?；仅已观测值 |
| project | name、repo?、branch?、dirty、ahead、behind，类型不变 |
| activity? | state、turnStartedAt?、tool?{name,target?}，不替换成五维对象 |
| context?、tokens? | context={percent,used,total,compactions}；tokens={total,cached}；保持现有计算及缺省，不把context累计化 |
| quota、quotaForecast? | quota数组label?/percent/resetsAt?；预测window/exhaustAt/percent/windowMinutes?；真实reset时间不被「过期即已续额」覆盖 |
| agents | active/completed/failed/unknown仅L1，subtasks与reviews各自同四计数且无total；nodes为每线程depth-first列表，id/name/kind/status/depth/model?/effort?不变；父有活跃子时仍按旧规则active |
| attention、approvalSince? | attention数组kind/label/severity；approvalSince保留既有ISO时间与缺失规则 |
| bar | width、segments数组{id,level,x,width}，保持实际绘制坐标；panel的空segments合法 |
| outputRate? | estimated=true、tokensPerSecond、sampleMs、sampledAt，保留估计标记与样本时间，缺/无效测量不生成 |
| health?、bridgeHealth? | health的sessionBound?/lastReadAt?/lastError?{source,message,at}原样保留；bridgeHealth={state,mode?,nativeState?,stateMismatch?,probeFailed?,notificationGap?,lastSuccessAtMs?}，枚举/布尔类型沿用HudData，lastSuccessAtMs?:number保持毫秒epoch，不因通用health改名/丢字段 |

未知的可选对象继续省略；quota/attention/nodes为空时保留数组。已有tokens对象内部部分缺值当前会回落0，此历史兼容例外不能被泛化成新Metric未知=0。旧时间字段逐字段保留现有类型和单位：updatedAt、turnStartedAt、resetsAt、exhaustAt、approvalSince、sampledAt、health.lastReadAt/lastError.at保持ISO字符串；bridgeHealth.lastSuccessAtMs保持number毫秒epoch，sampleMs等时长也保持number。不能把旧时间统一转ISO或epoch；新universal投影另用ms-epoch，不修改v2文件。

SnapshotWriter继续原子写0600、仅事实变化且最多1次/s；成功读/时钟更新本身不强制重写。bar/panel交接按文件dev/inode所有权清理，旧writer不得删掉新文件；不恢复reference里已过时的.owner sidecar描述。brief --dry-run继续只预览brief/recap（不冒称覆盖所有模型功能），不联网；指定FILE才私有写出。B17的新目的可有独立预览，但不改旧命令输出含义。

## 不变量

| 编号 | 断言 | 测试 |
|---|---|---|
| I-07-1 | 本地可读、模型可取料、外发三者独立；每source/purpose/recipient正向授权，缺失/无效默认deny | T-07-1、2、3、18、19 |
| I-07-2 | 新来源及delegated正文默认不取料/不外发；父/旧Codex授权不扩展，私有/未知类型永不成为材料 | T-07-2、4 |
| I-07-3 | 所有生成/repair/cache均经B17唯一入口；provenance取并集、队列发送与缓存回写复验，不从派生摘要洗来源 | T-07-5、6、7 |
| I-07-4 | 授权具体实际recipient；off零网络、scope/开关/预算独立；旧brief开关不能覆盖其他目的 | T-07-3、8、9 |
| I-07-5 | public/checkpoint/ledger/scan版本独立；未知版本不盲写/自动降级；HUD不迁移ledger | T-07-10、11 |
| I-07-6 | v3加法与v2出口隔离，旧字段/类型/缺失/时间/计数语义不变；新投影ms epoch | T-07-12、13 |
| I-07-7 | 旧命令参数、session+home选择、--json只读及错误/退出行为保留 | T-07-14、15 |
| I-07-8 | A–D旧状态可读不自动迁；E按source分别迁设置/材料/外发/预算，不合并授权或改用户harness设置 | T-07-16、17 |

## 状态机

### 授权与材料

`absent/invalid → denied`；只有显式授权形成 allowed，撤销/目的或接收方不匹配回 denied；不以新source注册、显示卡片、backend选择或模型成功响应自动生allow。显式连接probe的授权只针对合成测试目标，不写正文grant。持久许可变更提升revision，未发送的旧材料须重新检查；不能通过换account/profile继承前一目标许可。

材料经过 `candidates → whitelisted → scoped → authorized → cache/queue → revalidated send → result`；任一步拒绝不产生该来源prompt或新缓存。结果若没有可追溯provenance只留本地旧格式，不能注入新材料。远程routing未获routing许可不可用；allowed的suggest也不自动变auto，auto的执行白名单与预算另验。C的Jev与F的routing各有正向测试，不阻B17的默认拒绝测试。

### 版本与迁移

A–D保持 `$CODEX_HOME/hud/`、hud-settings.json与CODEX_HUD_SETTINGS_PATH的读取约定，禁止自动挪动/删除/合并；通用新数据写HUD_HOME的独立source路径，不争写旧格式。当前settings没有source/purpose/recipient字段且会过滤未知键，不能把outbound blob塞进旧settings后声称已持久保存。

B17的旧Codex兼容桥只能读取原home中确已启用的backend/功能/原材料范围和已配置接收方，构造同source/同purpose/同recipient的受限兼容授权视图，不落盘迁移；布尔默认值、凭据存在、新source或delegated关系本身不创造授权。无法证明旧接收方/范围时不扩大，标requires_authorization。原有Codex路径在该范围继续工作；route变化须匹配目标许可，不把API密钥当授权来源。

E的显式迁移为 `inspect → preview per-source mapping → write new private version → verify → selected cutover`，保留旧文件与回滚入口；扫描缓存可重建，模型连接、材料许可、外发许可、预算逐source迁，不求并集。迁移往返必须证明新cc/pi/delegated/Jev仍deny、两home不合并；不改claude-hud/live statusLine，D的安装/恢复由其三道门另管。HUD_*与CODEX_HUD_*别名按概念§9.2至少保留到E之后一个版本；v2退役时间须另行公告，破坏性变更单独发版并修订G8。

## 失败案例

| 编号 | 场景 / 预期 | 不变量 | 测试 |
|---|---|---|---|
| F-07-1 | 原Codex已开API，树加入cc/pi/delegated/Jev → 正文不进入任何prompt/system/repair/cache | I-07-1、I-07-2 | T-07-1、2、4 |
| F-07-2 | brief→API-A已授权，要求routing/API-B/新账号或agy未知路由 → deny，不静默换接收方 | I-07-1、I-07-4 | T-07-3、8 |
| F-07-3 | 子摘要改标父source、cache先命中后查权限、排队后撤销 → 拒复用/取消或重新授权，迟回不写通用缓存 | I-07-3 | T-07-5、6、7 |
| F-07-4 | display reset/preset打开生成、关brief仍有progress/jobs → 各独立门禁，无新增授权；off仍无调用 | I-07-4 | T-07-9 |
| F-07-5 | scan3当snapshot3、较新ledger写旧schema、checkpoint版本未知仍推进offset → 拒绝/有界失效，不覆盖 | I-07-5 | T-07-10、11 |
| F-07-6 | v3覆v2、旧agents改跨harness总数、ISO字段改epoch/旧错误变成功JSON → 兼容测试拒绝 | I-07-6、I-07-7 | T-07-12–15 |
| F-07-7 | 迁移两home求权限并集、读不到授权文件回默认allow、写新字段被旧settings过滤 → 保留旧文件、目标deny、明确失败 | I-07-1、I-07-8 | T-07-16、17 |

## 测试清单

以下是待执行断言；A9是契约/fixture，B是A6兼容回归及B17生产门，C/v1.1为后续功能与E迁移验收，不要求A9先实现它们。全部合成材料/接收端，绝不读真实密钥或会话正文。

| 编号 | Gate | 输入 → 断言 |
|---|---|---|
| T-07-1 | A9 | 缺文件/条目、非法JSON、未知policy版本、source不明/同cwd不同home → 默认deny，原home许可不泄到新source |
| T-07-2 | B | 旧Codex所有生成开关/API已启用；混入cc/pi/Jev/不同及同source的delegated正文哨兵 → 所有请求/新缓存/缓存键材料均无未授权哨兵 |
| T-07-3 | A9 | 每source×purpose×recipient正反表，brief/API-A允许、recap/routing/API-B/新账号未授权 → 仅明确格允许，摘要许可不含routing/auto |
| T-07-4 | B | text与thinking/reasoning/api-request-blob/未知/密封task/原始日志混合 → 仅允许的公开白名单可入材料，私有内容不保留或外发 |
| T-07-5 | B | brief/recap/progress/digest/label/title/cause/changes/approval/probe及repair每入口 → source检查先于prompt/cache；各独立开关，probe固定合成文本 |
| T-07-6 | B | 旧摘要/跨source派生摘要/previous_brief/格式repair与cache命中 → provenance不丢，未授权片段在system/user/缓存中都缺席；未知旧缓存不混用 |
| T-07-7 | B | 入队后撤销、改recipient/env route、迟回/重试 → 发送前/写缓存前复验，不向新目标发旧材料、不换服务绕过deny |
| T-07-8 | B | API实际endpoint/base path/账号切换、agy档案指向远端、未知CLI目标 → 精确recipient授权或拒绝，密钥不成为许可，redirect继续拒绝 |
| T-07-9 | B | backend off、paused、briefAgents off但progress/jobs开、Cards preset/reset、explicit probe → off零调用；其他开关各按目的门禁，显示设置不增权限，paused probe只合成 |
| T-07-10 | A9 | snapshot2/3、scan3/后继、checkpoint未知版本、ledger0/1/更高版本 → 各版本域独立，未知不盲写、不JSON回退，HUD无迁移权限 |
| T-07-11 | B | 变更scan提取语义与checkpoint parser版本、旧新writer共存 → bump/隔离路径，旧缓存不误用，较新checkpoint不覆写，06一致提交仍有效 |
| T-07-12 | B | Codex既有synthetic snapshot fixture逐字段比较，含subtasks/reviews/node kind/空数组/缺值/token兼容零/nullable数据/完整bridgeHealth → v2值、枚举、布尔与number类型、语义不变，v3扩展独立 |
| T-07-13 | B | v3 universal使用ms epoch；旧updatedAt/approvalSince/速率样本/health的ISO字符串与bridgeHealth.lastSuccessAtMs=1700000000000的number并存；另panel空segments、bar→panel原子交接 → 逐字段保留类型/单位，旧writer不删新文件、时钟不强制写 |
| T-07-14 | B | 旧help/self-check/list/kill、attach/new-session/--透传、裸brief与dry-run[FILE] → 原参数/副作用与退出语义保留，dry-run无模型调用且不冒称全目的预览 |
| T-07-15 | B | 同cwd双home多session、--json正常/无session/无snapshot → 选原home最新session、原JSON无wrapper、原stderr+exit1，零collect/网络/迁移 |
| T-07-16 | v1.1 | E显式迁移双source的设置/连接/材料许可/外发/预算并往返 → 逐source保留且不求并集，新来源仍deny，旧state可回滚，旧命令/别名退役另公告 |
| T-07-17 | B | A–D兼容读取与旧settings未知键过滤、授权文件坏/无、旧缓存无provenance → 不自动迁移/删除/扩权，不把未持久化grant当allow |
| T-07-18 | C | Jev各provider/account合成任务、同源未授权材料、显式付费确认/浏览器资源 → 材料授权、执行许可/预算/资源分别验，不因job存在默认外发 |
| T-07-19 | v1.1 | F远程routing建议与auto fixture → routing目标未授权时零请求；有建议许可仍无auto执行权，原Codex摘要许可不补齐 |
