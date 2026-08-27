---
title: "M7 开 Cache 后 DMA 收到的数据全是旧值或零"
tags:
  - troubleshooting
  - mcu/cache
severity: high
frequency: common
source: "[[ch26-DMA与Cache一致性]]"
date: 2025-01-15
---
# TC04 M7 Cache 一致性三方案

## 现象
Cortex-M7（STM32F7/H7）使能 D-Cache 后，DMA 收到的数据 CPU 读出来全是 0 或上一轮旧值；触发条件：RX 缓冲位于可缓存普通内存且未做任何 Cache 维护。

## 环境与适用范围
Cortex-M7 全家族（D-Cache 行 32 字节），H7 以太网描述符同理。M0+/M3/M4 无 Cache 不存在此问题；关闭 D-Cache 运行时也不适用。

## 取证过程
1. 完成回调处断点：调试器 Memory 窗口看物理内存是对的，而代码读到的变量是旧值——缓存滞留实锤（调试主端口不经过 D-Cache）。
2. 读 `SCB->CCR` 确认 DCACHE 位已置 1。
3. 查 map 文件核对缓冲是否 32 字节对齐、是否与其他变量共享缓存行。
4. 逻辑分析仪比对线上真实数据与 CPU 所见差异，量化「旧了几轮」。

## 根因
DMA 直接读写内存、绕过 CPU 缓存：RX 方向 CPU 命中陈旧缓存行读到垃圾；TX 方向脏行尚未回写就被 DMA 取走旧数据。缓存行 32 字节，Invalidate 还会把同行的相邻变量连带误伤（false sharing）。

## 修复方案
| 方案 | 做法 | 适用场景 |
|------|------|----------|
| 非缓存区 | MPU 划 region 为 Non-cacheable | 缓冲多、想一劳永逸 |
| 手动维护 | TX 前 Clean、RX 前后 Invalidate | 少量大缓冲、追求性能 |
| 关 D-Cache | SCB_DisableDCache() | 仅临时对比验证，量产禁用 |

```c
/* 方案一：MPU 把 0x20048000 起 16KB 设为非缓存区 */
MPU_Region_InitTypeDef m = {0};
HAL_MPU_Disable();
m.Enable = MPU_REGION_ENABLE;      m.Number = MPU_REGION_NUMBER0;
m.BaseAddress = 0x20048000;        m.Size   = MPU_REGION_SIZE_16KB;
m.AccessPermission = MPU_REGION_FULL_ACCESS;
m.IsCacheable  = MPU_ACCESS_NOT_CACHEABLE;
m.IsBufferable = MPU_ACCESS_NOT_BUFFERABLE;
HAL_MPU_ConfigRegion(&m);
HAL_MPU_Enable(HAL_MPU_HFNMI_PRIVDEF);

/* 方案二：手动维护（缓冲必须 32B 对齐且独占整行）*/
__attribute__((aligned(32))) static uint8_t rxbuf[512];
HAL_UART_Receive_DMA(&huart1, rxbuf, sizeof rxbuf);
/* 完成回调内：先 Invalidate 再读数据 */
SCB_InvalidateDCache_by_Addr(rxbuf, sizeof rxbuf);
/* 发送方向：启动 DMA 前 Clean 把脏行落盘 */
SCB_CleanDCache_by_Addr((uint32_t *)txbuf, sizeof txbuf);
```

## 预防措施
- 新项目先定「DMA 内存策略」再写外设驱动
- 缓冲 32B 对齐独占缓存行，邻接处不放高频变量
- RX 流程在启动前和完成后各做一次 Invalidate
- 移植 ST 例程必查其内存放置假设（不少例程默认关着 Cache）

## 关联
- 源章节：[[ch26-DMA与Cache一致性]]
- 相关章节：[[ch06-链接器与内存布局]]、[[chs2-SO2-MCU系统优化实战]]
