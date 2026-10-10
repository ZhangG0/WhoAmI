# WhoAmI OS V1 文件约定

真实个人资料放在默认或用户选定的独立目录。`manifest.yaml` 记录版本、ID、每条记录的路径、领域、权限路由字段与内容哈希；`policy.yaml` 记录用户确认的授权；`timeline/<记录年份>/<事件ID>.yaml` 记录来源；`model/<维度>/<判断ID>.yaml` 记录判断；`AGENT.md` 是可重建的派生摘要。

YAML 由 JavaScript 的 `yaml` 依赖安全解析：不接受别名、自定义对象或符号。记录字段中的日期使用引号包裹的 `YYYY-MM-DD` 字符串，缺失日期为 `null`。事件与判断每个文件各保存一个对象。判断的 `evidence_ids` 指向事件，`derived_from` 指向其他判断，`supersedes` 表示真实变化。更正用 `retracted`，不能伪装成历史变化。

授权至少包含 `actions`、`purpose`、`recipient: codex-local`、`task_id`、`expires_at` 或 `until_revoked: true`，以及本轮确认的 `confirmation_id`。`recall_policy: never` 永不用于召回；`ask` 只有匹配的授权才可读。摘要需单独授权 `summary` 与 `send`，并经来源哈希、版本和状态检查后返回。

本地 V1 使用受控单写入者和同目录恢复日志。真实数据目录的 `.transactions/` 与 `.lock` 被排除出 Git；OS 不会自动创建 Git 提交或远端备份。

## 候选分类、证据与确认

四个轴分开处理：维度表示“关于哪方面”，kind 表示“何种判断”，证据等级表示“依据类型”，confirmation_status 表示“是否经过保存确认”。用户确认保存不意味着推断已经被证实。

| 字段 | 新记录的约定与校验 |
| --- | --- |
| kind | fact 为直接陈述（例如用户明确自述的偏好）；state 为短期处境/情绪/目标；interpretation 为 AI 解释；pattern 为多事件支持的倾向。 |
| source | 事件来源为 self_report、document、ai_output；资料来源必须有 reference。已有 user_statement 未填写时兼容为 self_report，不能用此默认值伪装 AI 输出。只填写真实存在的定位或原话。 |
| evidence_ids / derived_from | fact、state、pattern 必须引用事件；interpretation 必须有事件或模型记录依据。AI 输出不能支持直接自述或充当模式的独立证据。 |
| statement_origin | 程序根据来源及 kind 生成 direct_report / ai_inference 或事件来源类型；direct_report 表示有直接来源，不表示内容客观属实。 |
| evidence_level | 直接来源为 E1，interpretation 为 E0，pattern 为 E2；模式仍需至少三个不同事件 ID、跨两个日期。AI 要核对是否确为独立事件，程序不会理解语义上的重复。 |
| confidence / confidence_reason | 默认 null（未评估）；若填写 low/medium/high，必须说明支持证据、适用情境和限制。程序只校验枚举与理由存在，不证明该评价正确，不计算概率或画像成熟度。 |
| confirmation_status | prepare 预览为 pending；候选不能自称 confirmed 或携带 confirmed_at/confirmation_ids。apply 成功时才生成 confirmed、confirmed_at 及授权回执 ID。宿主仍负责核实真实用户确认。 |
| valid_from / valid_to / review_after | 已知才填；有效期开始不能晚于结束。review_after 表示应复查，不是事实已相反。state 不可进入长期摘要。 |

新校验适用于新增候选；旧记录不会被静默改写或强行补齐。召回时旧记录缺失的证据/可信度返回 null，确认状态为 legacy_unknown，需要时通过用户复核，不代表旧记录已被否认。修改已确认候选后必须重新 prepare。认知成熟度与 11 维模型尚未实现。
