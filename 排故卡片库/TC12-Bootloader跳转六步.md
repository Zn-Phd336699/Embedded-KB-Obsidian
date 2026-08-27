---
title: "Bootloader 跳转 App 后首个中断必死机"
tags:
  - troubleshooting
  - mcu/bootloader
severity: high
frequency: common
source: "[[ch30-Bootloader-IAP-OTA固件升级体系]]"
date: 2025-01-15
---
# TC12 Bootloader 跳转六步

## 现象
跳转后偶发 HardFault、一开中断就死机、或 App 压根没起来；典型触发条件：Bootloader 里一句 `((void(*)())addr)()` 直接跳转，省略了现场清理与合法性校验。

## 环境与适用范围
Cortex-M0+/M3/M4/M7 的任意 Bootloader（IAP、MCUboot 自研变体）。Linux/Cortex-A 启动链走 U-Boot 引导机制，不适用本卡。

## 取证过程
1. 跳转前断点：检查目标地址首字（App 栈顶初值 MSP）是否落在 RAM 合法区间。
2. 检查第二字（Reset_Handler 地址）bit0 是否为 1（Thumb 位）。
3. 跳转成功但首个中断即 HardFault：查 `SCB->VTOR` 是否仍指向 Bootloader 向量表。
4. 随机时刻死机：查 NVIC 是否残留 pending 中断，跳转瞬间取到旧向量表。

## 根因
改 PC 只是跳转，不会收拾现场：SysTick 还在打点、NVIC 还有挂起请求、VTOR 还指着 BL 的向量表。这些残留任何一个在跳转前后触发，CPU 就会按旧向量表取址执行——要么跑进 Bootloader 代码造成状态错乱，要么取到无效地址直接 HardFault。

## 修复方案
```c
static void jump_to_app(uint32_t base)
{
    uint32_t msp   = *(volatile uint32_t *)(base + 0); /* App 初始栈顶 */
    uint32_t reset = *(volatile uint32_t *)(base + 4); /* 复位向量 */

    /* (1) 校验：MSP 落在 RAM 区且复位向量带 Thumb 位 */
    if (((msp & 0xFF000000U) != 0x20000000U) || !(reset & 1U)) {
        log_err("app image invalid");
        return;
    }
    __disable_irq();
    for (int i = 0; i < 8; i++) {      /* (2) 清中断(M0 仅 1 组) */
        NVIC->ICER[i] = 0xFFFFFFFFU;   /*     关闭全部 IRQ */
        NVIC->ICPR[i] = 0xFFFFFFFFU;   /*     清除全部挂起 */
    }
    SysTick->CTRL = 0;                 /* (3) 停节拍/复位已用外设 */
    SCB->VTOR = base;                  /* (4) 向量表指向 App */
    __set_MSP(msp);                    /* (5) 装载主栈指针 */
    __DSB(); __ISB();
    ((void (*)(void))reset)();         /* (6) 跳复位向量 */
}
```

## 预防措施
- 六步封装成单一入口函数，禁止散落多处各自跳转
- App 工程同步修改链接基址与 VTOR 偏移，二者必须配套
- 跳转失败留日志并兜底回到 BL 待升级状态
- 用中断密集用例验收：跳转后立刻触发 EXTI/SysTick

## 关联
- 源章节：[[ch30-Bootloader-IAP-OTA固件升级体系]]
- 相关章节：[[ch21-Cortex-M架构精讲]]、[[ch38-SoC启动链深度剖析]]
