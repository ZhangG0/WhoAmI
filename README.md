# WhoAmI OS · 本地最小版

WhoAmI OS 用 YAML 保存获准的个人信息和有依据的独立观察，并按当前任务和授权提供给 AI。产品逻辑仍分为 Core（规则）、Memory（记录与读写）、Skills（访谈与更新）和 Adapters（宿主接入）；**当前可安装的 `who-am-i` Skill 包位于仓库的 `skill/` 目录**，其中包含第一版所需的运行模块。Skill 是 OS 的入口和打包方式，不等于全部产品设计。

```text
WhoAmI/
└── skill/                   # 完整的可安装 Skill 包
    ├── SKILL.md             # Codex 交互入口
    ├── package.json         # Node.js 依赖说明
    ├── package-lock.json    # 固定依赖版本
    ├── scripts/
    │   ├── whoami.js        # 本地命令
    │   └── whoami_os.js     # YAML、授权、事务与恢复
    └── references/
        ├── usage.md         # 命令及候选数据格式
        └── schema.md        # 人物记录与授权约定
```

## 安装与使用

仓库中的 `skill/` 是独立安装单位。在其他电脑的 Codex 中可提出：

```text
用 $skill-installer 安装 https://github.com/ZhangG0/WhoAmI/tree/main/skill
```

安装器会取得**整个 Skill 包**并放入本机的 Skill 搜索目录，Codex 随后发现它；用户不必手工复制文件夹。这是独立 Skill 的本地安装方式，不是插件目录发布。运行需要本机 Node.js 20+。Skill 安装器只安装文件，不会自动安装 npm 依赖；首次使用前在安装后的 Skill 目录执行 `npm ci --omit=dev`。

安装完成后，在新对话中发送 `$who-am-i 帮我建立个人模型`，这是最明确的首次触发方式。也可以直接说“帮我建立个人画像”或“让 AI 认识我”；Codex 会根据 Skill 的描述尝试自动选用。仓库中的 `skill/` 只是待安装的包，不在 Codex 的仓库自动发现目录中；安装之前不能只靠这句话触发。

首次使用可在安装包内运行 `node scripts/whoami.js location` 查看个人数据目录，再执行 `init`。Windows PowerShell 使用 `node .\scripts\whoami.js location`。详细命令和虚构示例见 [使用契约](skill/references/usage.md)。

真实个人资料始终在安装包外：macOS 默认是 `~/Library/Application Support/WhoAmI/personal-memory`，Windows 默认是 `%LOCALAPPDATA%\WhoAmI\personal-memory`，也可通过 `--memory` 指定其他目录。移动 Skill 文件夹不会移动个人资料；迁移到另一台电脑时，须由用户另行带上资料目录并重新指定路径。OS 不会自动扫描聊天、提交 Git 或同步远端。

`design/` 是产品设计与图解，`test/` 是开发测试；它们位于 Skill 包外，不随 `skill/` 安装。[设计总览](design/README.md) 是完整设计基线；当前仅有 Codex 本地入口，其他宿主仍需适配。Windows 的断电级恢复尚未经过实机验证。

在仓库内运行回归测试：

```sh
node --test test/os_test.js
```

当前访谈采用四问极简初始化，只有称呼必需；八个维度按相关任务逐步探索。候选证据及确认校验、渐进补充与持续校准规则随 Skill 一同安装，详见 [认识与校准工作流](skill/references/workflow.md)。


## 保存许可与独立观察

默认逐次确认；用户可明确授权特定范围内的非敏感观察，此后新增记录不必逐条询问。保存许可、证据支持与用户认同分别记录：用户不同意时保留原判断和反馈，赞同也不会把推断变成事实。敏感内容、覆盖、删除、新授权和用户态度反馈仍走预览确认。

持续授权可撤销或到期；其派生记录随之停止召回，原文保留。它不赋予跨应用监听或后台收集能力。详见 [操作示例](skill/references/usage.md) 和 [字段约定](skill/references/schema.md)。新数据清单为 v2；新版兼容读取 v1，首次成功写入升级清单，共享该目录的旧版 Skill 会拒绝读取 v2，需要一并更新。
