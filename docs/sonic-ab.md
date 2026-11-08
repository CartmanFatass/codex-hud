# sonic 双模型对比记录

sonic 角色的两个候选模型：`mistral/deepseek-v4-1-flash-1017`（DS）与 `mistral/zai-glm-5-3-flash`（GLM）。有说法认为后者在后端开发上更强，对比期间 sonic 任务可两者并跑，方法见 `docs/delegation.md` 调度流程第 4 步与 skill `herdr-delegate` 的 Sonic A/B。

每行一个任务：同一 brief、同一基线、同一 effort，各自 worktree，一个 reviewer 盲评两份 diff（A/B 标签）。tps 取各自会话的 `tps` 条目。只记合成或公开信息。

| 日期 | 任务 | 类型 | effort | DS：用时 / 成本 / tps / 质量 | GLM：用时 / 成本 / tps / 质量 | 采用 | 备注 |
|---|---|---|---|---|---|---|---|
| 2026-11-07 | SONIC-AB-01 Mistral 定价调研（[盲评](reviews/2026-11-07-sonic-ab-01-review.md)） | scout（informer 只读） | high | 320s / $0.069 / 269 / **9/10**：curl 绕过 504 取得官方页面原文，补全批处理 50%、Priority 1.75×、区域 1.1×；2 处小错 | 366s / $0.028 / 249 / 6/10：只用第三方来源，错称无批处理折扣（major），缓存折扣比例表述错误 | DS | 两者 9 个价格全对且与 pi 价格表一致；GLM 便宜约 60%、输出 tokens 少一半多，但遇工具失败不找替代路径；DS 卡顿 11 次 vs 3 次 |
