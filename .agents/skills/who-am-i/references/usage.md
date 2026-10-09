# 本地操作契约

需要 Ruby 2.6+。从本 Skill 文件夹用 `ruby scripts/whoami` 调用；Windows PowerShell 用 `ruby .\scripts\whoami`。所有操作都可用 `--memory "自选目录"` 覆盖默认个人目录。`location` 只显示路径；`init` 才创建新目录，且不会覆盖已有内容。

```text
location            显示本机默认或自选的个人目录
init                初始化空目录
status              查看模型版本与记录数
open                读取经校验且获准的长期摘要
recall              按 --domain、--purpose、--task-id 读取相关记录
evidence            按 --id、--purpose、--task-id 读取获准来源
grants              查看授权
prepare             从标准输入读取候选 JSON，返回预览和 patch_hash
apply               从标准输入读取完整 proposal，需 --approval-hash
recover             恢复中断的受控写入
```

候选格式示例（内容和确认回执均为虚构）：

```json
{
  "changes": [
    {
      "change_id": "chg-example-source",
      "op": "add_event",
      "record": {
        "id": "evt-example",
        "statement": "正在评估职业方向",
        "recorded_at": "2026-10-08",
        "domains": ["career"],
        "recall_policy": "allowed"
      },
      "grants": [{
        "actions": ["persist", "recall", "send"],
        "purpose": "personal-context",
        "recipient": "codex-local",
        "task_id": "*",
        "until_revoked": true,
        "confirmation_id": "fictional-confirmation"
      }]
    },
    {
      "change_id": "chg-example-record",
      "op": "add_record",
      "record": {
        "id": "rec-example",
        "kind": "state",
        "dimension": "goals",
        "statement": "尚未决定下一步职业方向",
        "recorded_at": "2026-10-08",
        "domains": ["career"],
        "evidence_ids": ["evt-example"],
        "recall_policy": "allowed"
      },
      "grants": [{
        "actions": ["persist", "recall", "send"],
        "purpose": "personal-context",
        "recipient": "codex-local",
        "task_id": "*",
        "until_revoked": true,
        "confirmation_id": "fictional-confirmation"
      }]
    }
  ]
}
```

把 JSON 交给 `prepare` 后，必须展示返回的逐项预览。用户只确认一部分时，以选中的 `selected_change_ids` 再执行一次 `prepare`。只有本轮用户确认了**当前**预览，才把原样 proposal 交给 `apply --approval-hash PATCH_HASH`。程序会检查模型版本、内容哈希和关联依赖；旧预览不能复用。

`supersede` 用新记录表达真实变化；`retract` 撤回误读；`forget` 删除指定记录及依赖内容；`revoke_grant` 只收回授权、不删原记录。读取授权与保存授权分开。CLI 无法独立证明是谁输入了确认哈希，这一步由宿主交互负责。

本地记录以 YAML 为权威来源，`AGENT.md` 是可重建的摘要。默认数据目录在 macOS 为 `~/Library/Application Support/WhoAmI/personal-memory`，Windows 为 `%LOCALAPPDATA%\WhoAmI\personal-memory`。目录不在本 Skill 里。Windows 的断电级恢复尚未经过实机验证。
