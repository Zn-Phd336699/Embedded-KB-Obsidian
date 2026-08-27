---
title: "RS485 报文末字节固定 CRC 错误"
tags:
  - troubleshooting
  - protocol/uart
severity: medium
frequency: common
source: "[[ch28-串口工程化IDLE-DMA-RS485]]"
date: 2025-01-15
---
# TC05 RS485 方向切换时机错误损坏末字节

## 现象
RS485 半双工通信中每帧最后一个字节（常是 CRC 第二字节）固定损坏，接收端 CRC 校验失败率接近 100%；触发条件：DE 使能脚在中断里过早拉低切回接收。

## 环境与适用范围
任意 MCU + MAX485/SP3485 类 DE 控制收发器，Modbus-RTU 现场最常见。全双工 UART 或带自动方向控制的硬件方案不存在软件时机问题。

## 取证过程
1. 示波器 CH1 接 DE 引脚、CH2 接 RS485 A 线，触发抓一帧完整报文。
2. 观察 DE 下降沿相对最后一个停止位的位置：早于停止位结束即为切早了。
3. 对比 TXE 与 TC 中断时刻：两者相差约一个字节的发送时间。
4. 代码审查方向控制点：放在 TXE 中断、TC 中断还是 DMA 完成回调里。

## 根因
TXE 只表示数据寄存器 DR 已空，此时移位寄存器里通常还有最后一字节在逐位移出；此刻拉低 DE 会截断末尾位流。TC（Transmission Complete）要等移位寄存器也清空才置位，才是唯一安全的方向切换点。

## 修复方案
```c
/* 错误示范：在 TXE 中断里切方向 —— 截断末字节 */
// if (USART_GetITStatus(USART1, USART_IT_TXE))
//     if (--tx_left == 0) RS485_DE_RX();          /* 太早! */

/* 正确做法：在 TC 中断里切方向 */
void USART1_IRQHandler(void)
{
    if (USART_GetITStatus(USART1, USART_IT_TC)) {
        USART_ClearITPendingBit(USART1, USART_IT_TC);
        RS485_DE_RX();                    /* 移位寄存器已空，安全 */
    }
}

/* 发送最后一字节前记得使能 TC 中断源 */
__HAL_UART_ENABLE_IT(&huart1, UART_IT_TC);
```

补充：STM32 较新系列 USART 内建硬件 DE 控制（DEM 位 + DEAT/DEDT 前后沿延时），可彻底消除软件时序依赖。

## 预防措施
- 方向切换只认 TC 完成，永远不用 TXE 判断「发完」
- 每版固件回归「末字节 CRC」专项测试用例
- 优先选带硬件 DE 的 MCU 或自方向收发器（如 MAX13487）
- 高波特率场景用示波器实测切换时序裕量并存档

## 关联
- 源章节：[[ch28-串口工程化IDLE-DMA-RS485]]
- 相关章节：[[ch75-UART-RS485与Modbus-RTU实战libmodbus]]、[[ch18-示波器实战]]
