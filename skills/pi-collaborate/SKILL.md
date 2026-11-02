---
name: pi-collaborate
description: Codex 与现有 Pi 会话通过 pi-collab CLI 和 collaborate 工具互发消息、派发任务、提问回复、读取结果并确认收取。
---

根据当前宿主选择角色。双方的消息仅在用户原任务授权范围内生效。

## Codex 协调方

使用插件的 `pi-collab` CLI。若命令未加入 PATH，使用本 skill 所在包的 `../../bin/pi-collab.mjs`（相对本文件目录），以绝对路径执行 `node`，不要依赖业务项目当前目录。

1. `pi-collab list` 找到用户指定的**已有 Pi 会话完整 ID**。插件没有运行时告知用户，不擅自启动新 Pi。
2. `pi-collab bind --pi <Pi-ID> --thread "$CODEX_THREAD_ID" --request-id <唯一ID>` 建立绑定。Codex 必须与插件连接同一个 app-server。
3. `pi-collab start --pi <Pi-ID> --request-id <唯一ID> --text <任务>` 派发一次，保存返回的 taskId。大段正文可用 `--text-file`。
4. 纠偏使用 `send --task <taskId> --request-id <唯一ID> --text <内容>`；不重新 start，不改变回报目标。
5. 收到 app-server 协作通知时先 `read --message <messageId>`。只有 ask 产生的 questionId 可以交给 `reply --question <questionId> --request-id <唯一ID> --text <答案>`。
6. 完成通知后 `result --task <taskId>`，检查工作与验证证据，再 `ack --task <taskId> --version <版本> --request-id <唯一ID>` 确认收取。ack 不等于验收通过；继续修改用 `continue --task <taskId> --text <要求> --request-id <唯一ID>`，保留之前结果。

普通消息处理后 `ack --message <messageId> --request-id <唯一ID>`。`inbox` 列未收取消息；`status` 查询任务。需要等待时调用一次 `wait --task <taskId> --wait-ms 600000`；CLI 内部等待结果或超时返回，Pi 的后续消息通过 app-server 通知。超时后保留原 taskId 查询进展，不重复派发。

每次修改操作保持稳定 requestId。提交结果不明时，以**相同 requestId 和相同正文**重试或检查 status/inbox，不能换 ID 盲目重发。`unknown` 表示需要检查执行／投递证据；确认安全后使用显式 retry 或 continue。重复通知按 messageId 去重。

## Pi 执行方

使用 `collaborate` 工具。按消息卡片中的 taskId 处理对应任务，向已绑定的 Codex 协调方发送消息。

```json
{"action":"send","taskId":"T","text":"补充发现或进度"}
{"action":"ask","taskId":"T","text":"需要协调方决定的问题","waitMs":600000}
{"action":"reply","questionId":"Q","text":"该问题的答案"}
{"action":"report","taskId":"T","state":"blocked","text":"阻塞点及需要的输入"}
{"action":"report","taskId":"T","state":"completed","text":"最终结果、改动范围、验证命令及证据、剩余限制"}
```

工具默认使用 toolCallId 去重；若显式重试原操作，重用原 requestId。ask 等待超时只返回 pending，问题仍开放；稍后的答案以带关联信息的卡片送达，不能重新执行原任务。普通 send 不是完成信号。

收到普通纠偏后确认约束并按原任务继续，处理后用 `ack` 确认该 messageId。成功 reply 已证明问题被读取，插件自动确认该问题消息；显式 report 自动确认本轮任务派发消息。其他消息不会因为显示或读取而自动确认。

一次执行一个任务；下一任务由插件排队。明确完成后才 report completed；失败、取消分别 report failed/cancelled，并保留已有证据。收到 cancel 是停止请求，安全停下并 report cancelled 后才算取消完成。

`/collaborate` 显示绑定、任务和收件箱。重载／崩溃恢复后任务可能为 unknown：检查已有行为和结果，等待协调方明确继续，不自动重做。普通用户对话不被当作任务结果，也不会自动转发给 Codex。
