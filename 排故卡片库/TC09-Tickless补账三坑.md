---
title: "Tickless 唤醒后系统时钟天天漂移数秒"
tags:
  - troubleshooting
  - rtos/tickless
severity: medium
frequency: occasional
source: "[[ch50-FreeRTOS中断管理与Tickless低功耗]]"
date: 2025-01-15
---
# TC09 Tickless 补账三大坑

## 现象
低功耗产品日历每天漂移几秒到几分钟，或周期性任务忽长忽短；触发条件：Tickless 唤醒后直接用「预期睡眠时长」补账 tick，而非实测流逝时间。

## 环境与适用范围
FreeRTOS Tickless（vPortSuppressTicksAndSleep）+ STM32 LPTIM/RTC 唤醒方案；其他 RTOS 低功耗机制同理。常电满速运行系统不适用。

## 取证过程
1. 用 GPIO 翻转标记睡眠/唤醒边界，示波器实测真实睡眠时长并与补账 tick 数对照。
2. 长跑 72 小时对比设备 RTC 与标准时钟，计算日均漂移折合 ppm。
3. 人为注入中途唤醒（按键/外部中断），检查补账是按预期值还是实际值记账。
4. 读 LPTIM/RTC 计数器与唤醒时刻差，量化唤醒延迟大小。

## 根因
三个误差源叠加：① 32768Hz 晶振频偏（±20ppm 即每天约 ±1.7s，廉价晶体可达 ±50ppm）；② 从告警触发到指令恢复执行的唤醒延迟（时钟切回 PLL、ISR 进入，毫秒级）未被扣除；③ 中途被打断时按「计划时长」而非「计时器实读」补账，误差可达整个计划睡眠周期。

## 修复方案
```c
void vPortSuppressTicksAndSleep(TickType_t xExpectedIdleTime)
{
    stop_tick_and_arm_wakeup(xExpectedIdleTime);
    uint32_t t0 = READ_REG(LPTIM1->CNT);       /* 以硬件计数为准 */
    __WFI();
    /* 实测流逝计数，而非假设睡了 xExpectedIdleTime */
    uint32_t cnt   = READ_REG(LPTIM1->CNT) - t0;
    uint32_t ticks = ((uint64_t)cnt * configTICK_RATE_HZ) / LPTIM_CLK_HZ;

    ticks -= WAKE_LATENCY_TICKS;               /* 扣除标定好的唤醒延迟 */
    restore_tick();
    if (ticks) vTaskStepTick(ticks);           /* 只补实际流逝的部分 */
}
/* 频偏对策：定期与 NTP/GPS 对时闭环，或用 HSE 校准 LSE */
```

## 预防措施
- 补账一律读硬件计时器实值，禁止使用预期睡眠时长
- 唤醒延迟一次性标定（GPIO+示波器）后固化为常量
- 长期产品引入外部对时（NTP/GPS/广播授时）形成闭环
- 测试矩阵必须覆盖「睡满整周期」与「中途被打断」两条路径

## 关联
- 源章节：[[ch50-FreeRTOS中断管理与Tickless低功耗]]
- 相关章节：[[ch29-低功耗设计]]、[[ch25-定时器全家桶]]
