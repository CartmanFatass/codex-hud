# ChatGPT Pro: F08 hook budget decision

Sent 2026-11-01 via jev-ask (6 Pro, one send) with `f08-package.zip` (B1/B1b probes, Oracle consult 4, contracts 01/05/06, concept, plan, hook code at `a77c242`). Question routed by Oracle consult 4 F08. Answer verbatim apart from rejoined line breaks; it supersedes the cost gate of consult 4 F08 for the explicit `claude_pre_tool_use_v1` profile.

Decision: **A**: keep Claude→Codex in the MVP; joint p95 < 150 ms for the hook profile, MCP-internal p95 < 50 ms, authorization + DB ≤ 30 ms (busy_timeout ≤ 10 ms, cumulative lock waits ≤ 20 ms).

---

裁决：选 A。保留 Claude→Codex MVP；仅为显式 claude_pre_tool_use_v1 档案设联合 p95＜150 ms，MCP 内部仍 p95＜50 ms。批准预算修订，不代表实现已通过。

1. 预算口径与理由

联合时间从必需 hook 最外层冷进程启动，到同次调用响应 flush；包含缓存首用、取证发布、harness 间隔、完整授权、DB 等待/commit及序列化。逐工具、成功/拒绝/busy分别验收；计时误差采用保守上界，不相加独立分位数。wait沿用原等待预算，前置成本单列。

G13仍是硬门禁：仅匹配七个HUD工具、按次启动、有界读写、无新增常驻服务/轮询，超预算仍是缺陷。150 ms为完整事务和调度留余量；B的收益尚未实测且增加构建/分发负担，C会删去原MVP核心闭环。

附件约90 ms仅根n=8，返回`not_implemented`，不能证明完整授权性能；原始计时日志未附，原机数值无法核实。见  b1b-claude-hook.md 。

2. B4/B5/B14验收
**B4：**真实Claude发起spawn/resume，返回durable accepted；保留既有hooks/配置，精确注入claim/HUD_HOME，零重复提交；同时验150/50两预算。
**B5：**保留F06/F07反例：根→子→根，缺/迟/半写/重复记录，继承根claim，/clear旧调用在途，ABA，双MCP首绑/重绑。锁内重验原代次；旧来源零新提交、子调用零根授权、claim零重复消费，合法新根仍可用。
**B14：**按06既定每工具/组合≥1000次、H/R=1/1与2/10验真事务。最终档案另收≥200次真实联合调用、跨≥10次harness启动，每个声明路径≥20次；逐工具/结果分报n及p50/p95/p99/max，合成数据不混入，缺格不授verified。保留300s资源测量及accepted→started/bound/ready分计。
3. B5授权/DB上限

**授权与事务总墙钟预算≤30 ms，包含DB等待及commit；单次`busy_timeout≤10 ms`，所有等锁、重试及退避累计≤20 ms。**20 ms包含在30 ms内，且都受MCP与联合预算的剩余时间约束。

耗尽且未提交才返回busy；已提交不得谎报未接受，按原幂等结果恢复。同步提交超时记预算缺陷，不声称可硬抢占。

4. 必改条目

以下路径均在`docs/`：

- contracts/06-observation.md ：P-06-4/5、T-06-14/16及测量协议；P-06-1/3/9保留。
- contracts/05-capabilities.md ：LaunchProfile、I-05-1、T-05-1/2；绑定版本、helper修订、档案与双预算证据。
- contracts/01-identity.md ：补齐F06 resolver正文，保持I-01-2/10/12与F07。
- universal-hud-engineering-plan.md  §4：B4/B5/B11/B14；B15仍须真实Claude→Codex闭环。
- universal-hud-concept.md  §15追加本裁决，G13保留；
- Oracle Q4/F08 保留历史并加替代引用。

附件06尚未回填F08联合门槛，此次须落正文，不能只改评审记录。
