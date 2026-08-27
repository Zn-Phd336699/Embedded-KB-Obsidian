---
title: "CAN 节点 TEC 达 255 后突然全体停发"
tags:
  - troubleshooting
  - protocol/can
severity: medium
frequency: common
source: "[[ch78-CAN-CANFD实战SocketCAN-DBC工作流]]"
date: 2025-01-15
---
# TC06 CAN Bus-Off 恢复策略选择

## 现象
CAN 节点运行中突然整体停止发送，ESR 寄存器 BOFF=1、TEC=255；触发条件：总线强干扰、线束短路或波特率失配使发送错误计数器累计到 256。

## 环境与适用范围
bxCAN（STM32）、FlexCAN（NXP）、MCP2515 等控制器；Linux SocketCAN 网关同样适用。恢复策略选择逻辑对 CAN FD 控制器一致。

## 取证过程
1. 读 `CAN->ESR`：区分三档状态 EWGF(警告)>96 / EPVF(被动错误)>127 / BOFF(离线)=256。
2. Linux 网关用 `ip -details -statistics link show can0` 查看 bus-off 计数与错误计数器。
3. 示波器测总线显性电平占比：持续显性≈CANH/CANL 短路或终端电阻缺失。
4. 统计 Bus-Off 复现周期：秒级反复进入=持续性硬故障，偶发=电磁干扰。

## 根因
TEC≥256 时控制器按协议强制进入 Bus-Off 脱离总线（保护网络）；需检测到 128 次「11 个连续隐性位」才允许重回 Error Active。ABOM 位决定这 128 序列由硬件自动跑完（自动恢复），还是等软件清 INIT 才开始跑（手动恢复）——策略选错会离线风暴或永久趴窝。

## 修复方案
```c
/* bxCAN 手动恢复：带指数退避与熔断，避免离线风暴 */
void can_error_handler(void)
{
    if (!__HAL_CAN_GET_FLAG(&hcan1, CAN_FLAG_BOF)) return;
    if (++boff_count > BOFF_LIMIT) {        /* 熔断：上报不再盲试 */
        fault_report(FAULT_CAN_BUSOFF);
        return;
    }
    HAL_CAN_Stop(&hcan1);
    osDelay(1U << MIN(boff_count, 6));      /* 退避 2^n ms */
    HAL_CAN_Start(&hcan1);                  /* 清 INIT 触发 128x11 序列 */
}
/* 若选自动恢复：初始化时 ABOM=1，硬件自愈 */
// hcan1.Init.AutoBusOff = ENABLE;
```
Linux SocketCAN 对应配置：`ip link set can0 type can restart-ms 100`。

## 预防措施
- 恢复必须带指数退避 + 次数熔断，禁止无条件立即重试
- 使能 EWGF/EPVF 阈值中断提前预警，别等 Bus-Off 才发现
- 上电校验全网波特率与采样点一致性（建议 87.5%）
- CANH/L 接线与 120Ω×2 终端电阻纳入产测项
- 量产设备记录 bus-off 日志便于售后追溯

## 关联
- 源章节：[[ch78-CAN-CANFD实战SocketCAN-DBC工作流]]
- 相关章节：[[ch74-总线与无线选型总表]]、[[ch18-示波器实战]]
