---
title: "TC20 两 AP 交界处要么粘死弱信号、要么来回乒乓"
tags:
  - troubleshooting
  - protocol/wifi-roaming
severity: medium
frequency: common
source: "[[ch81-WiFi协议栈实战wpa_supplicant-hostapd]]"
date: 2025-01-15
---
# TC20 WiFi 漫游阈值策略

## 现象
漫游交界处终端 RSSI 已跌到 -75dBm 仍粘着旧 AP（吞吐骤降、视频卡顿），或刚切过去又切回来反复乒乓断流。典型触发：走廊/电梯口多 AP 同 SSID。

## 环境与适用范围
适用 wpa_supplicant STA（OpenWrt/工业网关/边缘盒子），思路同构于 ESP-IDF 与手机模组 AT 固件。家用单 AP 不涉及。

## 取证过程
1. 步测采集：`wpa_cli signal_poll` 每 2s 记录 RSSI 与 BSSID，后台 ping/iperf3 打流标注断流时刻。
2. `journalctl -u wpa_supplicant | grep -E 'CONNECTED|DISCONN'` 得到切换序列与漫游耗时，识别乒乓区间。
3. 查当前策略：network 块有无 bgscan/scan_interval/bssid 限制，driver 侧有无 roam 阈值。
4. 画 RSSI-BSSID 泳道图：区分「旧 AP 该走没走」（阈值过低）与「新 AP 不该来来了」（无迟滞）两类缺口。
5. 调参后复测同一路线，统计切换成功率、乒乓次数、最长断流时长。

## 根因
漫游本质是「阈值 + 迟滞 + 扫描时机」决策问题。无 bgscan 时 supplicant 只在信号极差/丢 Beacon 后被动切换（过晚）；阈值过高且无迟滞则在相邻 AP 间反复横跳（过早 + 乒乓）。

## 修复方案
```conf
  # /etc/wpa_supplicant.conf —— 阈值 + 迟滞 + 主动扫描
network={
    ssid="factory"
    psk="..."
    # 每 30s 检查一次；信号低于 -65dBm 才触发扫描；两次扫描最小间隔 10s
    bgscan="simple:30:-65:10"
    scan_freq="2412 2437 2462"   # 只扫部署信道，缩短盲听时间
}
  # 判据：候选 AP RSSI 高于当前 8dB(迟滞) 且持续 ≥3s 才发起切换
  # 进阶：802.11r 可把切换压到 <50ms
```

## 预防措施
- 部署期热力图验收：重叠区 RSSI ≥ -67dBm，重叠覆盖率 15%~20%
- 同 SSID 各 AP 错开信道、功率统一规划，杜绝同频对打
- 漫游参数（阈值/迟滞/扫描周期）写入机型基线并做步行轨迹回归
- 监控漫游次数与断流时长指标，异常自动告警
- 固件升级后重跑漫游测试（驱动行为可能变化）

## 关联
- 源章节：[[ch81-WiFi协议栈实战wpa_supplicant-hostapd]]
- 相关章节：[[ch86-综合案例无线共存干扰排障全流程]] [[ch32-ESP32外设与WiFi-BLE上手]]
