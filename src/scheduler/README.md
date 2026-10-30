# 调度层

`window.js` 按本机日历判断时段；`controller.js` 管理 05:00–07:00 生成与取消；`executor.js` 使用独立 worker event loop。审核、提交、压缩和重读可以在窗口外执行。

负责休息时段、时区、任务排队、single-flight 与取消。

- 没有新材料时跳过；不要仅按日期判断是否需要造梦。
- 将耗时工作交给独立 worker / 子进程；仅用 async 并不意味着脱离主 event loop。
- 插件卸载时停止调度并取消工作；锁要考虑崩溃恢复，不只检查 PID。
- 休息时间与时区未来通过插件 Config 配置，不硬编码用户的本机路径。
