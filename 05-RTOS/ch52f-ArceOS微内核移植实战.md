---
title: "第52章实战 ArceOS 微内核移植：在 seL4 上运行 Unikernel"
part: "[[P5-MOC]]"
chapter: 52
tags:
  - domain/rtos
  - topic/microkernel
  - topic/arceos
  - topic/sel4
difficulty: 4
est_minutes: 35
prerequisites:
  - "[[ch52d-seL4能力模型与地址空间实战]]"
related:
  - "[[ch52b-reL4异步微内核设计与实现]]"
  - "[[ch52e-reL4内核实现启动SMP与MCS]]"
has_lab: false
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第52章实战 ArceOS 微内核移植：在 seL4 上运行 Unikernel

> [!info] 导航
> ⏱ 35min | ★★★★☆ | 前置 [[ch52d-seL4能力模型与地址空间实战]] | → [[ch52-seL4微内核能力模型形式化验证]]

## 🎯 学习目标
- [ ] 理解将 ArceOS 移植到 seL4 的核心设计：管理任务+子任务模型
- [ ] 掌握 seL4 上的内存管理：untyped 分配、大页映射、四区域划分
- [ ] 说清 seL4 中断转发机制与用户态中断处理流程
- [ ] 了解 oskit 抽象层的设计与接口
- [ ] 理解多核移植：每核管理任务、任务迁移、核间调度

## 一、整体架构

### 1.1 设计动机

seL4 capability 设计安全性高，但使用复杂。将成熟 OS（如 ArceOS、Linux）移植到 seL4 上作为操作系统服务，可以：
- 降低 seL4 用户态开发难度
- 继承原有 OS 生态
- 保留微内核的安全隔离

### 1.2 核心设计：管理任务 + 子任务

```
┌─────────────────────────────────────────────┐
│              seL4 内核                       │
├─────────────────────────────────────────────┤
│  核心0: 管理任务(调度器)                      │
│    ├── 子任务1 (ArceOS 线程)                 │
│    ├── 子任务2 (ArceOS 线程)                 │
│    └── event_handler (监听IPC+中断通知)      │
├─────────────────────────────────────────────┤
│  核心1: 管理任务(调度器)                      │
│    ├── 子任务3                               │
│    └── ...                                  │
└─────────────────────────────────────────────┘
```

**关键设计点**：
- 每个核心启动一个 **seL4 管理任务**，负责创建/调度/迁移子任务
- 每个 ArceOS 任务 = 一个独立 seL4 任务，**共享同一个 vspace**（类似线程）
- 调度器用 ArceOS 调度器，但调度操作通过 seL4 TCB 的 `suspend`/`resume` 实现
- 子任务通过 IPC 请求管理任务执行创建/调度/迁移
- 子任务的 CSpace 作为 CNode 包含在管理任务中，管理任务可访问子任务能力

## 二、任务管理

### 2.1 任务创建

子任务创建时已申请所有需要的能力，运行时不再申请。流程：
1. 从 untyped 分配 TCB、CNode、IPC Buffer
2. 设置 vspace（共享管理任务的地址空间）
3. 注册到管理任务的任务表
4. 加入 ArceOS 调度队列

### 2.2 任务调度

由于每个 ArceOS 任务都是独立 seL4 任务，无法直接上下文切换，只能通过内核切换：
- 子任务请求管理任务切换
- 管理任务 `suspend` 上一个任务 → `resume` 下一个任务

### 2.3 任务迁移

多核下任务迁移通过 seL4 设置亲和性 syscall 实现：
1. ArceOS 执行迁移操作时，在任务上设置迁移 flag
2. 下一次启动该任务时，执行真正的迁移（设置 CPU 亲和性）

## 三、内存管理

### 3.1 核心挑战

seL4 中所有内存按能力管理，任务启动时**没有可分配的内存空间**（完全静态）。使用内存必须：
1. 找内核从 untyped 分配 PAGE(4KB) / LARGE_PAGE(2MB) 能力
2. 进行页表映射
3. 才能自由使用

### 3.2 Unikernel 内存策略

初始化时将所有 untyped 区域申请为 LARGE_FRAME 并映射，类似 fixed offset map：

| 内存区域 | 说明 | 分配者 |
|---------|------|--------|
| ELF 段 + 栈 + IPC Buffer | 基本固定部分 | root-task |
| 初始化堆空间 | 固定位置 0x2000_0000，2M大页 | root-task |
| 巨大 untyped cap | 连续映射为大页，交给 axalloc | root-task → ArceOS |
| 较小 untyped cap | 存放 TCB/CNode 等非内存能力 | root-task → ArceOS |

> [!important] 设计要点
> 大 untyped 只放大页以保持地址连续；其他能力放在小 untyped 区域。外设地址由 root-task 映射到指定虚拟地址，ArceOS 直接使用虚拟地址。

### 3.3 MemoryManager

oskit 提供 `MemoryManager` 封装 seL4 内存操作：
- 分配 frame 并映射
- 分配页表
- 管理能力回收

## 四、中断管理

### 4.1 seL4 中断模型

seL4 是标准微内核：**除了 IPI 中断，其他中断内核均不处理**。用户态必须先注册中断，内核才会在中断发生时通过 **notification** 通知对应任务。

### 4.2 中断处理流程

```
硬件中断发生
    ↓
seL4 内核接收，查找注册的 notification
    ↓
发送 notification 给用户态任务
    ↓
event_handler 任务（正在 recv endpoint）被唤醒
    ↓
执行中断处理函数
    ↓
发送 ack 给内核（否则不响应下一个中断）
```

> [!tip] 巧妙设计
> event_handler 本来就在 `recv endpoint` 等待 IPC，而 seL4 中等待 recv 时 notification 也会触发。因此只需在原有 event_handler 加上 notification 处理，几乎无额外开销。

### 4.3 中断管理器

oskit 实现了**无锁** `IrqManager`。AArch64 有 PPI（私有）和 SPI（共享），每个核心需要独立的中断管理器，使用 percpu 组件实现。

> [!warning] 中断使能模拟问题
> 目前通过 flag 决定是否执行处理函数来模拟中断 disable。但存在设计问题：disable 后是否 ack？ack 会一直被打断，不 ack 则后续中断无法触发。

## 五、oskit 抽象层

### 5.1 设计目标

将 seL4 特有功能（中断、内存、能力）抽象为独立 crate，可用于任意 OS 移植，不仅限于 ArceOS。

### 5.2 两个 crate

| crate | 功能 |
|-------|------|
| `oskit` | seL4 底层实现，对能力的封装 |
| `interface` | seL4 底层 API 接口（内存分配、中断注册、任务切换） |

### 5.3 oskit 组成

- 中断管理：注册和处理
- 内存管理：分配并映射，类似页表操作
- 能力管理：分配回收，上层无需关心回收
- IPC 事件定义

> [!note] 待优化
> oskit 依赖 alloc，导致上层 OS 初始化时必须预先分配堆空间。计划将内存管理部分剥离，不依赖 alloc。

## 六、平台抽象与多核

### 6.1 axplat 平台抽象

将 seL4 系统抽象为硬件平台，实现 `axplat-aarch64-sel4` crate，提供：
- 内存管理
- 中断管理
- 时钟
- console
- power
- 多核实现

### 6.2 多核实现

- **从核心启动**：接收启动命令后，在目标核心创建任务执行 `rust_main_secondary`
- **每核管理任务**：从核心初始化完成后自动变为管理任务，监听子任务 IPC
- **独立调度**：每个核心有独立任务队列，切换由各自管理任务处理，核间互不影响

## 七、延伸阅读

- seL4 地址空间：[[ch52d-seL4能力模型与地址空间实战]]
- 异步内核设计：[[ch52b-reL4异步微内核设计与实现]]
- SMP 内核实现：[[ch52e-reL4内核实现启动SMP与MCS]]
- FreeRTOS 任务管理：[[ch46-FreeRTOS内核源码导读任务TCB与调度器]]

> [!info] 参考来源
> 本文整理自 [reL4 官方文档 - ArceOS 移植系列](https://rel4team.github.io/zh/docs/arceos/)，包含任务、内存、中断、oskit、平台抽象五篇文档的整合。
