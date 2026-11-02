# Pi Collaborate

独立的 Codex ↔ Pi 通信插件。Codex 向**已经运行的 Pi 会话**派发任务；Pi 在原终端执行并通过 Codex app-server 发回消息。无需 pi-intercom，不启动子代理，不修改 Codex 源码。

入站消息以独立卡片显示来源、类型和正文预览，使用 Pi 的展开快捷键查看全文及关联信息。忙碌时默认 steer，可选择 followUp。每个 Pi 同时执行一个任务；一个 Codex 可协调多个 Pi，一个 Pi 同时绑定一个 Codex。

## 安装

支持 macOS/Linux、Node.js >=22.19、Pi >=1.2。使用 Node 自带 SQLite；较早的 Node 22 可能打印实验性接口提示。Codex 需启动 app-server，协调会话也必须由同一服务承载。已验证协议版本为 Codex 0.166.0。

```bash
cd /path/to/pi-collaborate-plugin
npm install --omit=dev --legacy-peer-deps
pi install /absolute/path/to/pi-collaborate-plugin
```

随后启动 Pi，或在已有会话 `/reload`。Pi 从 package manifest 加载扩展与共享 skill。只安装 skill 不会启动通信。

Codex 可直接调用 `node /absolute/path/to/pi-collaborate-plugin/bin/pi-collab.mjs`；也可用 `npm link` 将 `pi-collab` 加入 PATH。将 `skills/pi-collaborate` 加入 Codex 的 skills 搜索目录，两端读取同一份说明。安装本插件不会自动卸载旧插件或修改旧 skill。

旧版 skill 同样名为 `pi-collaborate`：切换时应让 Codex 的该入口指向本插件的 `skills/pi-collaborate`，避免同时发现两份同名 skill。原文件可备份，但不要继续将旧版 ask/stdout 流程用于新插件。

## 第一次协作

以下命令在 Codex 工具中运行；若在普通终端运行，用 `--thread <Codex会话ID>` 代替环境变量。

```bash
pi-collab list
pi-collab bind --pi <Pi会话ID> --thread "$CODEX_THREAD_ID" --request-id bind-1
pi-collab start --pi <Pi会话ID> --request-id task-1 --text '只读检查当前变更，报告验证证据'
pi-collab send --task <返回的taskId> --request-id correction-1 --text '同时检查边界条件'
pi-collab inbox
pi-collab read --message <messageId>
pi-collab reply --question <questionId> --request-id answer-1 --text '保持只读，不修改文件'
pi-collab result --task <taskId>
pi-collab ack --task <taskId> --version 1 --request-id collect-1
```

`pi-collab --help` 给出全部命令。所有输出均为 JSON。`--text-file` 支持文件输入。修改命令最好显式指定 requestId；省略时会先在 stderr 输出生成的 ID，以便提交中断后用相同 ID 和正文重试。

Pi 使用 `collaborate` 的 send/ask/reply/report/read/ack；`/collaborate` 查看绑定及收件箱。普通助手输出不转发。任务结果只有显式 report completed/failed/cancelled 才会提交。来源始终取绑定记录，而不取消息正文。

## 持久性与恢复

SQLite 位于 `~/.pi/agent/collaborate/state.sqlite3`；设置 `PI_COLLAB_HOME` 可改位置，或使用 `$PI_CODING_AGENT_DIR/collaborate`。CLI `--home` 可针对非默认目录。数据目录 0700，数据库与本地 Unix socket 0600。它是同一操作系统用户之间的协作工具，不是权限隔离或身份认证系统。

CLI 查询以只读方式打开已有数据库，在线修改交给 Pi 的 IPC 接口。Codex 沙箱需允许访问该 Unix socket；离线 ack/send/reply 和手动清理需要数据库目录写权限，必要时由宿主申请该次权限，或将 `PI_COLLAB_HOME` 设为双方可访问的目录。插件不会修改 Codex 沙箱配置。

- taskId、questionId 和 messageId 分开；普通 send 不推断成 reply。
- 等待默认 10 分钟，超时不取消任务、不关闭问题、不删除结果；可以随时读取已保存结果。
- 结果、任务终态、通知在同一数据库事务提交。app-server 不可用时保留待通知消息，退避重连；通知成功不等于收取。
- read 不 ack；ack 代表收取，不代表验收通过，不会删除结果。继续修改用 continue 创建下一轮次和结果版本。
- 相同 requestId、相同内容不重复派发；内容不同返回 REQUEST_CONFLICT。
- app-server 请求发出后丢失响应会记为 unknown；插件查询会话记录确认是否已提交，不能确定时不盲目重发。检查后显式 retry；无执行或通知“恰好一次”保证。
- 需要权限审批等交互时仍由 Codex UI 处理；`/collaborate` 可显示待交互诊断，插件不会自动批准操作。应保留对应 Codex 前端在线。
- Pi 重载/退出后，进行中的任务恢复为 unknown，不自动重跑。Codex 可在 Pi 离线时读取/确认结果；send/reply 可落盘等待原 session 恢复，新 start/bind 要求 Pi 在线。
- followUp 在 Pi 空闲且没有待处理输入时才投递；steer 不主动 abort 现有工具。取消命令也是请求，Pi 显式 report cancelled 才是停止证据。
- 相同 Pi session 不能同时由两个实例持有。新会话不继承绑定；resume 原会话恢复其数据。
- 请求去重保留精简 tombstone；清理过的 requestId 不会再次启动工作。关闭 Pi 后不另留后台 daemon。

## 配置与自动清理

可选的 `$PI_COLLAB_HOME/config.json`（默认对应上述目录）：

```json
{
  "autoCleanup": true,
  "taskRetentionDays": 30,
  "eventRetentionDays": 7
}
```

启动时和每小时清理。只有终态、全部结果和消息均已明确收取、无开放问题的任务，才会在最后收取满 30 天后删除。已确认普通通知保留 7 天；未收取结果、未回答问题、进行中/受阻/unknown 任务不自动清除。精简 requestId tombstone 保留，用于阻止过期请求重新执行。SQLite 会重用释放的页，不在每次清理时自动 VACUUM。

```bash
pi-collab prune --dry-run    # 默认就是预览
pi-collab prune --apply      # 按保留策略执行
```

`autoCleanup:false` 关闭自动清理；手动 prune 仍可执行。默认 app-server socket 为 `$CODEX_HOME/app-server-control/app-server-control.sock`，可用 `PI_COLLAB_CODEX_SOCKET` 指定已有本地 Unix WebSocket 服务。

## 验证

```bash
npm run check
npm test
PI_SDK_PATH=/path/to/node_modules/@earendil-works/pi-coding-agent npm test
npm pack --dry-run
```

测试覆盖真实本地 IPC/CLI、SQLite 重开恢复、超时晚答、队列、去重、清理保护以及 Unix WebSocket 协议；可选 Pi SDK 测试通过宿主加载器验证真实卡片渲染与生命周期。协议测试使用本地假服务，不消耗模型 token。实机模型验收需安装到目标 Pi 后执行，不由安装脚本自动派发。
