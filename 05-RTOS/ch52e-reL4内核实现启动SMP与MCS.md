---
title: "第52章进阶 reL4 内核实现：启动、SMP与MCS"
part: "[[P5-MOC]]"
chapter: 52
tags:
  - domain/rtos
  - topic/microkernel
  - topic/sel4
  - topic/smp
  - topic/mcs
difficulty: 4
est_minutes: 40
prerequisites:
  - "[[ch52d-seL4能力模型与地址空间实战]]"
related:
  - "[[ch52b-reL4异步微内核设计与实现]]"
  - "[[ch50a-FreeRTOS-SMP双核调度实战ESP32]]"
  - "[[ch45-实时性理论与调度算法]]"
has_lab: false
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第52章进阶 reL4 内核实现：启动、SMP与MCS

> [!info] 导航
> ⏱ 40min | ★★★★☆ | 前置 [[ch52d-seL4能力模型与地址空间实战]] | → [[ch52-seL4微内核能力模型形式化验证]]

## 🎯 学习目标
- [ ] 了解 reL4 Pure Rust 化的目标与启动代码移植要点
- [ ] 理解 seL4 SMP 的 big kernel lock 设计哲学
- [ ] 掌握核间中断（IPI）在 RISC-V 和 AArch64 上的实现差异
- [ ] 理解 MCS（混合关键级调度）的核心概念与升级路径
- [ ] 说清 MCS 时钟模块的架构/平台分层设计

## 一、Pure Rust 化与启动代码

### 1.1 目标

将 reL4 升级为**纯 Rust 项目**，不依赖 seL4 kernel 的任何代码和编译系统，只用 Rust 工具链生成可用内核，同时无缝接入原有 seL4 生态（如 sel4test）。

### 1.2 工作分解

| 模块 | 内容 |
|------|------|
| RISC-V 启动代码移植 | 用 Rust 重写启动汇编和初始化流程 |
| 配置系统 | reL4 config 模块，替代 CMake 配置 |
| 编译系统 v2 | 兼容原有 seL4 构建流程 |
| CMake 兼容层 | 过渡期间的编译系统兼容 |

> [!note] 现状
> reL4 基本完成所有内核模块的 Rust 重写，但编译和配置系统仍依赖 seL4 的 CMake，引入了不必要的编译选项。

## 二、SMP 多核支持

### 2.1 Big Kernel Lock 设计

seL4 的 SMP 设计相对简单：通过**内核大锁（big kernel lock）**确保内核在多核下表现与单核几乎一致，避免竞态。

> [!important] 设计哲学
> seL4 认为对于微内核来说，内核大锁并不会过多影响效率——因为内核本身极小，系统调用执行时间短，锁竞争概率低。

### 2.2 SMP 核心实现点

- **每核独立数据**：任务队列、调度状态等按核心隔离（`SmpStateData`）
- **跨核调度**：操作其他核心的 TCB 时，需通知对端重新调度
- **IPI 通信**：核间中断实现同步
- **内核大锁**：保护内核临界区
- **MCS 兼容**：SMP 下的混合关键级调度支持

### 2.3 任务队列与远程调度

在 SMP 模式下，`SCHED_APPEND` / `SCHED_ENQUEUE` 时需要增加 `remoteQueueUpdate`：
- 将需要 reschedule 的核心加入 `ipiReschedulePending` map
- 操作其他核心的 TCB 时，发送 `remoteTCBStall` 通知对端重新检查任务状态

### 2.4 IPI 核间中断

seL4 使用两个中断号：
- `irq_remote_call_ipi`：通知其他核心执行指定函数
- `irq_reschedule_ipi`：通知其他核心重新调度

**RISC-V 实现**：
- 通过 CLINT 软件中断实现，与 Timer 中断并列
- **无中断号**：需维护全局数组存储每个核心的当前 IPI IRQ
- 发送方填数组 → 发软件中断 → 接收方查数组
- 需执行 `fence` 确保数据一致性

**AArch64 实现**：
- GIC 为 SGI（Software Generated Interrupt）预留 16 个私有中断号
- IPI 与普通中断无区别，无需软件区分中断号
- 只需实现 IPI 发送函数

> [!tip] 架构差异
> RISC-V 需要软件模拟中断号分发，AArch64 硬件原生支持。这是两个架构 IPI 实现的核心区别。

## 三、MCS 混合关键级调度

### 3.1 什么是 MCS

MCS（Mixed Criticality Systems，混合关键级系统）调度用于安全关键领域，不同关键级的任务有不同的时序保证。核心是 **Scheduling Context（SC）** 能力，为每个任务分配时间预算和周期。

### 3.2 升级路径

1. **开启 MCS 编译选项**：在 CMake 配置中启用 MCS 特性
2. **reL4 添加 MCS feature**：修改 Cargo 配置和构建脚本
3. **更新 PBF 文件**：增加 SC（调度上下文）相关的位域定义

> [!warning] PBF 文件维护痛点
> 每个架构下需要为 MCS/非MCS、SMP/非SMP 维护多份 PBF 文件（2×2=4种组合）。理想方案是写一个自动解析器，从 bf 文档自动生成 pbf 文件。

### 3.3 时钟模块（MCS 基础）

MCS 需要**精确计时**，原有的单一时钟中断不够用。时钟模块采用分层设计：

```
sel4common/
├── arch/
│   ├── aarch64/timer.rs    ← 架构特定时钟逻辑
│   └── riscv/timer.rs      ← RISC-V 时钟（SBI 接口）
└── platform/
    ├── time_def.rs         ← 通用宏定义（如 1ms=1000us）
    ├── mod.rs             ← Timer trait 定义
    └── <platform>/        ← 板级特定时钟初始化
```

**分层原则**：
- `arch/`：架构通用的时钟行为
- `platform/`：特定板级的时钟初始化（寄存器读写序列）
- `time_def.rs`：跨架构通用的时间常量

> [!note] RISC-V 特殊性
> RISC-V 通过 SBI 提供时钟接口，不需要像 AArch64 那样处理 deadline IRQ 的 ack 操作。

### 3.4 MCS 相关论文阅读

reL4 文档中包含多篇 MCS 相关论文的阅读笔记：
- **Audsley 1991**：优先级分配算法
- **Vestal 2007/2008**：混合关键级系统模型
- **EDF-VD**：虚拟截止期 EDF 调度
- **EEVDF**：最早合格虚拟截止期优先
- **Response-Time Analysis for MCS**：混合关键级系统响应时间分析

## 四、延伸阅读

- FreeRTOS SMP 实战：[[ch50a-FreeRTOS-SMP双核调度实战ESP32]]
- 调度算法理论：[[ch45-实时性理论与调度算法]]
- 异步内核设计：[[ch52b-reL4异步微内核设计与实现]]
- 架构设计：[[ch52c-reL4架构设计组件化内核]]

> [!info] 参考来源
> 本文整理自 [reL4 官方文档 - 内核实现系列](https://rel4team.github.io/zh/docs/reL4kernel/)，包含启动代码、SMP 实现、MCS 支持等内容。
