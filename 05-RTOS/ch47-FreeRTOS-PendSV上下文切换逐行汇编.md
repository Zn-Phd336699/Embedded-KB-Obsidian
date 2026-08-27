---
title: "第47章 FreeRTOS 内核源码导读②：PendSV 上下文切换逐行汇编"
part: "[[P5-MOC]]"
chapter: 47
tags:
  - domain/rtos
  - topic/context-switch
difficulty: 5
est_minutes: 40
prerequisites:
  - "[[ch46-FreeRTOS内核源码导读任务TCB与调度器]]"
related:
  - "[[ch21-Cortex-M架构精讲]]"
  - "[[ch53-RTOS综合实战三轴云台控制器]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第47章 FreeRTOS 内核源码导读②：PendSV 上下文切换逐行汇编

> [!info] 导航
> ⏱ 40min | ★★★★★ | 前置 [[ch46-FreeRTOS内核源码导读任务TCB与调度器]] | → [[ch48-FreeRTOS-IPC五件套源码解析]]

## 🎯 学习目标
- [ ] 逐行解读 xPortPendSVHandler 三阶段汇编，说清硬件/软件压栈分界与 FPU 懒压栈时机
- [ ] 用「37 次访存账本」量化切换成本并讲清 SysTick/PendSV 分工
- [ ] 对照 RISC-V 移植层，建立可迁移到任意新内核的移植推演能力

## 47.1 为什么是 PendSV？

上下文切换必须发生在**没有任何 ISR 活动时**——若在 SysTick 里直接切换，可能被高优先级 ISR 打断导致「半切状态」灾难。方案：SysTick 只置 `NVIC->ICPR = PENDSVSET`，PendSV 设为**最低优先级**，必然最后执行且不会被打断（不存在更低者）；一次 pending 多次也只执行一次，天然去重。

## 47.2 关键代码：xPortPendSVHandler 逐行精读（port.c）

```asm
xPortPendSVHandler:
    mrs r0, psp                  ; ① 取当前任务的用户栈顶(硬件已自动压完8个core寄存器)
    isb
    ldr r3, =pxCurrentTCB        ; ──存旧── r3=&当前TCB指针
    ldr r2, [r3]
    stmdb r0!, {r4-r11, r14}     ; ② 手动压 R4~R11+EXC_RETURN(R0-R3/R12/PC/xPSR 已硬件入栈)
    str r0, [r2]                 ; ③ 新栈顶存回 TCB->pxTopOfStack(偏移0！ch46 布局即接口)
    stmdb sp!, {r3, r14}         ; ──选新── 保护 r3/lr 于 MSP
    bl vTaskSwitchContext        ; ★C函数：选出下一个任务，更新 pxCurrentTCB
    ldmia sp!, {r3, r14}
    ldr r1, [r3]                 ; ──载新── r1=新任务的 TCB
    ldr r0, [r1]                 ; r0=新任务的 pxTopOfStack
    ldmia r0!, {r4-r11, r14}     ; ④ 弹软件寄存器(含 EXC_RETURN→lr)
    msr psp, r0                  ; ⑤ 写回 PSP —— 此刻还没真正换栈！
    bx r14                       ; ⑥ 异常返回：硬件从 PSP 弹 8 字帧(lr bit4 决定 FP 恢复,见47.4)
                                 ;    PC=新任务的断点 → 世界已切换
```
> [!tip] 💡 三阶段记忆法
> **存旧**（硬件 8 个+软件 9 个→TCB）、**选新**（vTaskSwitchContext 纯 C 决策，含时间片轮转与 tickless 补偿）、**载新**（TCB→寄存器组→bx r14）。全程只碰 PSP 操作任务数据，MSP 只用于异常自身——这就是 ch21 双栈设计的兑现。

## 47.3 访存账本：切换全程 ~37 次访存的精确价格

| 阶段 | 动作 | 访存次数 |
|------|------|----------|
| 硬件压栈 | R0-R3,R12,LR,PC,xPSR → PSP | 8 写(+FP 时 18) |
| 软件压栈 | R4-R11,LR → PSP；栈顶→TCB | 9 写 +1 写 |
| 决策 | vTaskSwitchContext(C 函数) | 读就绪位图+链表若干 |
| 软件弹栈 | TCB 读栈顶；PSP 弹 R4-R11,LR | 1 读+9 读 |
| 硬件弹栈 | PSP 弹 8 寄存器，BX LR 返回 | 8 读 |
| **合计** | 「上下文切换很贵」从此有了精确价格标签 | **~37 次访存 ≈170 cycles(零等待)** |

## 47.4 FPU 懒压栈：不为不用浮点的任务买单

- 带 FPU 的 M4F 上，EXC_RETURN bit4 与 CONTROL.FPCA 共同决定硬件是否连带压 S0-S15/FPSCR，PendSV 恢复阶段同样检查 lr bit4 决定 FP 恢复序列；
- **懒压栈 LSPEN（FPCCR.ASPEN/LSPEN）**：异常时先只留占位符，首个浮点指令访问时才补压——纯整数任务的切换成本不变；
- 铁律：**SCB CPACR 使能 FPU 必须在启动调度器之前**，否则首个 FPU 任务现场必坏(ch53 电机控制栈预算相关)。

## 47.5 SysTick 的另一半职责

```c
void xPortSysTickHandler(void){
    portDISABLE_INTERRUPTS();
    if(xTaskIncrementTick()!=pdFALSE){        // tick++ 并检查解锁/轮转
        portNVIC_INT_CTRL_REG = PENDSVSET_BIT; // 需要切换→踢 PendSV
    }
    portENABLE_INTERRUPTS();                  // 短临界区包裹保证 tick 一致性
}
/* tickless 模式(ch50)：睡前算好下次唤醒的 tick 数写入 LP 定时器，
   唤醒后 xTaskCatchUpTicks 补齐“睡过去”的时间账 */
```

SysTick 自己**不做切换**——只做记账与「踢一脚」，真正交接永远交给最低优先级的 PendSV。

## 47.6 RISC-V 移植层对照（ESP32-C3/CH32V）

| M 核概念 | RISC-V 实现 |
|----------|-------------|
| 硬件自动压栈 8 寄存器 | 无！软件全量保存 32 个（portasm SAVE 寄存器组） |
| PendSV 最低优先级 | 软中断 machine software irq 充当，mtvec 分发 |
| EXC_RETURN 区分双栈 | mscratch 保存任务栈指针，切换时交换 |
| CLZ 找最高优先级 | 软件循环或 clz 扩展指令 |

## 47.7 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 切换成本想量化 | PendSV 入出口读写 DWT CYCCNT 入环形数组 | 缩短决策函数/对比 FPU 开关 | P99 ≈170 cycles@M4 |
| FPU 任务抖动异常 | 加减浮点运算对比直方图分布 | 复查 FPCCR.ASPEN/LSPEN 配置 | 懒压栈触发仅抬 max 不抬 P99(典型值) |

## 47.8 实测数据表：两任务乒乓 10 万次插桩统计（典型值口径）

| 场景 | 单次切换 | 备注 |
|------|----------|------|
| CM4F 纯整数任务 | ~170 cycles≈1µs | 37 次访存账本兑现 |
| 含 FPU 现场(懒压栈未触发) | ≈同上 | 占位符未实压 |
| 懒压栈实际触发时 | +18 写硬件帧 | 仅用浮点的任务承担 |

## 47.9 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 切换后任务跑飞 PC 异常 | 初始栈帧伪造错（PC/xPSR.T 位） | 反汇编 pxPortInitialiseStack 对照 ch21 帧格式 |
| FPU 任务间浮点寄存器污染 | FPU 未使能就切换/懒保存位未配 | SCB CPACR 使能+FPCCR.ASPEN/LSPEN；先开 FPU 再启调度 |
| 偶发栈顶损坏 | TCB 偏移 0 被编译器重排（自定义 TCB） | `_Static_assert(offsetof(tskTCB,pxTopOfStack)==0)` |
| 移植到 M0 失败 | M0 无 BASEPRI/DWT，用了不存在的指令 | 使用 portCM0 专用版本（临界区退化为 PRIMASK 全关） |

## 47.10 部署注意事项：为 M0+ 移植的差异清单

1. M0 无 BASEPRI/CLZ → 临界区退化为 PRIMASK 全关、位图用软件循环扫描（portmacro 换文件）；
2. 无 DWT → tickless 需外接 LP 定时器方案；SysTick 校准值来自 CALIB 或按 HCLK 手算，移植后第一件事用示波器量 tick 周期验证；
3. 自定义 TCB 结构体必须加 `_Static_assert` 锁死偏移 0，否则汇编偏移全错且极难排查。

> [!example]- 🧪 动手实验 L47-1：给切换代码插桩计时并画泳道（45 分钟）
> **步骤**：① 在 PendSV 入口/出口读写 DWT CYCCNT 存全局环形数组；② 两任务乒乓 10 万次；③ 导出统计 min/P50/P99/max；④ 人为在任务里加 FPU 运算对比懒压栈触发时的分布变化；⑤ 把数据画成直方图。
> **验收**：拿到你板子的「上下文切换成本」官方级数字——简历与架构文档都可用。

## 47.11 进阶话题

- **为什么恢复时先 msr psp 再 bx lr**：bx lr 触发异常返回序列从 PSP 弹硬件帧——顺序反了会从旧任务栈弹出新任务的 PC（灾难现场）；
- **PendSV pending 的去重红利**：多个 ISR 同拍请求切换也只执行一次——「延迟到安全点」设计的免费副产品；
- **RISC-V 移植心智映射**：mscratch=TCB 快照位、软中断=PendSV、全量保存=无硬件帧；同构范本见 ESP-IDF `portasm.S`——学透 M 核即可举一反三。

> [!warning]- ❓ FAQ
> **Q1：把 vTaskSwitchContext 放在保存现场之前会怎样？** 选出的「下一个任务」基于尚未落盘的旧现场决策，且新任务恢复时会覆盖仍存活于寄存器的旧任务状态——旧任务现场永久丢失。
> **Q2：mscratch 在 RISC-V 切换里扮演什么角色？** 一个每核一字的交换区：进入 trap 时用它暂存任务栈指针并换出内核栈，等价于 M 核靠 EXC_RETURN 区分 PSP/MSP 的能力。

> [!question] 📝 思考题
> 1. 若把 vTaskSwitchContext 放在保存现场之前会发生什么？推演具体灾难场景。
> 2. 为什么恢复阶段先写 PSP 再 bx lr，而不是反过来？
> 3. 给 RISC-V 版本画一张等价的三阶段流程图并标注 mscratch 的角色。

---
🏷️ #domain/rtos #topic/context-switch | 🔗 [[ch46-FreeRTOS内核源码导读任务TCB与调度器]] ← **本章** → [[ch48-FreeRTOS-IPC五件套源码解析]] | 📚 [[P5-MOC]]
