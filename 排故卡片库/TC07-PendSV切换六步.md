---
title: "改坏 EXC_RETURN 后首次任务切换即 HardFault"
tags:
  - troubleshooting
  - rtos/context-switch
severity: high
frequency: occasional
source: "[[ch47-FreeRTOS-PendSV上下文切换逐行汇编]]"
date: 2025-01-15
---
# TC07 PendSV 切换六步速记与 EXC_RETURN 踩坑

## 现象
移植或手改 FreeRTOS 移植层后，调度器一启动、第一次任务切换就 HardFault 或跳飞到野地址；典型触发条件：PendSV 汇编里 LR（EXC_RETURN）被 `bl` 指令悄悄覆盖。

## 环境与适用范围
Cortex-M3/M4/M7 + FreeRTOS 官方 port（M0 无 PSP 偏差，FPU 版本多一层扩展帧）。纯官方未改动 port 出此问题概率极低。

## 取证过程
1. 断点在 PendSV 入口：确认 LR=0xFFFFFFFD（线程模式/PSP/无 FPU 扩展）。
2. 单步观察 `bl vTaskSwitchContext` 前后 LR 的值——`bl` 会无条件覆盖 LR。
3. 检查汇编是否在调用 C 函数前把 {r14} 压栈、返回后弹回。
4. 与官方对应内核版本的 port.c 反汇编逐条 diff。

## 根因
EXC_RETURN 不是普通返回地址，而是控制异常返回行为的「指令字」（决定回线程/处理模式、MSP/PSP、FPU 帧）。`bl` 调用 C 函数必然破坏 LR；若不预先保存，末尾 `bx lr` 就带着垃圾值异常返回，CPU 解析成非法跳转 → INVSTATE 或总线错误。

## 修复方案
```asm
PendSV_Handler:                    ; 六步速记：存→记→护→选→取→还→返
    mrs     r0, psp                ; (1)存：读当前任务的 PSP
    stmdb   r0!, {r4-r11}          ;     手动压入 callee-saved 寄存器
    ldr     r1, =pxCurrentTCB
    ldr     r1, [r1]
    str     r0, [r1]               ; (2)记：新栈顶写回旧 TCB 首字段
    push    {r14}                 ; ★护：EXC_RETURN 先压栈
    bl      vTaskSwitchContext     ; (3)选：bl 会覆盖 LR，必须先护
    pop     {r14}
    ldr     r1, =pxCurrentTCB
    ldr     r1, [r1]
    ldr     r0, [r1]               ; (4)取：读出新任务栈顶
    ldmia   r0!, {r4-r11}          ; (5)还：弹出寄存器组
    msr     psp, r0                ;     写回 PSP
    bx      r14                    ; (6)返：EXC_RETURN 决定回到线程态/PSP
```

## 预防措施
- 未完全理解 EXC_RETURN 生命周期前不要动 port 层汇编
- 任何 `bl` 之前先压栈 r14，调用返回后立即恢复
- 打开 configASSERT 与 configCHECK_FOR_STACK_OVERFLOW 辅助暴露问题
- 移植层变更必须 diff 官方同版本 port.c/portmacro.h
- FPU 场景注意 lazy stacking 与 EXC_RETURN bit4 语义

## 关联
- 源章节：[[ch47-FreeRTOS-PendSV上下文切换逐行汇编]]
- 相关章节：[[ch46-FreeRTOS内核源码导读任务TCB与调度器]]、[[ch21-Cortex-M架构精讲]]
