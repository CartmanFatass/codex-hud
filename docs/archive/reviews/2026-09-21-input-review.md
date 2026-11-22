# WSL 中 HUD 键盘、鼠标事件排查

用户确认：WSL，滚轮失效时指针在 Codex 主区域。以下问题描述和行号记录修复前的观察。

## 修复状态

四项主要问题均已修复：主区域按应用鼠标模式转发或进入历史滚动；右键/中键尊重应用鼠标模式，侧栏不再成为默认粘贴目标；侧栏识别并忽略 bracketed paste 内容；HUD 绑定改用会话选择的 `codex-hud` 表，保留原 root 表。

正式回归入口为 `bash tests/integration/test-input-events-real-tmux.sh`，使用实际 wrapper 函数和编译后的侧栏，通过 PTY 检查滚轮、右键 press/release、侧栏存活与焦点、原有 F12 绑定，以及普通输入、Ctrl+T、Ctrl+C 透传。历史复现脚本也保留，但修复后输出应以新行为解读。

验证环境仍限于下述 WSL2/tmux 和合成终端事件，未自动化 Windows Terminal 前端操作。下述 compact HUD 混合输入包边界尚未修改；server 级 extended-keys 等选项也不属于本次绑定隔离范围。

实测环境：WSL2 `6.18.33.2-microsoft-standard-WSL2`，tmux 3.4。使用独立 socket、伪终端、合成输入和临时配置，从当前 `bin/codex-hud` 提取实际 `install_session_input_policy` 函数运行，不复制一份绑定充当产品代码。没有访问真实剪贴板或发送输入到用户会话。

## 1. P1：主区域滚轮失效——应用不接收鼠标时，HUD 删除了滚动兜底

位置：`bin/codex-hud:685`。

HUD session 的 WheelUpPane 分支只执行 `send-keys -t= -M`。当指针下的应用没有开启鼠标报告（`mouse_any_flag=0`）且没有进入 copy mode，tmux 不会把这个事件发送给应用，也不会替它滚动历史。

非 HUD 分支却保留了正确的模式判断和 `copy-mode -e` 兜底，因此同一环境在安装 HUD 绑定前后行为不同。

真实终端事件结果：

| 场景 | 向上滚轮后 pane_in_mode | 应用收到的字节 |
| --- | --- | --- |
| 默认 tmux，应用不接收鼠标 | 1，进入历史滚动 | 无，符合预期 |
| HUD 绑定，应用不接收鼠标 | 0，没有滚动 | 无，事件丢失 |
| HUD 绑定，应用接收鼠标 | 0，交给应用处理 | `ESC[<64;5;5M` |

这条已复现路径可以解释用户描述的症状，但尚未读取到用户故障当时那个 Codex pane 的 mouse_any_flag；当前默认 tmux socket 不存在。不能据此说所有 Codex 视图都会失效，应用开启鼠标接收时的正向对照是通过的。

修复方向：按指针目标 pane 判断 `pane_in_mode` / `mouse_any_flag`；接收鼠标时转发，不接收时保留 tmux 历史滚动。应分别处理 Codex、侧栏与底部单行 HUD，并验证上下滚轮、鼠标所在 pane 与键盘焦点不同的情况。不能只把滚轮改成箭头键，因为那会改变 Codex 输入语义。

## 2. P2：右键/中键强制粘贴，覆盖应用事件并可能把键盘焦点移进 HUD

位置：`bin/codex-hud:673`、`:677`、`:681`；`bin/codex-hud-paste:42`。

只有底部 compact HUD 被排除；Codex 主 pane、右侧 tree pane 和其他 pane 都执行 `select-pane` 再调用 paste helper，没有尊重目标应用的鼠标接收模式，也没有给侧栏单独的策略。

实测：接收鼠标的测试应用收到右键 release 和 `SYNTHETIC_PASTE` 文本，却没有收到右键 press。右键被替换成粘贴，并产生不配对的鼠标事件。

因此，右键点到侧栏也会夺走主 pane 的键盘焦点；后续键盘输入由侧栏处理。这个行为比只在主输入框中提供粘贴更广。

修复方向：明确主应用和侧栏的右键/中键策略；应用已请求鼠标时保留完整 press/release 序列，侧栏不应默认成为剪贴板输入目标。

## 3. P2：粘贴文本会执行侧栏快捷键，已复现右键关闭侧栏

位置：`src/utils/workbench-input.ts:30`、`:47`；`src/tree-page.ts:230`。

侧栏逐字把输入映射为快捷键，没有 paste 状态。即使送入 bracketed paste 序列，`ESC[200~` / `ESC[201~` 也只是被跳过，中间文字仍然会被解释为按键。

两层验证：

- decoder 输入 `ESC[200~qESC[201~`，输出 `{type:'key', key:'close'}`。
- 启动实际 `dist/tree-page.js`，将隔离 tmux buffer 设为 `q`，注入侧栏坐标的右键事件。侧栏从 alive=True 变成 alive=False。

其他文本也可能触发 `x` 关闭区域、数字切换区域、`s` 排序、`o` 尝试导航等动作；导航另有自身验证，不代表任意粘贴都能成功切换 Codex。

修复方向：侧栏主动识别粘贴边界，在非文本编辑界面忽略粘贴内容；同时修复上游右键把剪贴板送进侧栏的问题。仅忽略 wrapper 字符串不够。

## 4. P2：全局 root 绑定覆盖其他 tmux 会话的键鼠配置

位置：`bin/codex-hud:631`、`:644`、`:669`；`:943`。

`bind-key -T root` 修改整个 server 的表。条件分支只决定绑定执行时怎么办，并没有保存和恢复安装前的绑定；非 HUD 分支写死了作者设想的默认行为。退出 HUD 后也没有恢复。

实测：安装前自定义 F12 为 `display-message CUSTOM_F12`；安装后全局只剩 HUD 的条件绑定，非 HUD 会话落入 `send-keys F12`，原自定义动作丢失。右键原有 tmux 菜单/用户动作同样被硬编码粘贴覆盖。

`CODEX_HUD_MOUSE=0` 只切换 session 的 mouse 选项，安装 input policy 仍然是无条件的，不能用于避免对其他 session 的全局绑定修改。

修复方向：会话专属 key table，或保存并委托原绑定、明确处理多个 HUD 实例及退出恢复。避免每个实例互相覆盖全局 root 表。

## 测试盲区与复现

原 `tests/integration/test-input-passthrough-real-tmux.sh:46` 自己定义一份绑定；`:67` 仅检查 list-keys 是否含 `send-keys -t= -M`。它没有发送真正的滚轮事件。因此既没测应用不接收鼠标时的行为，也没验证当前 wrapper 函数。这解释了原测试全绿与用户实际滚轮失效可以同时发生。

新增复现脚本运行命令：

```bash
npm run build
python3 docs/reviews/reproduce-input-2026-09-21.py
```

脚本输出上述四项实际观察。右键测试用临时 paste helper 转发合成 tmux buffer，刻意绕开真实系统剪贴板；事件绑定取自产品代码，侧栏是实际编译产物。

另有一个较低优先级的纯函数边界：compact HUD 的 `tmuxForwardKeyArgs` 仅按整个 Buffer 的前缀判断鼠标报告；鼠标+键盘合包时键盘会一起丢弃，键盘+鼠标合包时鼠标字节又会一起转发。已在函数层复现，但尚未证明当前 compact pane 的终端模式会实际收到这种混合包，不把它算作上述已确认用户路径。

回归测试通过真实 PTY 注入事件并检查目标程序/模式，不能只比较绑定文本。

通用数据读取问题另见 [CodeGraph 与数据链路报告](2026-09-21-codegraph-review.md)。
