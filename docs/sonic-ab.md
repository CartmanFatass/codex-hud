# sonic 双模型对比记录

sonic 角色的两个候选模型：`mistral/deepseek-v4-1-flash-1017`（DS）与 `mistral/zai-glm-5-3-flash`（GLM）。有说法认为后者在后端开发上更强，对比期间 sonic 任务可两者并跑，方法见 `docs/delegation.md` 调度流程第 4 步与 skill `herdr-delegate` 的 Sonic A/B。

每行一个任务：同一 brief、同一基线、同一 effort，各自 worktree，一个 reviewer 盲评两份 diff（A/B 标签）。tps 取各自会话的 `tps` 条目。只记合成或公开信息。

| 日期 | 任务 | 类型 | effort | DS：用时 / tps / 检查 / 评审发现 | GLM：用时 / tps / 检查 / 评审发现 | 采用 | 备注 |
|---|---|---|---|---|---|---|---|
