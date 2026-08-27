---
title: "第73章 底层调试武器库：Perfetto / logcat / adb 进阶"
part: "[[P7-MOC]]"
chapter: 73
tags:
  - domain/android
  - topic/debugging
  - topic/perfetto
difficulty: 3
est_minutes: 35
prerequisites:
  - "[[ch72-A-B-OTA升级与Recovery体系]]"
related:
  - "[[ch16-perf-ftrace-strace性能剖析]]"
  - "[[ch51a-可视化追踪Tracealyzer-SystemView]]"
  - "[[ch64-内核调试Oops解读debugfs-kdump]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第73章 底层调试武器库：Perfetto / logcat / adb 进阶

> [!info] 导航
> ⏱ 35min | ★★★☆☆ | 前置 [[ch72-A-B-OTA升级与Recovery体系]] | → [[ch74-总线与无线选型总表]]

## 🎯 学习目标
- [ ] 用 perfetto 命令行抓取全量 trace，并在泳道图上判读 CPU/binder/帧调度
- [ ] 掌握 logcat 五大缓冲区分工与优先级过滤，快速定位 native crash tombstone
- [ ] 熟练 adb 高阶用法：无线配对、端口转发、root shell、bugreport

## 73.1 logcat 缓冲区与优先级过滤

五大缓冲各司其职：main/system/crash/events/kernel。崩溃证据要靠分区隔离避免被常规日志冲掉——先看崩溃缓冲！

```bash
logcat -b crash -v threadtime      # 崩溃专用缓冲
logcat *:W                          # 只看 Warn 及以上(优先级 V/D/I/W/E/F)
logcat -b all | grep avc            # 全缓冲捞 SELinux 拒绝(ch71 联动)
```

Java crash 认准 FATAL EXCEPTION 栈 + cause 链；watchdog ANR 看 /data/anr/traces.txt，其中 "held by thread" 直接指出锁持有者。

## 73.2 关键代码：tombstone 解读入口

```text
Native crash → /data/tombstones/ 解读顺序：
*** *** signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0
backtrace:
  #00 pc 0x... /system/lib64/libc.so (strlen+8)      ← 直接给符号！
  #01 pc ... libmysensor.so (read_raw+0x40)
memory near r0: ...                                  ← 现场内存快照取证
```

判读顺序：signal 类型与 fault addr（空指针 0x0 还是野地址）→ backtrace 首帧定位崩溃点 → memory near 确认数据现场。

## 73.3 adb 进阶技巧集

| 场景 | 命令 |
|------|------|
| 无线调试(Android 11+) | adb pair ip:port 配对后 adb connect |
| 端口转发访问板上 web | adb reverse tcp:8080 tcp:8080 |
| root 场景(userdebug) | adb root && adb remount 改 system |
| 截取整机状态包 | adb bugreport zip —— 一键打包全维度日志 |
| 模拟按键/文本 | adb shell input keyevent KEYCODE_POWER / input text hi |

## 73.4 Perfetto 抓取与泳道判读

```bash
# 设备端抓取 10s 全量 trace：
perfetto -o /data/misc/perfetto-traces/trace.pftrace -t 10s \
    sched freq idle am wm gfx view binder_driver hal dalvik
# 主机 ui.perfetto.dev 打开分析（纯前端不上传数据）
```

关键泳道解读：
- **sched 轨道**：线程运行状态与核分布——大小核负载一眼可见；
- **binder tracks**：跨进程调用等待链——ANR 元凶定位利器，binder 事务自动关联两端泳道，「谁阻塞了谁」一眼可见；
- **FrameTimeline**：jank 帧标红 + 预期 vs 实际时间——流畅度量化。

SQL 分析：「性能数据即数据库」范式：

```bash
trace_processor_shell --query-string \
  'select s.name,sum(dur) from sched s group by 1 order by 2 desc limit 10'
```

原理深挖：traced 守护进程三层结构——数据源(probes: ftrace/procstats/heapprofd) → traced(中心路由) → 消费者；支持长时间低开销后台采集 + 触发式快照（如 ANR 发生时回捞前 30s）；heapprofd 无需重编即可做 native 内存采样剖析。

## 73.5 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 抓不到内核事件 | ftrace 权限检查 | userdebug root；增大 buffer_size kb 配置 | sched 事件完整出现 |
| tombstone 无符号 | backtrace 只有 pc 地址 | 保留带符号库 + symbolizer | #00 帧显示 函数名+偏移 |
| bugreport 过大难分享 | 文件体积检查 | 复现前 clear buffers 再抓 | 体积降到可邮件级别 |

## 73.6 实测数据表：三类典型问题取证组合

| 问题 | 首选组合 | 判读锚点 |
|------|----------|----------|
| 启动慢 | boottrace 属性开启 + Perfetto | am_proc_start→draw 序列间隙 |
| 滑动掉帧 | Perfetto FrameTimeline+Sched | 红帧的主线程状态=Running？还是等 binder |
| 内存涨 | heapprofd 定期采样 + pmap 对比 | 按调用栈聚合的增长榜 |
| 偶发重启 | pstore+tombstone+dropbox 三源合并 | 重启前最后一条内核日志定级（[[ch64-内核调试Oops解读debugfs-kdump]] 联动） |

## 73.7 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| tombstone 无 backtrace | strip 过的库缺 unwind 表 | 保留带符号版本配 symbolizer；NDK 符号上传体系 |
| Perfetto 抓不到内核事件 | ftrace 权限/缓冲太小丢事件 | userdebug root；增大 buffer_size kb 配置 |
| ANR 但 traces 无锁信息 | 主线程等 binder 对端而对方也 ANR | 跨进程关联两份 traces；perfetto binder 泳道看依赖环 |
| bugreport 巨大难分享 | 含大量历史 log | 问题复现前 clear buffers 再抓 |

## 73.8 部署注意事项
1. main/system/crash 缓冲 size 分别配置——崩溃证据绝不能被常规日志冲掉。
2. 符号归档进 CI：无符号 backtrace 等于废纸，tombstone 必须能离线符号化。
3. Android 11+ 配对式无线调试可简化产线与实验室布线。
4. userdebug 的 adb root/remount 权限严禁带入用户版镜像。
5. 售后远程取证的 bugreport 流程规范进 S4（[[chsd-S4-量产工程产测工装与老化]]）。

> [!example]- 🧪 动手实验 L73-1：ANR 因果链完整破案（70 分钟）
> **步骤**：① 制造一次主线程等 binder 的 ANR（服务端故意睡）；② 收集 traces.txt 找 "held by" 与等待链；③ perfetto 回放时段，在 binder 泳道上标出请求-阻塞-超时三点；④ 修复（改 oneway 或服务端提速）后复测验证 ANR 消失；⑤ 全程材料整理成复盘文档。
> **验收**：能向他人讲清「从用户感知卡顿到代码行修复」的全证据链。

## 73.9 进阶话题
- **logcat 环形缓冲策略**：分区隔离是防证据丢失的第一道设计。
- **tombstone 符号化管线**：symbolizer + CI 符号归档联动。
- **traced 触发式快照**：问题发生瞬间回捞前 30s，长时低开销采集成为可能。
- **工具链三位一体**：perfetto 技法与 [[ch16-perf-ftrace-strace性能剖析]]、[[ch51a-可视化追踪Tracealyzer-SystemView]] 互补——perfetto 底层即 ftrace 数据源的统一 SQL 化。

> [!warning]- ❓ FAQ
> **Q1：Perfetto 与 ch16 的 perf/ftrace 重叠在哪？** A1：perfetto 以 ftrace 为核心数据源并统一 SQL 化；Linux 侧继续用 perf/ftrace 直采，Android 系统级问题首选 perfetto。
> **Q2：ANR 但 traces 里没有锁信息怎么办？** A2：大概率跨进程依赖环——把两端进程 traces 关联起来，用 binder 泳道看「谁阻塞了谁」。

> [!question] 📝 思考题
> 1. 用 SQL 从 trace 中统计某服务的 P99 binder 响应耗时。
> 2. 设计「现场无电脑」的远程日志采集方案（结合 ch44 上云通道）。
> 3. 对比 ch16 perf/ftrace 与本章工具链的重叠与互补边界。

---
🏷️ #domain/android #topic/debugging #topic/perfetto | 🔗 [[ch72-A-B-OTA升级与Recovery体系]] ← **本章** → [[ch74-总线与无线选型总表]] | 📚 [[P7-MOC]]
