---
title: "第61章 中断下半部机制：threaded_irq / workqueue / tasklet 兴衰"
part: "[[P6-MOC]]"
chapter: 61
tags:
  - domain/linux
  - topic/interrupt
  - topic/bottom-half
difficulty: 4
est_minutes: 30
prerequisites:
  - "[[ch60-子系统驱动GPIO-input-IIO-RTC-WDT]]"
related:
  - "[[ch24-中断系统与NVIC深度应用]]"
  - "[[ch16-perf-ftrace-strace性能剖析]]"
  - "[[ch65-性能优化CPU隔离cgroup-io调优]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第61章 中断下半部机制：threaded_irq / workqueue / tasklet 兴衰

> [!info] 导航
> ⏱ 30min | ★★★★☆ | 前置 [[ch60-子系统驱动GPIO-input-IIO-RTC-WDT]] | → [[ch62-应用编程epoll进程线程IPC]]

## 🎯 学习目标
- [ ] 讲清 softirq/tasklet/workqueue/threaded irq 四者的执行上下文差异与选型现状
- [ ] 用 request_threaded_irq 把重活下放内核线程并理解 IRQF_ONESHOT 防重入语义
- [ ] 复现并诊断一次中断风暴，掌握 /proc/interrupts 与 spurious 计数定位法
- [ ] 用 ftrace irqsoff 量化最长关中断区间并给出优化路径

## 61.1 上半部/下半部分工原则
铁律：**上半部越短越好**。上半部（hardirq）在中断关闭的上下文执行，只做判源、清标志、应答硬件三件事，快进快出；一切耗时或需睡眠的处理全部推给下半部。判断标准：「这段代码必须立刻在中断上下文做完吗？」不是就下放。MCU 裸机的中断标志纪律（[[ch24-中断系统与NVIC深度应用]]）在 Linux 演化成了机制化的下半部家族。

## 61.2 三种（+1）下半部对照

| 机制 | 上下文 | 可睡眠 | 现状 |
|------|--------|--------|------|
| softirq | 软中断（特殊上下文） | ❌ | 内核自用（TIMER/NET_RX...），驱动别碰 |
| tasklet | 同上但同类型串行 | ❌ | **已被弃用（deprecated）**，新代码禁止 |
| workqueue | 内核工作线程 | ✅ | 需要睡眠处理的正确选择 |
| **threaded irq ★** | 专用内核线程（可调优先级） | ✅ | 驱动中断处理的现代默认答案 |

## 61.3 request_threaded_irq 标准范式与参数详解

```c
ret = request_threaded_irq(irq,
        my_hardirq_handler,   /* 上半部：判源+清标志，快进快出 */
        my_threaded_handler,  /* 下半部线程：可以睡眠！读I2C/加mutex都行 */
        IRQF_ONESHOT | IRQF_TRIGGER_FALLING, "touch", priv);

static irqreturn_t my_hardirq(int irq, void *d) {
    if (!is_mine()) return IRQ_NONE;
    disable_hw_interrupt();       /* 配合 ONESHOT 语义 */
    return IRQ_WAKE_THREAD;       /* 不需下放时返回 IRQ_HANDLED */
}
static irqreturn_t my_threaded(int irq, void *d) {
    process_data(priv);           /* 可能耗几 ms，睡也合法 */
    enable_hw_interrupt(priv);
    return IRQ_HANDLED;
}
```

| 参数 | 说明 |
|------|------|
| irq | 中断号，通常来自 `platform_get_irq(pdev, 0)` |
| hardirq_handler | 上半部：判源 + 清标志；返回 `IRQ_WAKE_THREAD` 唤醒线程，无事则 `IRQ_HANDLED` |
| thread_fn | 下半部线程函数，进程上下文、可睡眠；传 NULL 即退化为普通 request_irq |
| flags | `IRQF_ONESHOT`：线程 handler 返回前自动屏蔽本中断，防重入风暴；`IRQF_TRIGGER_FALLING` 指定边沿；`IRQF_SHARED` 共享线必须真实判源 |
| name | /proc/interrupts 里显示的名字 |
| dev_id | 传给两个 handler 的私有数据；共享中断时是判源依据 |

优势总结：可睡眠（线程上下文）、优先级可控（SCHED_FIFO/chrt 可调）、ONESHOT 天然防风暴。

## 61.4 workqueue 使用要点

```c
INIT_WORK(&priv->work, my_work_fn);      /* 静态方式 */
schedule_work(&priv->work);              /* 提交到系统共享队列 */
/* 共享队列注意：别人在你前面睡了你也被拖慢 ——
   高要求场景建专属 wq： alloc_workqueue("mydrv", WQ_HIGHPRI|WQ_UNBOUND, 0)
   cancel_work_sync(&w) 用于 remove 路径防泄漏 */
/* delayed_work: schedule_delayed_work 自动延时提交 —— 定时轮询利器 */
```

## 61.5 中断风暴病理切片与检测

```text
电平型中断 + 未清源 → handler 返回即再次 pending → 无限重入：
① CPU 100%(si 列) ② 同优先级任务饿死 ③ note: irq N handler... 日志刷屏
内核自保机制： spurious 计数超阈值会禁用该 IRQ(打印 "irq nobody cared")
修复决策树：
  电平型？ → 确认设备侧源已清(读状态寄存器回写)
  边沿型丢脉冲敏感？ → ONESHOT + threaded 重设计
  共享线误判？ → IRQF_SHARED 的 dev_id 判源必须真实读硬件
预防设计评审项： 每个新驱动 PR 必答「你的中断何时被清、由谁清」。
```

检测手法：`watch -n1 cat /proc/interrupts` 看目标 IRQ 计数是否「频闪式暴涨」，同时 top 观察 si 列飙升；配合 `cat /proc/irq/N/spurious` 看 nobody cared 计数。

## 61.6 中断延迟优化工具箱
1. **IRQ affinity**：`echo 2 > /proc/irq/N/smp_affinity` 把网口中断钉到核 1、业务跑核 0——隔离互扰（衔接 [[ch65-性能优化CPU隔离cgroup-io调优]]）；
2. **NAPI 思想**：高流量场景「关中断+轮询」混合模式，避免每包一中断的风暴；
3. **PREEMPT_RT 视角**：几乎所有 spinlock 变可睡眠，threaded irq 优先级可用 chrt 调——实时调优主战场；**测量**用 ftrace 的 irqsoff/preemptoff tracer（[[ch16-perf-ftrace-strace性能剖析]]）直接输出最长关中断区间及责任链。

## 61.7 实测数据表：三种下半部方案延迟与吞吐（模拟 1kHz 中断 + 1ms 处理）

| 方案 | 中断响应 P99 | 处理吞吐 | 备注 |
|------|-------------|----------|------|
| 全部在 hardirq 干完 | 0.5µs（自身） | - | **其他中断延迟劣化到 1ms+** |
| tasklet（旧） | 0.5µs | 好 | 全局软中断延迟差，已弃用 |
| threaded irq（SCHED_FIFO 50） | 0.5µs | 好 | **整体最优 ★** |

## 61.8 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 中断风暴 CPU100% | 电平型中断没清源就返回或 ONESHOT 缺失 | /proc/interrupts 增量确认；补清标志逻辑 |
| threaded handler 里 oops | 误以为不能睡而用 spin_lock_irqsave 包了睡眠调用 | 锁类型审查；改 mutex |
| 偶发丢中断 | 共享线路上 IRQF_SHARED 判源不准 | 硬件支持则独占；判源必须读真实 pending 位 |
| work 泄漏模块卸载卡住 | cancel_work_sync 缺失或 work 还在排队 | remove 路径 flush 全部工作项再 free |

## 61.9 部署注意事项
1. 新驱动一律 threaded irq，tasklet 只许在存量维护中出现；
2. ONESHOT 与硬件 disable/enable 必须成对审查，防止永久屏蔽；
3. 共享中断的 dev_id 判源必须读真实 pending 位；remove 路径先 flush/cancel 所有工作项再 free；
4. affinity 规划写入部署脚本固化，重启后自动生效。

> [!example]- 🧪 动手实验 L61-1：亲手引爆并扑灭一次中断风暴（45 分钟）
> **步骤**：① 用 gpio-keys 或自制驱动故意不清 EXTI 源；② 观察 /proc/interrupts 增速与 CPU si 飙升；③ 等 "nobody cared" 出现并记录阈值行为；④ 修复清源逻辑恢复系统；⑤ 用 irqsoff tracer 对比修复前后最长关中断时长。**验收**：产出完整「病理与康复报告」——包含风暴计数曲线、阈值日志、修复后 tracer 对比数据。

## 61.10 进阶话题
- IRQ affinity 与 RPS 配合：多队列网卡分核收中断、RPS 再分发软中断——4 核板吞吐翻倍组合拳（NAPI 在 [[ch80-以太网与lwIP协议栈源码导读]] 再现）；
- PREEMPT_RT 变化：hardirq 多数也线程化，「关中断时长」指标退位，「抢占延迟」登场；ksoftirqd 冒头=软中断过载，先调 NAPI weight/预算再换协议路径；
- perf record -e irq:irq_handler_entry 聚合各 ISR 耗时分布；范本 drivers/input/touchscreen/goodix.c 是 threaded irq 教科书实例。

> [!warning]- ❓ FAQ
> **Q1：tasklet 为什么被弃用？**
> 同类型强制串行限制了多核扩展性，且运行在不可控的软中断时机上、调度延迟不可预测——threaded irq 把调度权交还通用调度器。
> **Q2：threaded handler 里能用 spin_lock_irqsave 吗？**
> 保护纯内存数据可以，但绝不能拿它去包睡眠调用（I2C 读、mutex）；线程上下文的正解就是 mutex/信号量。

> [!question] 📝 思考题
> 1. 从调度延迟与多核扩展性两方面推演 tasklet 为何被弃用。
> 2. 为一个 SPI 触摸屏设计完整中断方案：hardirq/threaded/work 各承担什么？
> 3. 用 ftrace 测出网卡驱动的最长 softirq 处理时长并提出 NAPI 权重调整建议。

---
🏷️ #domain/linux #topic/interrupt #topic/bottom-half | 🔗 [[ch60-子系统驱动GPIO-input-IIO-RTC-WDT]] ← **本章** → [[ch62-应用编程epoll进程线程IPC]] | 📚 [[P6-MOC]]
