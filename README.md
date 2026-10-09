# WhoAmI OS · 本地最小版

WhoAmI OS 将用户确认的个人信息默认保存在**本机独立目录**，用户也可以自己选择其他目录，并按当前任务和授权提供给 AI。它包含人物模型规则（`core/`）、本地记忆模块（`lib/`）、交互工作流（`skills/`）和首个 Codex 接入（`adapters/`）。Skill 是入口，不是整个产品。

这个版本以 **YAML 作为唯一的结构化数据源**：事件、人物判断、清单和授权各有自己的 YAML 文件。`AGENT.md` 是从获准长期记录生成的可读摘要，可以重建，不能反向覆盖 YAML。真实个人资料必须放在通用代码仓库外。

## 运行

需要 Ruby 2.6+；没有外部软件包依赖。macOS 和 Linux 可直接运行 `bin/whoami`，Windows PowerShell 使用 `ruby .\bin\whoami`。

```sh
bin/whoami location
bin/whoami init
bin/whoami status
bin/whoami open
bin/whoami recall --domain career --purpose personal-context --task-id current-task
```

macOS 默认目录是 `~/Library/Application Support/WhoAmI/personal-memory`；Windows 默认目录是 `%LOCALAPPDATA%\WhoAmI\personal-memory`（通常在当前用户的 `AppData\Local` 下）；Linux 默认目录是 `${XDG_DATA_HOME:-~/.local/share}/whoami/personal-memory`。实际路径用 `location` 查看。所有命令都可以用 `--memory "自选目录"` 覆盖默认位置；已有资料不会自动搬迁。`location` 不会创建文件，`init` 只接受不存在或空目录，绝不覆盖现有记忆。`open` 返回经权限和版本检查的摘要；`recall` 返回获准的相关记录与来源 ID，`evidence --id ... --task-id ...` 在获准时展开来源。普通任务不必召回领域记录。

`grants` 列出当前授权。需要收回某项许可时，把 `{ "changes": [{ "change_id": "chg-revoke", "op": "revoke_grant", "target_id": "grant-..." }] }` 交给 `prepare`，预览并确认后再 `apply`。撤销授权会立即使相关摘要失效，但不会删除原记录；删除内容请用 `forget`。

写入分两步。把候选 JSON 送给 `prepare`；把返回的逐项 `preview` 给用户看。用户确认**当前**预览后，才将原样 proposal 送给 `apply`，并传入其 `patch_hash`。若只确认一部分，用 `selected_change_ids` 重新 `prepare` 和展示。改动或版本变化会使旧预览失效。

```sh
bin/whoami prepare < candidate.json > proposal.json
bin/whoami apply --approval-hash PATCH_HASH < proposal.json
```

候选格式（以下全是虚构资料，`confirmation_id` 必须来自实际确认流程）：

```json
{
  "changes": [
    {
      "change_id": "chg-001",
      "op": "add_event",
      "record": {
        "id": "evt-001",
        "statement": "最近在评估职业方向",
        "recorded_at": "2026-10-08",
        "occurred_at": "2026-10-08",
        "domains": ["career"],
        "recall_policy": "allowed"
      },
      "grants": [{
        "actions": ["persist", "recall", "send"],
        "purpose": "personal-context",
        "recipient": "codex-local",
        "task_id": "*",
        "until_revoked": true,
        "confirmation_id": "本次用户确认回执"
      }]
    },
    {
      "change_id": "chg-002",
      "op": "add_record",
      "record": {
        "id": "rec-001",
        "kind": "state",
        "dimension": "goals",
        "statement": "正在评估下一步职业方向，尚未决定",
        "domains": ["career"],
        "evidence_ids": ["evt-001"],
        "recall_policy": "allowed",
        "review_after": "2026-11-08"
      },
      "grants": [{
        "actions": ["persist", "recall", "send"],
        "purpose": "personal-context",
        "recipient": "codex-local",
        "task_id": "*",
        "until_revoked": true,
        "confirmation_id": "本次用户确认回执"
      }]
    }
  ]
}
```

状态变化使用 `supersede` 和新记录；先前理解错误使用 `retract`；用户要求删除使用 `forget`。后两者会处理依赖记录和摘要。`recover` 检查中断的多文件更新。具体字段和限制见 [schema](core/schema.md)，产品目标与验收依据见 [设计总览](design/README.md)。

Windows PowerShell 示例：

```powershell
ruby .\bin\whoami location
ruby .\bin\whoami init
ruby .\bin\whoami status
# 自选目录示例
ruby .\bin\whoami init --memory "D:\My Data\WhoAmI"
```

## 接入边界

`skills/who-am-i/SKILL.md` 是 Codex 的交互说明，`bin/whoami` 执行确定性的本地校验。当前仅支持 `codex-local`，需要宿主把真实用户确认与 `patch_hash` 对应起来；CLI 本身无法辨别是谁输入了哈希。拥有个人目录直接读写权限的其他程序也不受 OS 授权层约束。这个版本没有后台同步、自动扫描聊天、自动 Git 提交或完整迁移器。Windows 的默认路径和读写分支已有代码检查与模拟测试，但尚未在 Windows 实机验证断电恢复；目录同步保证与 macOS/Linux 不同。

可运行回归测试：

```sh
ruby -I lib test/os_test.rb
```
