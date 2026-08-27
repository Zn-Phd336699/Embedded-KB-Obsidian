---
title: "DMA 缓冲误放 CCM 导致外设静默无数据"
tags:
  - troubleshooting
  - mcu/dma
severity: high
frequency: occasional
source: "[[ch06-链接器与内存布局]]"
date: 2025-01-15
---
# TC03 DMA 的 CCM 盲区判别与修复

## 现象
UART/ADC/SPI 配置全部正确却收不到任何 DMA 数据，无报错无中断；典型触发条件是缓冲区数组被链接器放进了 STM32F4 的 CCM RAM（0x10000000 起）。

## 环境与适用范围
STM32F4(F407)/F3/L4 等 CCM 仅核内可见的家族；F7/H7 的 DTCM 对通用 DMA 同样不可见（仅 MDMA 可访问）。缓冲位于普通 SRAM1/SRAM2/AXI SRAM 时不适用。

## 取证过程
1. map 文件搜索缓冲符号地址：落在 0x10000000~0x1000FFFF 区间即中招。
2. 逻辑分析仪确认外设线上有真实波形，排除发送方没发的问题。
3. 调试器观察 DMA NDTR 寄存器：不递减，或 LISR/HISR 里 TE(Transfer Error) 标志置位。
4. 查参考手册总线矩阵图：CCM 只挂在核的 D-Bus 上，没有通向 DMA 主端口的路径。

## 根因
CCM（紧耦合内存）的设计目标是零等待供核取数，物理上未接入 AHB 总线矩阵的 DMA 主端口；DMA 发起访问得到错误响应甚至根本无响应，而 HAL 库往往不检查该错误，表现为完全静默的传输失败。

## 修复方案
```ld
/* stm32f4xx.ld：为 DMA 缓冲开辟普通 SRAM 专属段 */
.dma_buffer (NOLOAD) :
{
    . = ALIGN(32);
    __dma_buffer_start = .;
    KEEP(*(.dma_buffer))
    __dma_buffer_end = .;
} >RAM1   /* RAM1 = 0x20000000 起的标准 SRAM */
```
```c
/* 使用处：显式指定段属性 */
uint8_t uart1_rx_buf[256]
    __attribute__((section(".dma_buffer"), aligned(32)));
```

## 预防措施
- 工程模板固化 `.dma_buffer` 段并写入团队编码规范
- Code Review 强制检查所有 DMA/以太网/USB 缓冲的最终链接地址
- 上电自检：对候选缓冲跑一次短 DMA 回环搬运并校验数据
- F7/H7 牢记 DTCM 只对 MDMA 可见，普通 DMA 一律避开

## 关联
- 源章节：[[ch06-链接器与内存布局]]
- 相关章节：[[ch26-DMA与Cache一致性]]、[[ch22-STM32生态与F407硬件]]
