---
title: "HardFault 进死循环，四种崩溃指纹定真凶"
tags:
  - troubleshooting
  - mcu/exception
severity: high
frequency: common
source: "[[ch05-ARM汇编与反汇编排障]]"
date: 2025-01-15
---
# TC01 HardFault 四大指纹识别与对策

## 现象
程序突然跳进 HardFault_Handler 死循环，复现无规律；空函数指针、非法跳转、坏指针访存、栈溢出踩帧都会触发，不做指纹分析只能盲猜。

## 环境与适用范围
Cortex-M0+/M3/M4/M7 全家族（STM32/GD32/NXP LPC 等），任意编译器与调试器。不适用于 Cortex-A/Linux 场景（应分析内核 Oops）。

## 取证过程
1. 读 `SCB->HFSR`(0xE000ED2C)：FORCED=1 表示可配置故障升级而来，继续拆 CFSR。
2. 读 `SCB->CFSR`(0xE000ED28)，按 MMFSR/BFSR/UFSR 三段解码，记下 INVSTATE、IMPRECISERR、BFARVALID 等位。
3. BFARVALID=1 时读 `SCB->BFAR`(0xE000ED38) 得精确出错地址；MMARVALID=1 同理读 MMFAR。
4. 按 EXC_RETURN bit2 判断压栈用 MSP 还是 PSP，从对应栈取出 8 字异常帧，锁定 stacked PC/LR。
5. 用 addr2line 或 map 文件把 stacked PC 映射到函数行号，反汇编回溯调用链。

## 根因：四大指纹对照表
| 指纹 | 现场特征 | 机制与对策 |
|------|----------|------------|
| PC≈0 | stacked PC=0x00000000，常伴 INVSTATE | 空函数指针被调用：调用前判空 + MPU 封 0 页 |
| INVSTATE | UFSR.INVSTATE=1，目标地址 bit0=0 | 丢失 Thumb 位：函数指针赋值时保持最低位为 1 |
| BFAR 偏移 | BFARVALID=1 且 BFAR 指向固定偏移 | 结构体/数组越界：用 BFAR 减成员偏移反推肇事变量 |
| 重复 LR | 栈帧里 LR=0xFFFFFFFx（EXC_RETURN 值） | 异常套异常或栈溢出破坏帧：查栈水位与嵌套深度 |

## 修复方案
```c
/* 统一 HardFault 出口：提取现场打印后复位，不留死循环 */
void HardFault_Handler(void)
{
    __asm volatile(
        "tst   lr, #4        \n"    /* bit2: 用 MSP 还是 PSP */
        "ite   eq            \n"
        "mrseq r0, msp       \n"
        "mrsne r0, psp       \n"
        "mov   r1, lr        \n"
        "b     hardfault_dump\n");
}

void hardfault_dump(uint32_t *frame, uint32_t exc_return)
{
    LOG_ERR("PC=%08lX LR=%08lX CFSR=%08lX BFAR=%08lX",
            frame[6], frame[5], SCB->CFSR, SCB->BFAR);
    LOG_ERR("EXC_RET=%08lX", exc_return);
    NVIC_SystemReset();             /* 现场留痕后重启 */
}
```

## 预防措施
- 函数指针定义即初始化，调用前判空
- 跳转/调用目标地址必须保持 bit0=1（Thumb 位）
- 使能 UsageFault/BusFault/MemManage，别让它们全挤进 HardFault
- 栈底填充魔数定期巡检，开启栈溢出钩子函数
- HardFault 处理器打印现场后复位，禁止 while(1)

## 关联
- 源章节：[[ch05-ARM汇编与反汇编排障]]
- 相关章节：[[ch21-Cortex-M架构精讲]]、[[ch24-中断系统与NVIC深度应用]]、[[ch15-内存问题排查三板斧]]
