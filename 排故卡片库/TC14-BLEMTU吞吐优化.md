---
title: "BLE 吞吐卡在 1KB/s 上不去"
tags:
  - troubleshooting
  - protocol/ble
severity: medium
frequency: common
source: "[[ch82-BLE开发GATT设计BlueZ-DFU]]"
date: 2025-01-15
---
# TC14 BLE MTU 吞吐优化三板斧

## 现象
GATT Notify 实测吞吐只有约 0.8~1KB/s，远低于 BLE 4.2/5 理论能力；触发条件：沿用默认 ATT MTU=23（有效载荷仅 20B）+ 默认连接参数 + 1M PHY。

## 环境与适用范围
手机（iOS/Android）对 BLE SoC（Nordic nRF52、ESP32、Silabs 等）。Beacon、传感器上报类低速场景无需此优化；蓝牙 Mesh 广播路径不适用。

## 取证过程
1. nRF Connect 连接详情页读三项现状：MTU、连接间隔、当前 PHY。
2. Android 抓 btsnoop HCI 日志或用 nRF Sniffer：确认 ATT_Exchange_MTU 到底协商过没有。
3. 计算理论吞吐 (MTU-3)×每连接事件包数÷间隔，与实测对照找出短板项。
4. 逐项叠加优化参数实测增益，记录每一步的提升幅度。

## 根因
MTU=23 时每个 Notify 只能携带 20 字节有效载荷，叠加默认连接间隔 7.5~50ms 与 1M PHY 的空中开销，吞吐天然被钉死在 KB/s 量级。MTU/DLE、连接间隔、PHY 三者任一是短板都会成为天花板，必须三管齐下。

## 修复方案
```c
/* 从机侧(Nordic SDK 风格)：三板斧一次配齐 */
ble_gap_data_length_params_t dle = { .max_tx_octets = 251,
                                     .max_rx_octets = 251 };
sd_ble_gap_data_length_update(m_conn_handle, &dle, NULL);  /* DLE 扩包 */

sd_ble_gatts_exchange_mtu_reply(m_conn_handle, 247);       /* 大 MTU */

ble_gap_phys_t phy = { .tx_phys = BLE_GAP_PHY_2MBPS,
                       .rx_phys = BLE_GAP_PHY_2MBPS };
sd_ble_gap_phy_update(m_conn_handle, &phy);                /* 2M PHY */

/* 连接间隔由手机侧 requestConnectionPriority(HIGH) 压至 ~15ms */
```
典型收益（实测典型值）：MTU 247 + DLE + 2M PHY + 15ms 间隔 → 吞吐 50~70KB/s，较默认提升约 50 倍。

## 预防措施
- 特征值长度按 MTU-3 整倍数设计，打满每包载荷
- iOS 会自动协商较大 MTU；Android 必须主动 requestMtu(247)
- 吞吐指标写入协议文档，真机矩阵（iOS+安卓主流机型）回归
- 用 nRF Sniffer 抓空口验证包长确实生效

## 关联
- 源章节：[[ch82-BLE开发GATT设计BlueZ-DFU]]
- 相关章节：[[ch32-ESP32外设与WiFi-BLE上手]]、[[ch86-综合案例无线共存干扰排障全流程]]
