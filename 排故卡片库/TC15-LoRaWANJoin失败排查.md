---
title: "OTAA Join 反复请求却收不到 JoinAccept"
tags:
  - troubleshooting
  - protocol/lorawan
severity: medium
frequency: common
source: "[[ch83-LoRaWAN组网LoRaMac-node-ChirpStack]]"
date: 2025-01-15
---
# TC15 LoRaWAN OTAA Join 失败排查链

## 现象
终端反复发送 Join Request，网关侧能看到上行帧，但 ChirpStack 不下发 JoinAccept，或下发后终端收不到入网失败；触发条件：OTAA 首次入网阶段。

## 环境与适用范围
LoRaMac-node 终端 + ChirpStack/TTN 网络服务器，EU868/CN470 等全频段适用。ABP 模式没有 Join 流程，不适用本卡。

## 取证过程
1. ChirpStack Web 控制台：确认网关 Online、JoinRequest 事件到达、有无 MIC 校验失败记录。
2. 看网关 packet-forwarder 日志的 RSSI/SNR：信号太弱先解决天线与射程问题。
3. 逐字节比对 DevEUI/JoinEUI/AppKey 与服务器配置：十有八九是字节序反了。
4. 核对频段与子带：终端 REGION_xxx 宏、信道掩码与 NS 频段计划一致。
5. 检查 RX1/RX2 接收窗口：延迟（JoinAccept 固定 RX1 延迟 5s）、DR 设置与网关下行能力匹配。

## 根因
JoinAccept 由 NS 用 AppKey 加密签名，密钥或 EUI 字节序不一致则 MIC 校验失败被静默丢弃（最典型的「网关收到了、服务器不回」）；即使下行发出，终端也只在指定窗口守候，频点或 DR 不匹配则永远收不到。

## 修复方案
```c
/* LoRaMac-node 数组序为 LSB first：TTN 页面显示须倒序填写 */
/* 页面显示 70B3D5E75E00F1A2 → 数组填 A2 F1 00 5E E7 D5 B3 70 */
static const uint8_t DevEui[]  = { 0xA2,0xF1,0x00,0x5E,0xE7,0xD5,0xB3,0x70 };
static const uint8_t JoinEui[] = { /* 同样倒序 */ };
static const uint8_t AppKey[]  = { /* 16 字节，同样倒序 */ };

mibReq.Type = MIB_DEV_EUI;  mibReq.Pointer.DevEui  = DevEui;
LoRaMacMibSetRequestConfirm(&mibReq);
mibReq.Type = MIB_JOIN_EUI; mibReq.Pointer.JoinEui = JoinEui;
LoRaMacMibSetRequestConfirm(&mibReq);

#define REGION_CN470            /* REGION 宏与 NS 频段计划严格一致 */
LoRaMacStart();
```

## 预防措施
- 凭据录入统一走脚本自动做 MSB↔LSB 转换，杜绝手抄错序
- 部署清单固化四要素：频段/子带/ADR 开关/RX2 DR
- Join 重试带随机退避并遵守占空比法规
- 现场留存 RSSI/SNR 基线数据便于覆盖优化追溯
- 新设备先在实验室 NS 全流程打通再上站

## 关联
- 源章节：[[ch83-LoRaWAN组网LoRaMac-node-ChirpStack]]
- 相关章节：[[ch90-P4-LoRa温湿度采集网关ChirpStack后端]]、[[ch20-频谱仪与射频排障]]
