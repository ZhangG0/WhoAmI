# Codex 本地接入

`skills/who-am-i/SKILL.md` 是 Codex 交互入口，`bin/whoami` 是可重复调用的本地操作界面。先在当前仓库使用 Skill；默认个人目录是 macOS 的 `~/Library/Application Support/WhoAmI/personal-memory`，`--memory` 可覆盖。只有用户希望全局发现时，才将 Skill 安装到自己的 Codex skills 目录。

接收目标固定为 `codex-local`。在使用个人内容前调用 `open` 或 `recall`，不把 `AGENT.md` 当作无条件常驻指令。新建、修改和忘记由 `prepare` 生成具体预览，再用本轮用户确认的摘要调用 `apply`。

这份接入不创建后台服务，不自动扫描聊天记录，也不自动提交、推送用户记忆。
