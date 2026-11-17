# [中] CLI worker 尚未就绪时首条 prompt 可能丢失

## 概要
派发 CLI worker 时，如果目标 CLI 在启动后尚未达到交互就绪状态就发送首条 prompt，prompt 可能丢失，而 `thin-main.ts` 将等待超时视为非致命 stall，导致 job 显示为 `working` 但输入框为空。

## 影响
- job 状态停留在 `working`，但 worker 未收到任务、输入栏为空，不会自行开始工作。
- 需要编排者人工介入重新发送 prompt 才能继续。

## 位置
- `packages/hud-mcp/src/thin-main.ts`（~688-697，`dispatchCli`）

## 证据
- job `j1ea04f4499361bb2`（oracle on claude，2026-11-17）：13:25:32 发送首条 prompt，Claude 于 13:25:37 才就绪；`herdr agent prompt ... --wait --until working --timeout 30000` 超时，且 `thin-main.ts` ~688-697 将 stall 当作非致命错误继续监督，最终 job 显示 `working`、输入框为空，直到编排者手工重发 prompt。

## 预期结果
CLI worker 在可接收输入时收到首条 prompt 并开始执行，或发送 stall 后能检测空输入并可靠补发。

## 实际结果
在 CLI 就绪前发送的 prompt 丢失；超时后仍进入监督状态，job 显示 `working` 且输入栏为空。

## 修复建议
- 发送 prompt 前先等待 agent 进入 `idle` / `interactive_ready` 状态。
- 或在 `herdr agent prompt` stall 后复查 pane 状态，当输入框为空时重发一次 prompt。
