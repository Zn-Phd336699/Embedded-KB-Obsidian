---
title: "第16章 性能剖析：perf / ftrace / strace 与火焰图"
part: "[[P2-MOC]]"
chapter: 16
tags:
  - domain/fundamentals
  - topic/profiling
difficulty: 3
est_minutes: 35
prerequisites:
  - "[[ch15-内存问题排查三板斧]]"
related:
  - "[[ch17-Wireshark-tcpdump抓包分析]]"
  - "[[ch65-性能优化CPU隔离cgroup-io调优]]"
  - "[[chs1-SO1性能分析方法论与火焰图专题]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第16章 性能剖析：perf / ftrace / strace 与火焰图

> [!info] 导航
> ⏱ 35min | ★★★☆☆ | 前置 [[ch15-内存问题排查三板斧]] | → [[ch17-Wireshark-tcpdump抓包分析]]

「感觉卡」不是证据。本章用量化数据回答三个问题：谁耗的 CPU？哪段代码慢？系统调用花在哪？Linux 侧用 perf/ftrace/strace，MCU 侧用 GPIO 翻转与 DWT 周期计数器。

## 🎯 学习目标
- [ ] 用 perf top/record/report 定位热点函数，并生成火焰图作为性能沟通语言
- [ ] 用 ftrace 追踪内核函数调用与时延：irqsoff 测最长关中断时长
- [ ] 用 strace -c/-T 分析应用 syscall 画像，识别阻塞点
- [ ] 掌握 MCU 无操作系统下的轻量剖析手段（GPIO/DWT）

## 16.1 核心概念：on-CPU 与 off-CPU 两把尺子

| 视角 | 回答的问题 | 工具 |
|------|------------|------|
| on-CPU 采样 | CPU 时间被谁烧掉 | perf record -F99 / PMU 计数器 |
| off-CPU 追踪 | **线程在等谁/等什么**（锁/IO/调度） | perf sched latency；offcputime(BPF)；ftrace sched_switch |

嵌入式高频误区：CPU 利用率不高但响应慢——八成是 off-CPU 问题，on-CPU 采样器根本看不到它。

## 16.2 症状→工具选型速查

| 症状 | 首选工具 | 判读要点 |
|------|----------|----------|
| CPU 高 | perf top/report | 看 self 列；用户态还是内核态占比 |
| 响应偶发抖动 | ftrace sched_wakeup→sched_switch 时延 | wakeup-to-run 差值直方图；被谁抢占 |
| IO 慢 | strace -T + iostat | read/write 单次耗时；是否缺 page cache |
| 网络吞吐低 | ss -ti + tcpdump（[[ch17-Wireshark-tcpdump抓包分析]]） | cwnd/重传率/RTT 三件套 |

## 16.3 关键代码：perf 三板斧、ftrace、strace 与 MCU 剖析

```bash
  # —— perf 三板斧 ——
perf top -g                        # 实时热点全景（含内核），-g 带调用栈
perf record -F 99 -a -g -- sleep 30    # 99Hz 质数率采样，避免锁步假象
perf report --no-children          # self 权重排序，找真正干活的函数

  # —— 火焰图：宽度=CPU占比；塔高=调用深度；平顶=热点所在 ——
git clone https://github.com/brendangregg/FlameGraph
perf script | FlameGraph/stackcollapse-perf.pl | FlameGraph/flamegraph.pl > flame.svg

  # —— 板上资源紧张时的标准分工：板上采集、主机分析 ——
perf record -o /tmp/perf.data      # 板端
perf report -i /tmp/perf.data      # 拉回主机
```

```bash
  # —— ftrace：内核行为显微镜 ——
cd /sys/kernel/debug/tracing
echo 1 > events/sched/sched_switch/enable       # 事件追踪：上下文切换
echo function_graph > current_tracer            # 函数图：完整调用树+耗时
echo do_sys_open > set_ftrace_filter && cat trace
echo irqsoff > current_tracer; echo 0 > tracing_max_latency; sleep 5
cat trace          # "irqoff at ... ns" —— 实时性整改的证据链(ch65)
```

```bash
  # —— strace：应用 syscall 画像 ——
strace -c ./app                  # 统计模式：% time 列看哪个调用最贵（read/write 占大头=IO 密集）
strace -T -e trace=openat ./app  # -T 每次调用耗时；-e 过滤特定调用
strace -p $(pidof app) -f        # attach 运行中进程并跟踪子线程
```

```c
/* MCU 穷人版 profiler */
/* 方法1 GPIO 翻转 + 示波器/逻辑分析仪测段落耗时（最硬核直观）*/
#define PROF_ON()  GPIOB->BSRR = BIT(12)
#define PROF_OFF() GPIOB->BSRR = BIT(28)     /* PB12 高电平区间=被测代码 */
/* 方法2 DWT->CYCCNT 周期计数器（M3+ 免费送）*/
CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
uint32_t t0=DWT->CYCCNT; work(); uint32_t cyc=DWT->CYCCNT-t0; /* 168MHz 下精度 6ns */
```

## 16.4 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 火焰图一片平无法聚焦 | 先 perf top 缩小嫌疑范围 | -F 提到 299；延长录制 | 出现清晰平顶塔 |
| 符号全是地址 | nm/file 查符号表 | -g 编译；装 dbgsym；perf archive 离线符号 | report 显示函数名与行号 |
| perf Permission denied | cat kernel.perf_event_paranoid | 测试机 sysctl 置 -1 或 sudo | 能采内核事件 |
| 加测量代码现象消失 | 海森 bug：时序变化掩盖竞态 | 改无侵入：DWT 被动计数、逻辑分析仪外部观测 | 现象复现且数据可得 |

## 16.5 实测数据表：常见优化的真实收益区间（i.MX6ULL 案例）

| 优化项 | 改动量 | 实测收益 |
|--------|--------|----------|
| -O0→-O2（算法模块） | 改 Makefile | 热点函数 ×3~7 提速 |
| memcpy 换 NEON 结构化搬运 | ~50 行 | 大块拷贝 ×1.8 |
| 日志 printf 移出热路径 | 重构 | P99 尾延 -35% |
| taskset 绑核避开网口中断层 | 一行命令 | jitter P99 -60% |

## 16.6 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| perf 报 Permission denied | kptr_restrict/perf_event_paranoid 过严 | 测试机 sysctl=-1 或 sudo；生产机勿改 |
| 符号全是地址 | 二进制 strip 或缺 debuginfo 包 | -g 编译；apt install dbgsym；perf archive 离线符号 |
| 火焰图一片平 | 采样率过低/运行太短 | 提高 -F 到 299；延长录制；先 perf top 缩小范围 |
| MCU 加测量代码后现象消失 | 海森 bug 时序变化掩盖竞态 | 改无侵入手段：DWT 被动计数、外部观测 |

## 16.7 部署注意事项

1. 嵌入式板的标准分工：板上 `perf record -o`，主机 `perf report -i`——别在资源紧张的板上做重型分析。
2. i.MX6ULL/RK3568 的 Debian/Armbian 一般自带 perf；若无则 `CONFIG_PERF_EVENTS=y` 重编内核 + 交叉编 userspace。
3. strip 发布二进制前保留 debuginfo 存档，线上问题才能离线翻译符号。
4. irqsoff 的纳秒级证据链是实时性整改起点，联动 [[ch61-中断下半部threaded-irq-workqueue]] 与 [[ch65-性能优化CPU隔离cgroup-io调优]]。

> [!example]- 🧪 动手实验 L16-1：揪出最长关中断元凶（30 分钟）
> **步骤**：① 板上挂载 debugfs 进入 tracing 目录；② `echo irqsoff > current_tracer; echo 0 > tracing_max_latency`；③ 跑正常业务 60 秒；④ 读 trace 文件顶部长度与责任函数链；⑤ 对该函数做缩短临界区改造并复测对比。**验收**：拿到前后两组纳秒级数据，形成「测量驱动优化」的第一份实战报告。

## 16.8 进阶话题
- **采样率取质数的原因**：99Hz 会均匀扫过 100Hz 任务各阶段，避免锁步假象
- **DWT 精细剖析三计数器**：CYCCNT(总周期)/CPICNT(理想贡献)/EXCCNT(异常开销) 组合可算真实 IPC 与中断侵蚀占比
- **BPF 的边界**：延迟热图/offcputime 很强，但交叉编译环境装 BPF 工具链较痛——优先在 x86 开发机复现同类问题

> [!warning]- ❓ FAQ
> **Q1：CPU 占用率不高为什么还卡？** 大概率 off-CPU 问题（等锁/等 IO/等调度），换 perf sched 或 ftrace sched_switch 看等待时间而不是执行时间。
> **Q2：GPIO 翻转和 DWT 计数怎么选？** 引脚富余要看波形选 GPIO（直观、多路并行）；引脚紧张要精度选 DWT（6ns@168MHz、零引脚占用），两者侵入性都远低于 printf。

> [!question] 📝 思考题
> 1. 解释为什么采样频率取质数（如 99Hz）而不是整百。
> 2. 用 irqsoff tracer 找出你驱动中最长关中断路径，量化到纳秒并制定整改方案。
> 3. 对比 GPIO 翻转与 DWT 计数的适用边界（引脚数 vs 精度 vs 侵入性）。

---
🏷️ #domain/fundamentals #topic/profiling | 🔗 [[ch15-内存问题排查三板斧]] ← **本章** → [[ch17-Wireshark-tcpdump抓包分析]] | 📚 [[P2-MOC]]
