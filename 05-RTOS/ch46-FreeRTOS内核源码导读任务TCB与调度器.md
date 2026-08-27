---
title: "第46章 FreeRTOS 内核源码导读①：任务、TCB 与调度器框架"
part: "[[P5-MOC]]"
chapter: 46
tags:
  - domain/rtos
  - topic/freertos
difficulty: 4
est_minutes: 40
prerequisites:
  - "[[ch45-实时性理论与调度算法]]"
related:
  - "[[ch47-FreeRTOS-PendSV上下文切换逐行汇编]]"
  - "[[ch49-FreeRTOS内存管理heap与栈检测]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第46章 FreeRTOS 内核源码导读①：任务、TCB 与调度器框架

> [!info] 导航
> ⏱ 40min | ★★★★☆ | 前置 [[ch45-实时性理论与调度算法]] | → [[ch47-FreeRTOS-PendSV上下文切换逐行汇编]]

## 🎯 学习目标
- [ ] 逐字段拆解 TCB 结构，说出每个成员被谁在什么时机访问
- [ ] 解释 list.c 五条链表的分工与四个反直觉设计点
- [ ] 讲清位图+CLZ 如何实现 O(1) 最高优先级查找
- [ ] 走通 startup→main→scheduler 完整启动路径直到第一个任务运行

## 46.1 核心概念：TCB 字段逐个拆解

tasks.c 不到 4000 行却撑起全球数亿设备，核心数据结构只有 TCB（Task Control Block）一张：

```c
typedef struct tskTaskControlBlock {
    volatile StackType_t *pxTopOfStack;   /* ★第一个成员！切换时汇编按偏移0访问栈顶——布局即接口(ch47) */
    ListItem_t xStateListItem;            /* 挂到 就绪/阻塞/挂起 链表的节点 */
    ListItem_t xEventListItem;            /* 挂到 等待事件(队列/信号量)的节点 */
    UBaseType_t uxPriority;               /* 当前优先级(继承时会临时变化) */
    StackType_t *pxStack;                 /* 任务私有栈基址(溢出检测锚点) */
    char pcTaskName[configMAX_TASK_NAME_LEN]; /* 你唯一免费的调试线索 */
    /* + 运行时统计/MPU 区域/核亲和(多核版) 等可选段 */
} tskTCB;
```

一个 TCB 携带**两个链表节点**是关键设计：同一时刻任务只能处于一种状态（xStateListItem 生效），却可能同时在等某个事件（xEventListItem 生效）——两个节点互不干扰地插进两张名单。

## 46.2 四态模型与 list.c 五条链表设计

| 链表 | 归属 | 职责 |
|------|------|------|
| pxReadyTasks[prio] 数组×链表 | tasks.c | 每优先级一条就绪队列，谁最高优谁上 CPU |
| xDelayedTaskList1 / 2 | tasks.c | 阻塞延时双表，按到期时刻升序；tick 溢出时**整表交换 O(1)** |
| xSuspendedTaskList | tasks.c | vTaskSuspend 的停车场 |
| xTasksWaitingToSend/Receive | 每个 Queue_t 内部 | IPC 等待名单，满了睡一边空了睡另一边(ch48) |
| mini-list(事件列表) | 各内核对象内部 | 只挂 xEventListItem，唤醒判断只扫短的 |

list.c 四个反直觉设计点：
1. 节点含 `pxContainer` 回指所属链表——删除 O(1)，无需遍历找归属；
2. `listGET_OWNER_OF_NEXT_ENTRY` 的游标机制：同优先级时间片轮转=游标每次走一步，调度器零额外结构；
3. `xItemValue` 当排序键：延时链表按到期时刻升序插入，头节点值设为 portMAX_DELAY 作哨兵，插入循环天然终止；
4. mini-list 与普通列表分离，短表扫描更快。
读源码建议顺序：`vListInsert → uxListRemove → xTaskIncrementTick(看双延时表切换) → vTaskSwitchContext(选核逻辑)`。

## 46.3 O(1) 位图调度：CLZ 一条指令出结果

- `uxTopReadyPriority` 位图记录「哪些优先级有就绪任务」，入队置位、出队清位；
- 开启 `configUSE_PORT_OPTIMISED_TASK_SELECTION`（M3+ 必开）后用 CLZ 前导零指令扫描位图——**一条指令找到最高非零 bit**，与任务数无关；
- M0 无 CLZ，退化为软件循环扫描（见 ch47 移植清单）。

## 46.4 关键代码：启动路径 startup→main→scheduler

```c
Reset_Handler → SystemInit → main()          /* ch38 同款启动骨架 */
xTaskCreate(task_fn,name,stack_depth,param,prio,&handle)
 ├─ pvPortMalloc(sizeof(TCB)+stack*4)         // TCB与栈一次分配(静态法则免)
 ├─ prvInitialiseNewTask:
 │    pxPortInitialiseStack(pxTopOfStack,...) // port.c 伪造「刚被打断」的现场
 │      → xPSR=0x01000000(T位) / PC=task_fn / LR=prvTaskExitError
 │      → R0=param ... 完全复刻 ch21 入栈帧布局！
 └─ prvAddNewTaskToReadyList                  // 插入对应优先级链表，更新位图

vTaskStartScheduler()
 ├─ 创建 Idle 任务(prio0, 必要时创建 Timer 服务任务)
 └─ xPortStartScheduler()
      ├─ 配置 SysTick 为 tick 中断源(configTICK_RATE_HZ)
      ├─ 设置 PendSV 为最低优先级 0xFF        ★切换载体(ch47)
      └─ prvStartFirstTask(): cpsie i; svc 0 → SVC handler 里恢复第一个任务现场
           → 从此 CPU 永远运行在某个任务的 PSP 栈上
```

调度决策点全部汇聚为一个动作——**置 PendSV pending 位**：SysTick(tick 计数/延时唤醒/同优时间片)、IPC API 解阻塞更高优任务(ch48)、ISR 里 `portYIELD_FROM_ISR()`、vTaskDelay/Suspend/Yield 直接调用。真正的切换被延迟到所有 ISR 结束后执行，「切换永不嵌套」。

## 46.5 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 启动即 HardFault | 断点停在 SVC handler | 向量表 PendSV/SVC 名绑定核对 | xPortPendSVHandler 正确接管 |
| 想确认选核逻辑 | GDB 打印 uxTopReadyPriority 位图 | 无 | 位图最高有效位=将运行任务优先级 |
| 创建耗时超标 | DWT 包裹 xTaskCreate | 动态改静态创建 | xTaskCreateStatic ≈1.2µs |

## 46.6 实测数据表：任务管理 API 真实开销（M4@168MHz）

| API | 典型周期 | 备注 |
|-----|----------|------|
| xTaskCreate(动态) | ~3µs+分配 | 含 TCB/栈初始化与入表 |
| xTaskCreateStatic | ~1.2µs | 无分配路径，确定性更好 |
| vTaskDelay/Until | ~0.4µs | 临界区内出/入表 |
| 上下文切换全程(PendSV) | ~170 cycles≈1µs | ch47 实测口径 |

## 46.7 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 调度器一启动就 HardFault | PendSV/SVC 向量名没对接(portasm)/中断分组冲突 | 核对向量表中 xPortPendSVHandler 绑定；BASEPRI 初始化顺序 |
| 低优先级任务饿死 | 高优任务无阻塞点死循环 | vTaskList() 打印各任务状态；高优循环里加阻塞点 |
| Idle 任务报栈告警 | configMINIMAL_STACK_SIZE 太小(尤其带 trace 宏) | 加大最小栈；检查钩子函数局部变量 |
| 任务创建返回失败 | 堆不足(动态法) | 查 xPortGetFreeHeapSize；改 static 创建法根治 |

## 46.8 部署注意事项

1. 生产配置打开 `configASSERT()` 与栈溢出检测，问题在开发期暴露；
2. 内存敏感产品一律 `xTaskCreateStatic`，分配路径从启动期消失(ch49)；
3. 任务命名带业务语义（如 `adc_feed`），「task1/task2」等于自废调试武功；
4. 别把业务塞进 idle hook 还指望实时性——Idle 的本职是清理被删任务内存、低功耗入口；
5. 升级 SMP 版前重新审视所有「当前任务」假设：pxCurrentTCB 变数组 per-core、全局锁变自旋锁(ch50a)。

> [!example]- 🧪 动手实验 L46-1：用 GDB 手动走一遍调度决策（50 分钟）
> **步骤**：① 断点在 vTaskSwitchContext 入口；② 打印 uxTopReadyPriority 位图与各优先级链表长度；③ 单步观察 pxCurrentTCB 如何被改写；④ 制造同优先级两任务验证游标轮转；⑤ 把每步观察画成时序图。
> **验收**：能不看源码复述「一次 tick 后谁会上 CPU」的完整推理。

## 46.9 进阶话题

- **configUSE_PORT_OPTIMISED_TASK_SELECTION**：CLZ 硬件化选择，M3+ 必开；
- **Idle 任务的真实职责**：清理被删任务内存、低功耗入口、Idle Hook——三件事都别抢它的 CPU 时间预算；
- **双延时表 vs 单表扫描**：tick 溢出用整表交换替代全表遍历，复杂度 O(1)，这是思考题 2 的答案骨架。

> [!warning]- ❓ FAQ
> **Q1：pxTopOfStack 为什么必须是 TCB 第一个成员？** 上下文切换汇编按固定偏移取栈顶，`str r0,[r2]` 直接写 TCB[0]——布局即 ABI，挪动位置汇编全错(ch47)。
> **Q2：动态创建和静态创建怎么选？** 启动期一次性创建可用动态；生命周期内反复建删或安全认证场景用静态——确定性来自无堆路径。

> [!question] 📝 思考题
> 1. 为什么 pxTopOfStack 必须是 TCB 第一个成员？画出切换时汇编取它的寻址过程。
> 2. 推导双延时链表如何 O(1) 处理 tick 溢出（对比单链表扫描法的复杂度）。
> 3. 用 GDB 断点验证 prvStartFirstTask 后 MSP/PSP 的分界变化。

---
🏷️ #domain/rtos #topic/freertos | 🔗 [[ch45-实时性理论与调度算法]] ← **本章** → [[ch47-FreeRTOS-PendSV上下文切换逐行汇编]] | 📚 [[P5-MOC]]
