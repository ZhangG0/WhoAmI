# WhoAmI OS V1 文件约定

真实个人资料放在用户选定的独立目录。`manifest.yaml` 记录版本、ID、每条记录的路径、领域、权限路由字段与内容哈希；`policy.yaml` 记录用户确认的授权；`timeline/<记录年份>/<事件ID>.yaml` 记录来源；`model/<维度>/<判断ID>.yaml` 记录判断；`AGENT.md` 是可重建的派生摘要。

YAML 由 Ruby 标准库安全解析：不接受别名、自定义对象或符号。记录字段中的日期使用引号包裹的 `YYYY-MM-DD` 字符串，缺失日期为 `null`。事件与判断每个文件各保存一个对象。判断的 `evidence_ids` 指向事件，`derived_from` 指向其他判断，`supersedes` 表示真实变化。更正用 `retracted`，不能伪装成历史变化。

授权至少包含 `actions`、`purpose`、`recipient: codex-local`、`task_id`、`expires_at` 或 `until_revoked: true`，以及本轮确认的 `confirmation_id`。`recall_policy: never` 永不用于召回；`ask` 只有匹配的授权才可读。摘要需单独授权 `summary` 与 `send`，并经来源哈希、版本和状态检查后返回。

本地 V1 使用受控单写入者和同目录恢复日志。真实数据目录的 `.transactions/` 与 `.lock` 被排除出 Git；OS 不会自动创建 Git 提交或远端备份。
