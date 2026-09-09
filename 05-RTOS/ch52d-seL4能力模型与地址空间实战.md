---
title: "第52章入门 seL4 能力模型与地址空间实战"
part: "[[P5-MOC]]"
chapter: 52
tags:
  - domain/rtos
  - topic/microkernel
  - topic/sel4
  - topic/memory
difficulty: 3
est_minutes: 30
prerequisites:
  - "[[ch52a-seL4基本介绍与设计原则]]"
related:
  - "[[ch52-seL4微内核能力模型形式化验证]]"
  - "[[ch52b-reL4异步微内核设计与实现]]"
has_lab: false
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第52章入门 seL4 能力模型与地址空间实战

> [!info] 导航
> ⏱ 30min | ★★★☆☆ | 前置 [[ch52a-seL4基本介绍与设计原则]] | → [[ch52-seL4微内核能力模型形式化验证]]

## 🎯 学习目标
- [ ] 理解 capability 机制的核心思想与 syscall 处理流程
- [ ] 掌握 capability 的显式传递（Copy/Mint）与隐式传递（IPC捎带）
- [ ] 说清 untyped 内存分配与 capability 创建的两步过程
- [ ] 理解 seL4 内存管理四对象：asid_pool / vspace / page_table / frame
- [ ] 描述 seL4 进程创建与内存初始化的用户态实现流程

## 一、Capability 机制核心

### 1.1 一句话理解

> 将内核中所有实例抽象为能力，存储在能力空间（CSpace）中，内核根据 index 找到对应能力，再根据能力找到实例地址。

**与 Linux syscall 的本质区别**：
- Linux：syscall 是一个个独立函数
- seL4：syscall 是**对某个 capability 进行操作**，capability 就是内核对象/服务

可以将 cptr 理解为 C++ 智能指针：指向同一个实例，但可以有多个智能指针。

### 1.2 syscall 处理流程（以 TCBSuspend 为例）

```
用户态调用 seL4_TCB_Suspend(cptr)
    ↓
内核根据 cptr 在 CSpace 中查找 capability
    ↓
验证 capability 类型是否为 TCB、权限是否足够
    ↓
调用对应 handler（invoke_tcb_suspend）
    ↓
操作 TCB 实例，挂起线程
```

## 二、Capability 的传递

### 2.1 显式传递

通过 `seL4_CNode_Copy` / `seL4_CNode_Mint` 等系统调用，将一个 cslot 从一个 CNode 拷贝到另一个 CNode。

| 操作 | 功能 |
|------|------|
| `Copy` | 复制 capability，可设置权限 |
| `Mint` | 复制 capability，可设置权限和徽章（badge） |
| `Move` | 移动 capability |
| `Delete` | 删除一个 capability |
| `Revoke` | 删除所有派生出去的子 capability |

> [!example] 典型场景
> root-task 创建一个 capability，通过 `Copy` 传递给子任务。内核中处理流程：查找源 cslot → 验证权限 → 在目标 CNode 中分配空 cslot → 拷贝 cptr。

### 2.2 隐式传递（IPC 捎带）

通过 Endpoint 通信时，在 IPC Buffer 的 `extra_cap` 字段捎带一个 cptr。

**发送方**：将 cptr 放入 IPC Buffer
**接收方**：在 IPC Buffer 中指定 `receiveCNode`、`receiveIndex`、`receiveDepth`
**内核**：将发送方的 cslot **move** 到接收方的 recv_slot

> [!tip] 设计要点
> 隐式传递是 move 语义，不是 copy。发送方传递后不再持有该 capability。

## 三、Capability 的创建

### 3.1 Untyped 能力

所有内核对象的内存都由 **untyped 能力**分配。内核初始化时，将所有可用物理内存打包为 untyped 能力交给 root-task。

> [!important] 关键理解
> untyped 能力告诉用户态"你有一段可分配的物理内存"，但：
> - 这段内存**不映射到用户地址空间**，只有内核可访问
> - 用户态**不知道**这段空间的大小和起始地址
> - 用户态只能告诉内核"我要从这段内存中 new 一个对象"

可以将 untyped 理解为物理内存分配器（physical memory allocator）。

### 3.2 创建过程（两步）

```
第一步：从 untyped 分配内存，创建内核对象实例
        ↓ seL4_Untyped_Retype
第二步：创建 cptr 包装对象，存入目标 cslot
```

**untyped 能力的特殊性**：其他 cap 类型都存储指向实例的指针，而 untyped 的所有信息（起始地址、长度）都存在 2usize 的位图中，没有独立的实例结构体。

> [!warning] 内存分配特点
> seL4 的 untyped 分配是**顺序划分**，相对粗糙。回收机制较为复杂，这也是微内核内存管理的设计权衡。

## 四、地址空间（VSpace）设计

### 4.1 内存管理四对象

| 对象 | 作用 | 数量 |
|------|------|------|
| `asid_pool` | ASID 池，管理地址空间ID | 全局1个，root-task控制 |
| `vspace` | 一级页表（最高级页表） | 每个任务1个 |
| `page_table` | 其他级页表 | 按需创建 |
| `frame` | 页帧（实际物理内存） | 按需分配 |

### 4.2 Frame 大小（以 aarch64 为例）

- **Page**：4 KiB
- **LargePage**：2 MiB
- **HugePage**：1 GiB

### 4.3 单页表设计

seL4 是**单页表设计**：内核空间和用户空间共用一个页表。

创建新任务的 vspace 时，通过 `copyGlobalMappings` 将内核 PTE 复制到新任务的一级页表中。

> [!note] 架构差异
> 上述 `copyGlobalMappings` 流程主要在 RISC-V 中，因为 RISC-V 只有一个 root PTE。

## 五、进程创建流程

### 5.1 宏内核 vs seL4

**宏内核（Linux）**：内核负责创建地址空间、读取ELF、分配页帧、建立映射、写入页表寄存器

**seL4**：内核只负责创建页帧、页表等原语，**整个进程创建过程由用户态自己实现**

> [!important] 设计哲学
> seL4 内核尽量将功能踢到用户态，root-task 本质上是对内核功能的补充。

### 5.2 seL4 任务创建步骤（用户态实现）

```
1. 从 untyped 创建 vspace（一级页表）
2. 从 asid_pool 分配 ASID，绑定到 vspace
3. copyGlobalMappings：复制内核空间映射
4. 读取并解析 ELF 文件
5. 按 ELF 段分配 frame，创建 page_table，建立映射
6. 创建 TCB，设置 vspace、IPC Buffer、入口地址
7. 启动任务
```

### 5.3 动态内存分配

任务启动后的动态分配与进程加载流程相同，但采用**惰性分配**：
- 不需要预先创建所有页表
- 访问缺页时才创建对应页表和页帧

## 六、reL4 Linux Kit

`rel4-linux-kit` 是 reL4 提供的用户态运行时框架，封装了：
- root-task 初始化
- 任务创建与管理
- capability 分配与传递
- 中断注册（RegisterIRQ 服务通过 IPC 隐式传递 capability）
- 内存管理

它降低了 seL4 应用开发的门槛，让开发者无需从零实现所有用户态机制。

## 七、延伸阅读

- seL4基础：[[ch52a-seL4基本介绍与设计原则]]
- 能力模型深入：[[ch52-seL4微内核能力模型形式化验证]]
- 异步内核设计：[[ch52b-reL4异步微内核设计与实现]]
- Linux内存管理对比：[[ch58-字符设备驱动hello-drv到并发安全]]

> [!info] 参考来源
> 本文整理自 [reL4 官方文档 - 入门教程系列](https://rel4team.github.io/zh/docs/beginners/)，包含 seL4_cap、vspace、rel4_linux_kit 三篇入门文档的整合。
