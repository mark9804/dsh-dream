# 给 Codex / 后续开发 Agent

## 目标与现状

DSH-Dream 是 DeepSeek Harness（DSH）的 Host 插件，不是独立 agent harness。
它在休息时段整理陪伴型 agent 的记忆；梦境不是事实，真实记忆变更必须经过醒来审核。
已有 ESM 实现、离线测试和合成演示；2026-10-27 已通过授权隔离副本的真实 Host 全流程。2026-10-28 用户授权迁移 TypeScript、重新实测，并以 npm registry 作为后续分发渠道。插件声明默认禁用，配置后才可启用；实际公开发布须确认包名、版本、许可与公开范围。

## 阅读顺序

1. [README.md](README.md)：用户目标、已定约束和未决问题。
2. [开发总览](docs/development.md)：现状、目录与验证命令。
3. [Harness 接入手册](docs/harness-integration.md)：首次开发必读；介绍 Context、生命周期、API 查证和安装。
4. 按任务加载 [数据与执行协议](docs/dream-contracts.md) 或 [里程碑与验收](docs/implementation-plan.md)。
5. [交接任务提示](docs/codex-handoff.md) 给出首次执行的建议范围。

## 必须守住的边界

- 原始 README 的“已定”优先于后续文档的建议；遇到冲突先提出，不静默改需求。
- 先做离线、合成数据和 dry-run；不得把用户真实记忆当测试夹具，不读取凭证或复制个人日记进仓库。
- 未审核、拒绝、暂缓和过期提案均不得应用；梦境、模型置信度不是事实来源。
- 不自动改称呼与红线，不删除真实记忆；淘汰先归档，真正删除另需用户确认。
- 不直接改 DSH profile、会话日志或数据库，不绕过沙箱或审批。
- 不猜 Host Service / Event API；未查证的适配器保持 unavailable，不能伪装成成功。
- 不因读到本文就安装插件、启动定时任务、调用付费模型或开启真实写入；这些属于后续明确授权的集成阶段。
- `async` 不等于独立 event loop；独立执行器和 Host 控制面分开设计。

## 工作方式

按本次明确授权范围推进；当前用户已授权完整插件实现，M0–M5 只用于组织开发。先读现有文件和 Git 状态，保留其他人的更改。
运行时源码使用严格 TypeScript，编译到 dist/ 的原生 ESM JavaScript 和声明文件；保持零运行时依赖。测试与开发脚本可用 JavaScript。类型检查不能替代外部数据的运行时校验。
TypeScript 与 Node 类型仅作为开发依赖；新增其他依赖或 UI 前先说明必要性。依赖 Harness 的代码集中在 `src/harness/`。
所有计时、文件、模型和 Host 边界应能替换为测试实现；单元测试不启动 Harness。

提交前运行 `npm run check`、`npm test`、`git diff --check`。
check 覆盖源码、测试与脚本；测试记忆、状态和备份只能生成在仓库 tests/ 内，运行产物使用已忽略的 tests/.tmp/。不得借测试读取真实记忆。
汇报：改了什么、执行了哪些验证、还有哪些接口/真实运行未验证。不要把 mock 通过说成 DSH 集成成功。
