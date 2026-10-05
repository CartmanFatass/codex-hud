# [低] CRLF 换行导致增量解析 offset 可能偏小

## 概要
增量解析时 `bytesRead` 以 `+1` 计算换行字节数。若 rollout 使用 `\r\n`，实际换行字节为 2，`newOffset` 可能偏小，导致下一轮增量读取起始位置偏移。

## 影响
- 可能重复解析上一行末尾或跨行碎片，产生重复统计或解析异常。
- 在 Windows 或跨平台共享日志场景下风险上升。

## 位置
- `src/collectors/rollout.ts:147`

## 复现步骤
1. 准备包含 `\r\n` 的 rollout `.jsonl` 文件。
2. 连续触发增量解析，记录每次 `newOffset` 与真实文件大小差异。
3. 观察是否出现重复统计或 JSON 解析异常。

## 预期结果
增量解析偏移准确，起始位置与真实文件字节位置一致。

## 实际结果
未复现（待讨论与验证）。

## 修复建议
- 基于底层流的 `bytesRead` 或显式检测 `\r\n` 换行长度。
- 或使用 `fs.statSync` 与当前偏移做校准。

## 修复记录
- 状态：已修复
- 备注：最初仅为潜在风险提示，尚未验证。
- 修复时间：2026-09-22（69d2f4c）
- 变更说明：`parseRolloutFile` 改为通过单一文件句柄按字节读取，按缓冲区中 `\n` 的真实位置累加 offset（`\r` 计入该行字节），不再以 `+1` 估算换行长度。
- 验证方式：`tests/unit/rollout-live.test.ts`「split UTF-8/CRLF records are retried and counted exactly once」。
