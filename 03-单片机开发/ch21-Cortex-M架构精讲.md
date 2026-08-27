---
title: "第21章 Cortex-M架构精讲"
part: "[[P3-MOC]]"
chapter: 21
tags:
  - domain/mcu
  - topic/architecture
difficulty: 4
est_minutes: 40
prerequisites:
  - "[[ch20-频谱仪与射频排障]]"
related:
  - "[[ch05-ARM汇编与反汇编排障]]"
  - "[[ch47-FreeRTOS-PendSV上下文切换逐行汇编]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第21章 Cortex-M架构精讲：存储映射、双栈、中断旅程与MPU

> [!info] 导航
> ⏱ 40min | ★★★★☆ | 前置 [[ch20-频谱仪与射频排障]] | → [[ch22-STM32生态与F407硬件]]

## 🎯 学习目标
- [ ] 默画 M3/M4 四段存储映射，说清双栈四种组合及 RTOS 标配选法
- [ ] 完整讲述一次中断的六步旅程，解码 EXC_RETURN 关键位域
- [ ] 说明 FPU 懒压栈机制并给出 FreeRTOS 环境 MPU 五区域模板

## 21.1 存储映射一张图

| 区间 | 用途 | F407 实例 |
|------|------|-----------|
| 0x00000000~0x1FFFFFFF | 代码区（别名映射） | BOOT 配置决定别名指向 Flash／系统存储／SRAM |
| 0x20000000~0x3FFFFFFF | SRAM 区 | 128K 主 SRAM + 64K CCM（0x10000000 起） |
| 0x40000000~0x5FFFFFFF | 外设区 | APB1/APB2/AHB 全部外设寄存器 |
| 0xE0000000~0xFFFFFFFF | 私有外设总线 | SysTick/NVIC/SCB/DWT/ITM/TPUI |

## 21.2 双栈与特权级：四种组合

两个栈指针 MSP（主栈，复位默认）/PSP（进程栈）× 两种模式 Thread/Handler 组成四种形态：**Thread+MSP**=简单裸机，main 与 ISR 共用一个栈；**Thread+PSP**=RTOS 标配，每任务独立 PSP 栈、内核与 ISR 统一走 MSP；**Handler 永远用 MSP 且永远特权级**。CONTROL 寄存器的 SPSEL/nPRIV 位负责切换；SVC 指令是用户态进入特权态的唯一正门——RTOS 系统调用的基石。

## 21.3 中断完整旅程（面试高频）

1. **事件发生**——EXTI 置 pending 位；
2. **NVIC 仲裁**——抢占优先级 → 子优先级 → IRQ 号依次比较；
3. **硬件自动压栈**（12 周期）——xPSR/PC/LR/R12/R3~R0 共 8 字 + 可选对齐填充；
4. **取向量执行**——LR 装入 EXC_RETURN 当「返回车票」；
5. **尾链 Tail-Chaining**——背靠背中断免重复出入栈，仅 6 周期衔接；
6. **晚到 Late-Arrival**——压栈途中来了更高优先级，直接顶替当前处理。

## 21.4 EXC_RETURN 位域与关键代码

| bit | 含义 | 备注 |
|-----|------|------|
| [31:5] | 固定 0xFFFFFFF 前缀 | 合法值屈指可数 |
| [4] FType | 1=标准帧 | 0 表示含 FP 扩展帧（仅 M4F/M7） |
| [3] Mode | 0=Handler / 1=Thread | 返回后所处模式 |
| [2] SPSEL | 0=MSP / 1=PSP | 恢复现场用哪个栈看这里 |
| [1] | 保留 | - |
| [0] ES | 安全扩展（Armv8-M） | M23+/M33 相关，M4 恒 0 |

三个常见值：`0xFFFFFFF1`=返回 Handler+MSP；`0xFFFFFFF9`=返回 Thread+MSP；`0xFFFFFFFD`=返回 Thread+PSP（RTOS 任务被打断的标志）。

```c
/* 异常入口通用地取回被打断现场的栈指针 */
void *get_stacked_ctx(uint32_t exc_return)
{
    return (exc_return & 0x4u) ? (void *)__get_PSP()   /* bit2=1 → PSP */
                               : (void *)__get_MSP();  /* bit2=0 → MSP */
}
```

## 21.5 FPU 懒压栈三步舞（Lazy Stacking）

```text
① 任务用过 FPU 且 FPCCR.ASPEN=1 → 异常入栈时先在栈上预留 FP 帧
② 该异常处理若不用 FPU → 只写 FPCCR.LSPACT 标志，s0~s15 不真压（懒）
③ 处理器要用 FPU → 触发懒保存故障，此刻才把 s0~s15 补压进保留帧
收益：中断延迟从「+17 字压栈」降为固定开销；代价：栈预算必须按满帧 26 字算！
```

## 21.6 启动四步曲与 MPU 五区域模板

启动四步曲：①BOOT 引脚采样（BOOT0=0→Flash 常规启动；BOOT0=1,BOOT1=0→系统 bootloader 串口/USB ISP 救砖；全 1→SRAM 调试）；②SCB->VTOR 定位向量表（可重定位，IAP 双程序区的关键，见 [[ch30-Bootloader-IAP-OTA固件升级体系]]）；③Reset_Handler：设栈→SystemInit(时钟)→data/bss→__libc_init_array→main；④__libc_init_array 跑全局构造与 .init_array 表。

FreeRTOS 环境实用划分：

| 区域 | 范围 | 属性 | 目的 |
|------|------|------|------|
| R0 | Flash 全部 | RO、XN=否 | 代码只读防篡改 |
| R1 | .data/.bss 全局区 | RW、XN | 数据不可执行（防注入） |
| R2 | 每任务栈底哨兵页 | no-access | 栈溢出立即触发（[[ch15-内存问题排查三板斧]]） |
| R3 | 外设区 | 特权 RW、XN | 用户态任务禁摸寄存器 |
| R4 | DMA 缓冲池 | non-cacheable(M7) | 一致性简化（[[ch26-DMA与Cache一致性]]） |

## 21.7 实测数据表：关键操作真实周期（M4@168MHz）

| 操作 | 周期 | 说明 |
|------|------|------|
| 中断进入+硬件入栈 | 12 | 零等待内存下 |
| 尾链（背靠背中断） | 6 | 免重复出入栈红利 |
| 晚到抢占切换 | +6 | Late-arrival 开销 |
| SVC 进入→handler 首指令 | ~11 | 含取向量 |
| FPU 懒保存触发补压 | +12~13 | s0~s15 真压栈时刻 |

## 21.8 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 栈偶发跑飞 | MPU 哨兵页 BusFault 地址 | 按满帧 26 字重算 ISR 栈预算 | 故障地址落在哨兵页即证实 |
| 改 VTOR 后取指错乱 | 反汇编取向量地址 | 切表前关中断并清 pend | 旧表 pending 已排空 |

## 21.9 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 中断偶发丢失一次 | pending 清除时机不当/优先级配置冲突 | 查 NVIC 分组一致性；DWT 计数比对预期 |
| HardFault 后进不了 fault handler | handler 自身用了非法资源（如未初始化外设） | naked handler+纯寄存器取证（[[ch05-ARM汇编与反汇编排障]]）；锁死向量表地址 |
| SVC 调用后死循环 | SVC handler 里又触发 SVC（同类不可嵌套） | 系统调用避免递归入口；用 PendSV 做切换载体 |
| MPU 使能后莫名 BusFault | 区域未覆盖背景区/对齐边界错误 | 区域须 32B 对齐且 size 为 2^n；打印 RBAR/RASR 核对 |

## 21.10 部署注意事项

1. RTOS 工程 ISR 统一走 MSP 栈：单独核算最深嵌套水位（满帧 26 字起步）
2. 改 VTOR 的安全窗口：旧表 pending 必须先排空——「关全局中断→清 pend→改表」标准序
3. 全关中断用 PRIMASK；BASEPRI 写 0 是「不屏蔽任何」，两者语义别混
4. 向 M33/M55 迁移注意 TrustZone：NSCALL 边界过 SG 指令门，参数校验放安全侧不可见处

> [!example]- 🧪 动手实验 L21-1：亲历一次 SVC 双栈切换（40 分钟）
> **步骤**：裸机工程启用 PSP（CONTROL.SPSEL=1）跑两个任务轮转的极简调度器；SVC handler 入口断点记录 MSP/PSP；step-over 到 BX LR 后再读两栈指针；GDB 里 `x/16xw $psp` 找到硬件压栈帧中的 PC/xPSR 并核对指向任务代码。
> **验收**：画出一张「切换前后两栈内容对照图」——它是理解 PendSV 上下文切换的钥匙。

## 21.11 进阶话题

- 架构对照 RISC-V RV32IMAC：定长指令+C 压缩扩展、CLINT/CLIC 平台定义中断、软件全量保存现场、A 扩展 amo/LR-SC 原子操作——迁移时上下文保存成本要重估
- 位带别名是 M3 专属，M4 没有——移植老代码遇到位带宏需改写为 BSRR 或掩码操作
- DWT 是免费 profiler：EXCCNT/SLEEPCNT/LICNT 拆解「CPU 时间去哪了」（联动 [[ch16-perf-ftrace-strace性能剖析]]）；权威出处 ARMv7-M ARM(DDI 0403E) B1.5.8/B1.5.13

> [!warning]- ❓ FAQ
> **Q1：为什么 FreeRTOS 把上下文切换放在 PendSV 里做？** PendSV 可挂起且优先级能设最低，保证切换发生在所有中断处理完之后，不会把现场「卡在中途」（逐行汇编见 [[ch47-FreeRTOS-PendSV上下文切换逐行汇编]]）。
> **Q2：EXC_RETURN 为什么长得像非法地址？** 它是内核内部标记而非可访问内存，BX LR 时由硬件识别并触发异常返回流程，绝不能当普通地址解引用。

> [!question] 📝 思考题
> 1. 两个同抢占优先级的中断同时到达，最终执行顺序由什么规则决定？
> 2. 为什么 FreeRTOS 把上下文切换放在 PendSV 而非 SVC/SysTick？落地 MPU 五区域模板时 RBAR/RASR 怎么算？

---
🏷️ #domain/mcu #topic/architecture | 🔗 [[ch20-频谱仪与射频排障]] ← **本章** → [[ch22-STM32生态与F407硬件]] | 📚 [[P3-MOC]]
