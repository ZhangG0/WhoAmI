# WhoAmI OS V1 文件约定

真实个人资料放在默认或用户选定的独立目录。`manifest.yaml` 记录版本、ID、每条记录的路径、领域、权限路由字段与内容哈希；`policy.yaml` 记录用户确认的授权；`timeline/<记录年份>/<事件ID>.yaml` 记录来源；`model/<维度>/<判断ID>.yaml` 记录判断；`AGENT.md` 是可重建的派生摘要。

YAML 由 JavaScript 的 `yaml` 依赖安全解析：不接受别名、自定义对象或符号。记录字段中的日期使用引号包裹的 `YYYY-MM-DD` 字符串，缺失日期为 `null`。事件与判断每个文件各保存一个对象。判断的 `evidence_ids` 指向事件，`derived_from` 指向其他判断，`supersedes` 表示真实变化。更正用 `retracted`，不能伪装成历史变化。

授权至少包含 `actions`、`purpose`、`recipient: codex-local`、`task_id`、`expires_at` 或 `until_revoked: true`，以及本轮确认的 `confirmation_id`。`recall_policy: never` 永不用于召回；`ask` 只有匹配的授权才可读。摘要需单独授权 `summary` 与 `send`，并经来源哈希、版本和状态检查后返回。

本地 V1 使用受控单写入者和同目录恢复日志。真实数据目录的 `.transactions/` 与 `.lock` 被排除出 Git；OS 不会自动创建 Git 提交或远端备份。

## 候选分类、证据与确认

维度与 kind 表示内容分类；保存许可（storage_authorization）、证据支持（evidence_level 与 confidence）、用户态度（user_alignment）三个轴独立。用户允许保存不意味着赞同，赞同也不证明推断属实。

| 字段 | 新记录的约定与校验 |
| --- | --- |
| kind | fact 为直接陈述（例如用户明确自述的偏好）；state 为短期处境/情绪/目标；interpretation 为 AI 解释；pattern 为多事件支持的倾向。 |
| source | 事件来源为 self_report、document、observation、ai_output；资料与行为观察必须有 reference。observation 只描述可定位行为，不能用于 fact/state 的直接自述依据，可以支持 interpretation/pattern。已有 user_statement 未填写时兼容为 self_report，不能用此默认值伪装 AI 输出。只填写真实存在的定位或原话。 |
| evidence_ids / derived_from | fact、state、pattern 必须引用事件；interpretation 必须有事件或模型记录依据。AI 输出不能支持直接自述或充当模式的独立证据。 |
| statement_origin | 程序根据来源及 kind 生成 direct_report / ai_inference 或事件来源类型；direct_report 表示有直接来源，不表示内容客观属实。 |
| evidence_level | 直接来源为 E1，interpretation 为 E0，pattern 为 E2；模式仍需至少三个不同事件 ID、跨两个日期。AI 要核对是否确为独立事件，程序不会理解语义上的重复。 |
| confidence / confidence_reason | 默认 null（未评估）；若填写 low/medium/high，必须说明支持证据、适用情境和限制。程序只校验枚举与理由存在，不证明该评价正确，不计算概率或画像成熟度。 |
| storage_authorization | apply 生成 mode: explicit/standing、grant_ids、confirmation_ids、authorized_at、parent_grant_id。候选不能伪造。旧记录召回为 mode: legacy_unknown，不推测其用户认同情况。 |
| user_alignment / feedback_history | 新记录为 unreviewed；只能由 record_feedback 改为 agree/disagree/unsure，每次追加 stance、event_id、recorded_at。事件须为用户 self_report。反馈不改变 kind、证据等级或 confidence。 |
| confirmation_status | 兼容字段，不表示认同：prepare 为 pending，逐次确认保存为 confirmed，持续授权保存为 authorized；时间和回执由 apply 生成。新逻辑应读取上面三个独立轴。 |
| valid_from / valid_to / review_after | 已知才填；有效期开始不能晚于结束。review_after 表示应复查，不是事实已相反。state 不可进入长期摘要。 |

新校验适用于新增候选；旧记录不会被静默改写或强行补齐。召回时旧记录缺失的证据/可信度返回 null，确认状态为 legacy_unknown，需要时通过用户复核，不代表旧记录已被否认。修改已确认候选后必须重新 prepare。认知成熟度与 11 维模型尚未实现。

## 持续授权与版本兼容

持续授权是 policy.yaml 中 type: observation 的 grant，record_ids 为空，scope 明确 dimensions、kinds、domains、sensitivities、source_types。只能授权 persist/recall/send，不能包含 summary。sensitivities 仅 ordinary/personal；relationships 维度和 health/finance/relationships 领域不接受持续授权。来源与全部推导链也要符合范围；程序只能校验标签，宿主仍需识别语义敏感性与真实事件独立性。

自动新增会生成带 parent_grant_id 的逐记录授权，原持续授权撤销或过期会使其派生召回失效，内容不会被自动删除。expires_at 存在时优先决定到期，即使同时写有 until_revoked。授权匹配用途、接收方和任务，不允许通过一次自动写入扩大范围或创建新授权。

反馈事件加入清单 feedback_ids 并参与权限、忘记依赖检查；不同意的判断仍可按权限召回，uncertainties 标明 user_disagree/user_unsure。它不进入常驻摘要；任何摘要都标注 kind 和用户态度，不能把推断摊平成事实。反馈事件被忘记会联动删除对应判断及依赖项，预览必须展示影响。

新目录使用 schema_version: 2；新版可读取 v1，首次成功写入时在同一事务内升级清单到 v2，保留旧记录本体。旧版工具会拒绝 v2，防止忽略持续授权的父级撤销和反馈依赖。共用个人目录的其他 Skill 安装也需更新后才能继续使用。
