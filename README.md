# WhoAmI OS · 本地最小版

WhoAmI OS 用 YAML 保存经用户确认的个人信息，并按当前任务和授权提供给 AI。产品逻辑仍分为 Core（规则）、Memory（记录与读写）、Skills（访谈与更新）和 Adapters（宿主接入）；**当前可安装的发行单位是一个完整的 `who-am-i` Skill 文件夹**，其中包含第一版所需的运行模块。Skill 是 OS 的入口和打包方式，不等于全部产品设计。

```text
skills/who-am-i/
├── SKILL.md                 # Codex 交互入口
├── scripts/
│   ├── whoami               # 本地命令
│   └── whoami_os.rb         # YAML、授权、事务与恢复
└── references/
    ├── usage.md             # 命令及候选数据格式
    └── schema.md            # 人物记录与授权约定
```

复制整个 `skills/who-am-i/` 文件夹即可迁移这一版的 Codex Skill；**只复制 `SKILL.md` 不够**。运行需要本机 Ruby 2.6+，没有额外软件包依赖。首次使用可先运行 `scripts/whoami location` 查看个人数据目录，再执行 `init`。Windows PowerShell 使用 `ruby .\scripts\whoami location`。详细命令和虚构示例见 [使用契约](skills/who-am-i/references/usage.md)。

真实个人资料始终在安装包外：macOS 默认是 `~/Library/Application Support/WhoAmI/personal-memory`，Windows 默认是 `%LOCALAPPDATA%\WhoAmI\personal-memory`，也可通过 `--memory` 指定其他目录。移动 Skill 文件夹不会移动个人资料；迁移到另一台电脑时，须由用户另行带上资料目录并重新指定路径。OS 不会自动扫描聊天、提交 Git 或同步远端。

`design/` 是产品设计与图解，`test/` 是开发测试，两者不需要随 Skill 安装。[设计总览](design/README.md) 是完整设计基线；当前仅有 Codex 本地入口，其他宿主仍需适配。Windows 的断电级恢复尚未经过实机验证。

在仓库内运行回归测试：

```sh
ruby -I skills/who-am-i/scripts test/os_test.rb
```
