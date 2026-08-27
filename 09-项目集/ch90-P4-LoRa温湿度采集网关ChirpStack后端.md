---
title: "第90章 P4 · LoRa 温湿度采集网关 + ChirpStack 后端"
part: "[[P9-MOC]]"
chapter: 90
tags:
  - domain/soc
  - topic/lora
  - topic/mqtt
difficulty: 4
est_minutes: 45
prerequisites:
  - "[[ch83-LoRaWAN组网LoRaMac-node-ChirpStack]]"
related:
  - "[[ch84-NB-IoT-Cat1蜂窝IoT-AT指令PPP组网]]"
  - "[[ch35-i-MX6U-ALPHA平台详解]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第90章 P4 · LoRa 温湿度采集网关 + ChirpStack 后端

> [!info] 导航
> ⏱ 45min | ★★★★☆ | 前置 [[ch89-P3-MCUboot双分区OTA安全升级系统]] | → [[ch91-P5-RK3568边缘AI盒子多路视频检测推流]]

## 🎯 学习目标
- [ ] 交付「5 终端 + 1 网关 + 私有 NS + 可视化」完整私有 LoRaWAN 网络
- [ ] 掌握物理层到应用层全栈联调，产出覆盖规划与容量测算方法论
- [ ] 打通温度越限告警的 Telegram/邮件通知闭环

## 90.1 系统组成与角色分工

| 角色 | 硬件 | 软件 |
|------|------|------|
| 终端×5 | F407/ESP32 + SX1268 模块 + SHT31 | LoRaMac-node Class A OTAA(ch83) |
| 网关 | i.MX6ULL/RK3568 + SX1302 半卡或 USB concentrator | packet-forwarder / ChirpStack Gateway Bridge |
| 服务器 | x86 或板上 Docker | ChirpStack v4 + PostgreSQL + Mosquitto |
| 可视化 | Grafana + InfluxDB | MQTT→Telegraf 入库，仪表盘告警规则 |

> 为什么网关用 Linux 板：可直接跑 packet-forwarder 与本地缓存、支持 TLS 回传与远程运维，且 SX1302 多通道基带需要一定算力；MCU 网关适合成本敏感单通道场景——两条路线都值得各做一个练手。

## 90.2 端到端数据流

```text
上行：SX1268 终端(Class A OTAA) → SX1302 集中器 → packet-forwarder(UDP)
     → Gateway Bridge(MQTT) → ChirpStack NS(去重/ADR/解密) → 编解码器(JS)
     → Mosquitto: application/{appid}/device/{deveui}/event/up
     → Telegraf → InfluxDB → Grafana 面板+越限告警
下行：.../command/down 发 JSON → NS 排队，等 Class A 上行后接收窗口下发
```

## 90.3 关键实现代码：ChirpStack 编解码器（业务解耦关键层）

```javascript
function decodeUplink(input) {          // input.bytes 为 LoRaWAN 载荷
  return { data: {
    temp: ((input.bytes[0] << 8) | input.bytes[1]) / 100,
    humi: ((input.bytes[2] << 8) | input.bytes[3]) / 100,
    bat:  input.bytes[4],               // %
  }};
}
// 下行命令主题 .../command/down —— NS 排队等 Class A 窗口下发
```

## 90.4 实施路线与里程碑验收门

| 门 | 实施内容 | 出口准则 |
|----|----------|----------|
| M1 | CN470 频段合规确认，网关注册 | last_seen 持续刷新 |
| M2 | 终端逐个 OTAA 入网 | RSSI/SNR 分布基线表建立 |
| M3 | ADR 效果实测 + Class A/C 下行对比 | 能耗曲线与即时性差异报告完成 |
| M4 | 50 终端错峰压测 + 告警闭环 | 找到丢包率-负载拐点；越限通知可达 |

## 90.5 覆盖规划与容量测算模板

| 输入项 | 取值示例 | 计算 |
|--------|----------|------|
| 单帧 airtime(SF7@125k,12B) | ~66ms | LoRa 计算器工具 |
| 单信道日容量(1% 占空比) | — | 86400s×1%/0.066s ≈ 13000 帧 |
| 8 通道有效并行度 | ×6（正交性折扣） | ≈78000 帧/日/站 |
| 业务需求(500 台×24 帧) | 12000 帧/日 | **利用率 15% ✓ 余量充足** |

再叠加重传率、季节植被衰减、网关维护停机——**最终余量 ≥50% 才签字**。

## 90.6 BOM 与资源占用

| 物料 | 规格 | 数量 |
|------|------|------|
| 终端模组 | SX1268 + F407/ESP32 + SHT31 | ×5 |
| 网关基带 | Semtech SX1302 半卡/USB concentrator | ×1 |
| 网关主机 | i.MX6ULL / RK3568 Linux 板 | ×1 |
| 服务器 | x86 或板载 Docker（ChirpStack v4+PG+Mosquitto） | ×1 |

资源水位（典型值）：ChirpStack+PG 容器组内存 <1GB；packet-forwarder CPU 个位数百分比。

## 90.7 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| OTAA join 反复失败 | NS 日志比对 MIC/DevEui/AppKey | 三元组与密钥录入错误 | join accept 正常返回 |
| 网关 last_seen 停更 | 抓 UDP 包 | forwarder 的 NS 地址/端口配置 | last_seen 连续刷新 |
| SNR 长期负值仍高 SF | NS 设备详情链路统计 | 边缘节点降速率/加功率/换点位 | 链路预算回正 |
| 下行一直不下发 | NS 队列状态 | Class A 只能跟随上行窗口 | 下次上行后窗口内送达 |

## 90.8 实测数据表

| 场景 | 指标 | 结果 |
|------|------|------|
| 容量测算 | 500 台×24 帧/日 vs 单站容量 | 12000/78000 ≈15%，余量充足 |
| ADR 实验 | 固定档 vs 自适应档能耗 | 自适应档电流均值显著更低（典型值 ≥50%） |
| Class A vs C | 下行即时性 | C 档即时；A 档依赖上行节奏 |

## 90.9 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 同一帧在 NS 出现两次 | 多网关接收未去重 | 开启 NS 按 MIC 去重；检查双网关注册 |
| 终端频繁重新入网 | 会话超时/掉电丢上下文 | NVS 保存 DevNonce 与会话参数 |
| 全网丢包突增 | 同频段干扰/天线遮挡 | 频谱扫描对比基线；检查馈线接头 |

> [!example]- 🧪 动手实验 L90-1：ADR 效果实测（60 分钟）
> **步骤**：① 两台同硬件终端：A 固定 SF12，B 开启 ADR；② 同点位连续上报 24h，电流计采样平均工作电流；③ 从 NS 导出两台 SF 分布与丢包率；④ 绘制能耗-可靠性对比曲线。
> **验收**：B 台平均工作电流显著低于 A 台（典型值降幅 ≥50%）且丢包率不劣于 A 台。

## 90.10 开源对照

| 项目 | 借鉴点 |
|------|--------|
| LoRaMac-node 官方 + ST I-CUBE-LRWAN | 终端协议栈两种集成姿势对比 |
| ChirpStack 文档 Architecture 章节 | NS/GW/App 三层职责边界最佳阐述 |
| RAKwireless 开源网关镜像 | 产品级网关的 packet forwarder 配置范式 |
| 立创广场 LoRa 节点类项目 | 低功耗电路设计（升压 vs LDO 选型实测） |

## 90.11 进阶话题

- **多网关去重的价值验证**：同一包双站接收、NS 按 MIC 去重——边缘覆盖提升的本质是「空间分集」；
- **下行受限的架构应对**：把控制类需求改为「配置下发+本地规则执行」而非实时遥控；
- **与 NB-IoT 混合组网**：广域稀疏点用 LoRa 自建、城区密集点用蜂窝，按点位成本曲线分区选型（[[ch84-NB-IoT-Cat1蜂窝IoT-AT指令PPP组网]]）。

> [!warning]- ❓ FAQ
> **Q1：编解码器为什么放 ChirpStack 而非终端或 Grafana？** 它是业务解耦层：终端只发紧凑二进制，NS 侧统一转 JSON，下游共享语义——改协议只改一处 JS。
> **Q2：Grafana 方法论还能复用到哪？** P5/P6 监控体系直接复用同一套「MQTT/Exporter→库→面板告警」范式。

> [!question] 📝 思考题
> 1. 推导 8 通道 CN470 单网关的理论每日消息容量（按 SF 分布加权）。
> 2. 设计「网关失联本地续存」机制：终端与网关两侧各自的策略。
> 3. 若扩展到 500 终端跨 3km² 园区，输出站点规划草案与预算表。

---
🏷️ #domain/soc #topic/lora #topic/mqtt | 🔗 [[ch89-P3-MCUboot双分区OTA安全升级系统]] ← **本章** → [[ch91-P5-RK3568边缘AI盒子多路视频检测推流]] | 📚 [[P9-MOC]]
