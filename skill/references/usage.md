# 本地操作契约

需要 Node.js 20+。首次安装后在本 Skill 文件夹运行 `npm ci --omit=dev`，再用 `node scripts/whoami.js` 调用；Windows PowerShell 用 `node .\scripts\whoami.js`。所有操作都可用 `--memory "自选目录"` 覆盖默认个人目录。`location` 只显示路径；`init` 才创建新目录，且不会覆盖已有内容。

```text
location            显示本机默认或自选的个人目录
init                初始化空目录
status              查看模型版本与记录数
open                读取经校验且获准的长期摘要
recall              按 --domain、--purpose、--task-id 读取相关记录
evidence            按 --id、--purpose、--task-id 读取获准来源
grants              查看授权
prepare             从标准输入读取候选 JSON，返回预览和 patch_hash
apply               逐次确认需 --approval-hash；持续授权提案可不传
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

默认逐次确认：把 JSON 交给 `prepare` 后展示逐项预览。用户只确认一部分时，以选中的 `selected_change_ids` 再执行一次 `prepare`。本轮用户确认了**当前**预览后，把原样 proposal 交给 `apply --approval-hash PATCH_HASH`。程序检查模型版本、内容哈希和关联依赖；旧预览不能复用。持续授权仅按下述流程例外处理。

`supersede` 用新记录表达真实变化；`retract` 撤回误读；`forget` 删除指定记录及依赖内容；`revoke_grant` 只收回授权、不删原记录。读取授权与保存授权分开。CLI 无法独立证明是谁输入了确认哈希，这一步由宿主交互负责。

本地记录以 YAML 为权威来源，`AGENT.md` 是可重建的摘要。默认数据目录在 macOS 为 `~/Library/Application Support/WhoAmI/personal-memory`，Windows 为 `%LOCALAPPDATA%\WhoAmI\personal-memory`。目录不在本 Skill 里。Windows 的断电级恢复尚未经过实机验证。

## 一次授权，范围内保存观察

先 prepare 以下授权变更，向用户解释具体范围并取得对预览的确认，再 apply --approval-hash。以下 ID 与回执仅用于演示，不能用示例值代替真实授权。

```json
{
  "changes": [{
    "change_id": "chg-observation-permission",
    "op": "authorize_observation",
    "grant": {
      "id": "grant-career-observation",
      "actions": ["persist", "recall", "send"],
      "purpose": "personal-context",
      "recipient": "codex-local",
      "task_id": "*",
      "until_revoked": true,
      "confirmation_id": "fictional-explicit-consent",
      "scope": {
        "dimensions": ["decisions", "patterns", "synthesis"],
        "kinds": ["interpretation", "pattern"],
        "domains": ["career"],
        "sensitivities": ["ordinary", "personal"],
        "source_types": ["self_report", "observation"]
      }
    }
  }]
}
```

之后 prepare 输入顶层增加 authorization，changes 只能是 add_event/add_record，不能带逐条 grants；权限从现有授权派生。候选仍需来源证据；observations 的 source.reference 必须是真实对话定位。

```json
{
  "authorization": {
    "grant_id": "grant-career-observation",
    "purpose": "personal-context",
    "recipient": "codex-local",
    "task_id": "current-career-task"
  },
  "changes": [{
    "change_id": "chg-observed-event",
    "op": "add_event",
    "record": {
      "id": "evt-observed-choice",
      "statement": "比较两个方案后，继续询问第三个选项",
      "source": {"type": "observation", "reference": "fictional-conversation:turn-8"},
      "domains": ["career"],
      "sensitivity": "personal"
    }
  }, {
    "change_id": "chg-observed-interpretation",
    "op": "add_record",
    "record": {
      "id": "rec-choice-hypothesis",
      "kind": "interpretation",
      "dimension": "synthesis",
      "statement": "本次职业选择中，可能希望先了解更多选项；尚不足以判断稳定倾向",
      "domains": ["career"],
      "evidence_ids": ["evt-observed-choice"],
      "sensitivity": "personal"
    }
  }]
}
```

把返回的完整 proposal 原样交给 apply，无需 --approval-hash。工具在提交时重新校验授权与版本；宿主成功后简短告知保存内容。不要求用户赞同该假设。超范围、敏感内容、覆盖和删除仍走逐次确认。撤销用 revoke_grant 指向 grant-career-observation，停止新增和派生召回；需要删除则用 forget。

## 单独记录用户态度

先新增一条包含用户反馈原话的 self_report 事件（与第一例一样带逐记录 grants），再在同一批或后续批次加入以下变更并预览确认：

```json
{
  "change_id": "chg-user-disagrees",
  "op": "record_feedback",
  "target_id": "rec-choice-hypothesis",
  "event_id": "evt-user-feedback",
  "stance": "disagree"
}
```

stance 为 agree/disagree/unsure。保留各次反馈、原判断及证据；用户赞同不自动增加 confidence。反馈不是持续授权可自动执行的操作。recall 返回 user_alignment、feedback_history、storage_authorization 与独立的证据字段，读取反馈原话仍用 evidence 并遵守其权限。
