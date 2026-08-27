---
title: "第48章 IPC 五件套源码解析与选型：队列/信号量/互斥/事件组/任务通知"
part: "[[P5-MOC]]"
chapter: 48
tags:
  - domain/rtos
  - topic/ipc
difficulty: 4
est_minutes: 40
prerequisites:
  - "[[ch47-FreeRTOS-PendSV上下文切换逐行汇编]]"
related:
  - "[[ch51a-可视化追踪Tracealyzer-SystemView]]"
  - "[[ch49-FreeRTOS内存管理heap与栈检测]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第48章 IPC 五件套源码解析与选型：队列/信号量/互斥/事件组/任务通知

> [!info] 导航
> ⏱ 40min | ★★★★☆ | 前置 [[ch47-FreeRTOS-PendSV上下文切换逐行汇编]] | → [[ch49-FreeRTOS内存管理heap与栈检测]]

## 🎯 学习目标
- [ ] 读懂 Queue_t 统一底座如何派生出全部五件套，并用「RAM 成本×时延」矩阵完成选型
- [ ] 在 queue.c 里指出优先级继承的「三行真身」及其一层继承边界
- [ ] 复述死锁四条件并落地四条工程铁律+压力测试 harness

## 48.1 核心概念：万物基于 Queue 的统一底座

```c
typedef struct QueueDefinition {
    int8_t *pcHead;                       // 存储区首址
    int8_t *pcWriteTo, *pcReadFrom;       // 环形缓冲读写游标
    List_t xTasksWaitingToSend;           // 满了睡在这
    List_t xTasksWaitingToReceive;        // 空了睡在这
    volatile UBaseType_t uxMessagesWaiting; UBaseType_t uxLength, uxItemSize;
    /* mutex 扩展区: xMutexHolder(继承优先级的倒霉蛋) + uxRecursiveCallCount */
} Queue_t;
/* 二值信号量=长度1项大小0的队列；计数信号量=N项大小0的队列；
   互斥量=二值信号量+优先级继承+递归计数+持有者记录 */
```
## 48.2 关键代码：xQueueGenericSend 发送骨架
```c
/* enter_critical → 有空位? → 拷贝数据 + uxMessagesWaiting++
   → 从接收等待列表摘下最高优任务(xTaskRemoveFromEventList)
   → 其优先级更高则请求 yield(ch47 PendSV 接棒) → exit_critical
   满时反向：发送者挂到 xTasksWaitingToSend 睡觉，消费者腾位后唤醒它 */

```
对称性之美：队列两端各挂一张等待名单，谁等谁一目了然——死锁分析从这张图开始。

## 48.3 五件套选型矩阵

| 原语 | RAM 开销 | 典型用途 | 禁忌 |
|------|----------|----------|------|
| Queue | 头~76B+N*size+对齐 | 数据搬运、消息总线 | 大 item 频繁拷贝（传指针但注意生命周期） |
| Binary Semaphore | ~80B | ISR→任务事件通知 | 当锁用！（无优先级继承会翻转） |
| Counting Semaphore | ~84B | 资源池计数、事件积累 | — |
| Mutex(+Recursive) | ~88B | 共享资源互斥 | ISR 中使用（禁止！） |
| Event Group | ~40B+24B | 多条件同步（AND/OR 等待） | 高频通知（位操作有全局临界区） |
| **Task Notification** | **0（复用TCB）** | 一对一极速通知/轻量邮箱 | 广播场景、多发送方竞争同一索引 |

```c
/* 任务通知 = 每任务自带的一组(uint32值+状态)，比信号量快45%~95%(官方测)。
   局限：只有唯一接收者；发送不排队(eSetValueWithOverwrite 覆盖模式除外) */
xTaskNotifyGive(handle);                              // ISR 配对 vTaskNotifyGiveFromISR
uint32_t v = ulTaskNotifyTake(pdTRUE, portMAX_DELAY); // 类二值/计数信号量用法
xTaskNotifyIndexed(h, idx, value, eSetBits);          // 当 32bit 事件组用
```
## 48.4 Event Group 同步位：多任务会合屏障
```c
#define EVT_ADC_READY (1<<0)      // 各任务完成后置位
#define EVT_NET_READY (1<<1)
#define EVT_UI_READY  (1<<2)      // 主任务等三位全齐才继续 —— 屏障同步(barrier)
xEventGroupSync(eg, EVT_ADC_READY, EVT_ALL, portMAX_DELAY);
/* 内核亮点：置位/等待在一个「全局临界区」内完成判断保证会合原子性；低8位保留给内核 */
```
## 48.5 原理深挖：优先级继承的三行真身（queue.c）
```c
/* xQueueSemaphoreTake 中互斥量分支的核心动作：
① 记录持有者： pxQueue->u.xSemaphore.xMutexHolder = xTaskGetCurrentTaskHandle();
② 等待者优先级提升： 若 waiter->uxPriority > holder -> vTaskPrioritySet(holder, waiter->uxPriority); // 继承！
③ 释放时沿继承链回落原级 —— ch45 第三幕的中优从此压不住持锁者
边界：只有一层继承(非传递)——A 持锁被 B 提，B 又等 C 锁不会连锁提 C，
      长锁链系统仍需手工天花板(ch45 PC)或重构锁粒度 */
```
## 48.6 死锁四条件与工程规避（含测试 harness）
```c
/* 死锁必要条件：互斥 + 持有等待 + 不可剥夺 + 循环等待。工程铁律：
① 全项目锁序表 mtxA > mtxB > mtxC，任何路径只能按序拿取
② 第二把锁一律带超时(portMAX_DELAY 禁用于复合获取)  ③ 回归注入随机延迟压力跑出潜在环
④ 排查工具：vTaskList + 「谁持有哪些锁」审计打印 / Tracealyzer 看阻塞链(ch51a) */
static inline void stress_lock_take(Mutex_t *m){ xSemaphoreTake(m->handle, pdMS_TO_TICKS(10)); /* 死锁压力harness·铁律② */
    audit_record(xTaskGetCurrentTaskHandle(), m); vTaskDelay(rand_range(0, pdMS_TO_TICKS(5))); /* 铁律④审计持有集合供环路检测 · ③随机窗口放大竞争 */
}
```
## 48.7 参数调试技巧
| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 队列满丢包 | send 返回值统计 | 深度=突发率×最大响应时间×安全系数2，对齐 2 的幂 | dropped==0 且水位 <80% |
| 翻转疑似复现 | Tracealyzer 观察提升行为 | binary sem 换 Mutex | 高优等待期间无中优插入 |

## 48.8 实测数据表：五种 IPC 吞吐与时延（M4@168MHz 同优先级乒乓）
| 原语 | 单次往返 | P99 | 备注 |
|------|----------|-----|------|
| Task Notify give/take | ~0.9µs | 1.1µs | **最快** |
| Binary Semaphore | ~1.4µs | 1.8µs | — |
| Queue(4B item) | ~2.0µs | 2.6µs | 含拷贝与两表操作 |
| EventGroup sync(3 任务) | 取决于最慢者 | — | 屏障语义本身有等待 |
| Mutex take/give 无竞争 | ~1.2µs | 1.5µs | 竞争时加继承切换成本 |
## 48.9 排故速查表
| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| xSemaphoreTake 永久阻塞 | Give 在更高优 ISR 但优先级配置违规 | 黄金法则复查(ch24)；核对 FromISR 配对 |
| 互斥保护下数据仍坏 | 双锁护同一变量/写路径漏锁一处 | grep 变量全部访问点逐一核对持锁状态 |
| 优先级翻转实测出现 | 用了 binary sem 当锁 | 换 Mutex；Tracealyzer 观察提升行为 |

> [!example]- 🧪 动手实验 L48-1：亲手制造并观测优先级翻转（60 分钟）
> **步骤**：① 三任务 H/M/L + 二值信号量当锁（L 持有）；② LA 抓 H 关键段被 M 压制的时序证据；③ 换 Mutex 复测对比；④ 再用 Tracealyzer(ch51a) 截继承提升瞬间图。
> **验收**：两张对比波形+结论文档——面试讲这案例直接封神。

## 48.10 部署注意事项

1. ISR 里禁用 Mutex（继承语义依赖阻塞，中断里不存在）；ISR 只能用 FromISR 后缀 API；
2. 二值信号量只做事件通知，任何「保护共享资源」的需求一律 Mutex；
3. EventGroup 低 8 位保留给内核，用户位从 bit8 起分配并维护位所有权表；
4. 递归互斥仅限「同任务重入同一资源」（如递归遍历持锁结构），跨任务递归语义不存在。

## 48.11 进阶话题

- **xQueueSet 的适用窄门**：多队列统一等待——但每次 Set 操作有全局锁开销；现代替代是每队列挂同一任务通知位图自管理；
- **软件定时器的真相**：跑在 Timer 服务任务的队列命令上——回调内阻塞会拖垮所有定时器，高精度需求用硬件 timer+ISR；
- **队列大小公式**：深度=突发率×最大响应时间×安全系数 2，再对齐 2 的幂——拍脑袋给的深度迟早爆仓。

> [!warning]- ❓ FAQ
> **Q1：为什么任务通知快 45%~95%？** 零独立对象 RAM（复用 TCB）、无环形缓冲拷贝、等待列表操作直接在调度器数据结构上完成。
> **Q2：「队列+互斥量」组合下继承为何失效？** 继承挂在 mutex 的 xMutexHolder 上；生产者等的不是锁而是队列空间——继承链断裂，需改设计而非堆锁。

> [!question] 📝 思考题
> 1. 推导「队列+互斥量」组合下优先级继承为何失效，给出替代方案。
> 2. 用任务通知重写 ch44 网关的点数据分发，估算 RAM 收益。
> 3. 设计锁序审计器：遍历各任务持有的锁集合检测环路。

---
🏷️ #domain/rtos #topic/ipc | 🔗 [[ch47-FreeRTOS-PendSV上下文切换逐行汇编]] ← **本章** → [[ch49-FreeRTOS内存管理heap与栈检测]] | 📚 [[P5-MOC]]
