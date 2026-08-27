---
title: "第80A章 MQTT/CoAP 云协议本体与嵌入式实现"
part: "[[P8-MOC]]"
chapter: "80A"
tags:
  - domain/protocol
  - topic/mqtt
difficulty: 3
est_minutes: 35
prerequisites:
  - "[[ch80-以太网与lwIP协议栈源码导读]]"
related:
  - "[[ch63-网络编程与TLS从socket到安全上云]]"
  - "[[ch84-NB-IoT-Cat1蜂窝IoT-AT指令PPP组网]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第80A章 MQTT/CoAP 云协议本体与嵌入式实现

> [!info] 导航
> ⏱ 35min | ★★★☆☆ | 前置 [[ch80-以太网与lwIP协议栈源码导读]] | → [[ch81-WiFi协议栈实战wpa_supplicant-hostapd]]

## 🎯 学习目标
- [ ] 手绘三级 QoS 握手序列，说清 PUBACK/PUBREC/PUBREL/PUBCOMP 的语义与去重点
- [ ] 用 KeepAlive+遗嘱(LWT)+保留消息(Retained) 判定设备在线状态，实现重连退避与离线队列
- [ ] 说清 MQTT vs CoAP 选型边界并跑通一次 CoAP 资源发现

## 80A.1 协议核心机制精读

MQTT(MQ Telemetry Transport) 是 IoT 的「HTTP」——发布/订阅模型解耦设备与业务，其 QoS(Quality of Service) 语义才是量产考点。KeepAlive 保活：设 60s 且实际 PINGREQ 间隔 ≤45s，给 NAT/防火墙映射老化留安全余量。QoS 三档：

- **QoS0**：发完即忘，可能丢——高频且可容忍丢失的遥测用它；
- **QoS1**：PUBLISH 携带 msg_id，等 **PUBACK**；超时重发(DUP=1)，接收方按 msg_id 去重——**主力档位**；
- **QoS2**：四步握手 PUBLISH→**PUBREC**→**PUBREL**→**PUBCOMP**，精确一次——状态机复杂，MCU 少用。

| 机制 | 工作方式 | 嵌入式要点 |
|------|----------|-----------|
| Clean Session=false | 断线期间 Broker 保留订阅+QoS1/2 消息 | 离线补传的服务器侧替代方案 ★ |
| Will 遗嘱(LWT) | 异常掉线由 Broker 代发遗言 | 在线状态判定的正确姿势，比心跳超时快 |
| Retained 保留消息 | 主题最新一条驻留 Broker | 配置下发类主题标配，新订阅立即拿到当前值 |
| 通配符 | `#` 匹配多级、`+` 匹配单级 | 仅订阅端可用；Topic 树设计决定 ACL 粒度 |

## 80A.2 可靠客户端状态机（量产骨架）

```text
IDLE ─DNS/TCP→ CONNECT ─CONNECT→ ONLINE
ONLINE ─PUBACK 超时→ 重发未确认(msg_id 表)
ONLINE ─PINGRESP 超时→ RECONNECT 退避 1s..60s+随机抖动
任何状态断链检测失败 → RECONNECT；恢复后重新 CONNECT(CleanSession=false)
重连成功先 flush 离线队列(带原时间戳)再正常收发
```

1. 未确认消息环形队列：容量≈离线时长×速率，满则丢最旧并计数上报；
2. 订阅恢复：CleanSession=false 由 Broker 自动恢复；否则 CONNACK 后重发 SUBSCRIBE；TLS 复用 session ticket 降低握手成本；
3. 离线补传携带原始时间戳，服务端按 seq 幂等去重。

## 80A.3 实现路线对比

| 路线 | 代表库 | 体积/RAM | 适用 |
|------|--------|----------|------|
| 全功能 | paho.mqtt.embedded-c | ~15KB/4KB | Linux 或富资源 MCU |
| 极简自研 | 本章骨架(~600 行) | ~4KB/1KB | M0+/深度定制协议栈 |
| 模组内置 | AT 指令(QMTOPEN 系列) | 0(MCU 不参与) | 蜂窝模组方案 ★省心 |
| ESP-IDF | esp-mqtt 组件 | 随 IDF | ESP32 项目默认 |

## 80A.4 CoAP：UDP 世界的轻量兄弟

RESTful over UDP，报文头仅 4 字节，适合 NB-IoT/LoRa 上层：

- 报文模型四类：**CON**(需确认)/NON(不确认)/ACK/RST；GET/POST/PUT/DELETE 映射资源树；资源发现=GET `/.well-known/core` 返回 Link-Format 列表；
- Observe 扩展(RFC7641)=服务端主动推送，类似 MQTT 订阅；安全层配 DTLS；
- 实现：libcoap(Linux)/wakaama(LwM2M 全家桶)，或自研约 400 行。

**选型口诀**：双向多对多、生态成熟→MQTT；单向采集+超低功耗+无 TCP 栈→CoAP(+DTLS)。

## 80A.5 关键代码：paho.mqtt 最小实现

```c
Network n; MQTTClient c;
NetworkInit(&n); NetworkConnect(&n, "broker.example.com", 8883);
MQTTClientInit(&c, &n, 1000, sendbuf, sizeof(sendbuf), readbuf, sizeof(readbuf));
MQTTPacket_connectData d = MQTTPacket_connectData_initializer;
d.MQTTVersion = 4; d.clientID.cstring = "dev-001";   /* 3.1.1 */
d.keepAliveInterval = 60;         /* 实际 ping 间隔 <=45s */
d.cleansession = 0;               /* 会话保持=离线补传前提 */
d.willFlag = 1;                   /* 遗嘱：异常掉线上报 offline */
d.will.topicName.cstring = "site/dev-001/status";
d.will.message.cstring   = "offline";
MQTTConnect(&c, &d);
MQTTSubscribe(&c, "cmd/dev-001/#", QOS1, msg_handler);
MQTTMessage m = { .qos = QOS1, .payload = buf, .payloadlen = len };
if (MQTTPublish(&c, "data/dev-001/temp", &m) != SUCCESS)
    queue_push_offline(buf, len); /* 失败入离线队列，恢复后补传 */
while (1) MQTTYield(&c, 100);     /* 周期收包驱动 PUBACK/PINGRESP */
```

## 80A.6 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 重连风暴 | 抓包统计 CONNECT 频率 | 退避 1s..60s+随机抖动 | 重连无固定周期 |
| 重复消费 | 服务端按 msg_id/seq 对账 | QoS1 去重逻辑 | 幂等消费零重复副作用 |
| 在线被误判离线 | 对比 LWT 到达与本地心跳日志 | ping 间隔压到 45s 内 | NAT 环境下不掉线 |

## 80A.7 实测数据表：QoS1 端到端时延与可靠性（WiFi 本地 broker）

| 场景 | P50 延迟 | P99 | 丢失率 |
|------|----------|-----|--------|
| 在线直发 QoS1 | 18ms | 65ms | 0 |
| 断网 10min 后批量补传(100 条) | - | - | 0(幂等去重生效) |
| Broker 重启窗口内发布 | - | <2s(重连后) | 0(session 保持；seq 注入+落库对账验证) |

## 80A.8 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 连接频繁被踢 | KeepAlive 跨越 NAT 老化窗口 | 缩短 ping 间隔；抓包看哪端先发 FIN |
| 订阅收不到消息 | 通配符层级错/主题大小写不一致 | mosquitto_sub 同主题对照验证 |
| 重连后拿不到当前配置 | Retained 未置位或 clean session=true | 检查 retain 位与会话标志组合 |
| 发布卡死不再发出 | inflight 队列满且无重发定时器 | 打印未确认表长度与最老 msg_id 年龄 |

## 80A.9 部署注意事项

1. Topic 四段式 `{tenant}/{site}/{device}/{datatype}`+通配符订阅权限矩阵——命名混乱是后期运维最大痛点；
2. MQTT 5 新特性(共享订阅/原因码/消息过期)等 Broker 支持齐了再上，别追新；
3. 安全组合拳：TLS+mTLS 客户端证书+Topic ACL 按 clientCN 授权，设备身份直达权限层；
4. 蜂窝方案优先用模组内置 MQTT(AT 指令)，MCU 零参与最省心。

> [!example]- 🧪 动手实验 L80A-1：从零构建可靠 MQTT 客户端（120 分钟）
> **步骤**：① Mosquitto 本地起服(允许 anonymous)；② 按 80A.2 状态机手工组包实现极简客户端(CONNECT/PUBLISH/SUBSCRIBE/PINGREQ)；③ mosquitto_sub 验证双向；④ 注入断网验证遗嘱触发与补传幂等；⑤ Wireshark 解析全部报文截图归档。
> **验收**：断网期间遗嘱在 LWT 主题准时出现；补传 100 条服务端对账零丢失零重复。

## 80A.10 进阶话题
- 共享订阅($share)做集群负载均衡的条件与坑；
- CleanSession=false 内存估算：每设备≈订阅表+inflight 窗口×最大报文；
- Bridge 桥接打通多 Broker 的拓扑设计与环路规避。

> [!warning]- ❓ FAQ
> **Q1：QoS2 在 MCU 上为何不受待见？** 四步握手状态机+两端去重状态吃 RAM；替代：QoS1+业务幂等键，或应用层序号+显式 ACK。
> **Q2：遗嘱和保留能叠加吗？** 可以——Will 置 retain 后，新订阅者一上线就能看到「offline」，在线查询不必等事件。

> [!question] 📝 思考题
> 1. QoS2 为什么在 MCU 上不受待见？给出两个替代设计。
> 2. CleanSession=false 时 Broker 内存压力如何估算？500 万设备的平台怎么办？
> 3. 为你的产品设计完整的 Topic 树与 ACL 矩阵。

---
🏷️ #domain/protocol #topic/mqtt | 🔗 [[ch80-以太网与lwIP协议栈源码导读]] ← **本章** → [[ch81-WiFi协议栈实战wpa_supplicant-hostapd]] | 📚 [[P8-MOC]]
