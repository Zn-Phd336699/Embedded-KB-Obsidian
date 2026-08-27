---
title: "I2C 复位后 SDA 被从机拉死，总线锁死"
tags:
  - troubleshooting
  - protocol/i2c
severity: high
frequency: common
source: "[[ch76-I2C协议与排障时钟拉伸总线锁死多主机]]"
date: 2025-01-15
---
# TC02 I2C 总线锁死九步解锁 SOP

## 现象
I2C 外设初始化后 SDA 恒为低电平、外设报 BUSY/超时无法通信；典型触发条件是主机在读事务中途被复位（看门狗咬狗/调试器下载固件）。

## 环境与适用范围
所有 I2C 从机器件 + 任一 MCU 主机（STM32 HAL、ESP-IDF、Linux i2c-gpio 均适用）。不适用于硬件短路导致的 SDA-SCL 粘连（先万用表排除线路故障）。

## 取证过程
1. 万用表/示波器确认 SDA≈0V、SCL≈3.3V，且主机能翻转 SCL——锁定「从机拉死 SDA」而非线路粘连。
2. 回顾日志确认复位前是否处于多字节读中途（从机正在送出第 N 个字节）。
3. 把主机的 SCL/SDA 引脚改配为开漏 GPIO 输出并置高，脱离 I2C 外设控制。
4. 逐个补打时钟脉冲，每打一个用示波器看 SDA 是否释放（从机吐完本字节即松手）。
5. 释放后补发 STOP 条件，再做一次总线扫描验证全部器件 ACK 正常。

## 根因
I2C 从机以字节为单位移位收发；主机中途消失后从机停在「已输出部分位」状态，固执地拉住 SDA 等剩余时钟。规范解法是主机补足至多 9 个 SCL 脉冲让它完成当前字节，再给一个 STOP 让其状态机回到空闲态。

## 修复方案
```c
/* 九步恢复的核心第 4~5 步：时钟脉冲 + STOP 释放总线 */
int i2c_bus_recover(gpio_t scl, gpio_t sda)
{
    gpio_config_od(scl);  gpio_config_od(sda);   /* 开漏输出 */
    gpio_set(scl, 1);     gpio_set(sda, 1);      /* 总线空闲态 */

    for (int i = 0; i < 9; i++) {                /* 至多 9 个脉冲 */
        if (gpio_get(sda)) break;                /* SDA 已释放 */
        gpio_set(scl, 0);  delay_us(5);
        gpio_set(scl, 1);  delay_us(5);          /* tHIGH>=4us @100kHz */
    }
    /* 产生 STOP：SCL 高电平期间 SDA 由低到高 */
    gpio_set(sda, 0);  delay_us(5);
    gpio_set(scl, 1);  delay_us(5);
    gpio_set(sda, 1);  delay_us(5);

    return gpio_get(sda) ? 0 : -1;               /* 仍低则转入断电分支 */
}
```

## 预防措施
- 驱动 open/初始化前先探测 SDA 电平，低则自动执行恢复例程
- 主机复位流程加入「发 STOP 再走」的善后步骤
- 选用带总线超时(Timeout/SMBus Timeout)功能的从机或 I2C 控制器
- 多电源域系统保证主机与从机同域上/断电，避免单方复位

## 关联
- 源章节：[[ch76-I2C协议与排障时钟拉伸总线锁死多主机]]
- 相关章节：[[ch19-逻辑分析仪与sigrok]]、[[ch23-GPIO与时钟树实战]]
