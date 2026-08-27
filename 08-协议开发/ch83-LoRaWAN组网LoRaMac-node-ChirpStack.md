---
title: "第83章 LoRa/LoRaWAN 组网：LoRaMac-node 与 ChirpStack 实战"
part: "[[P8-MOC]]"
chapter: 83
tags:
  - domain/protocol
  - topic/lorawan
difficulty: 4
est_minutes: 45
prerequisites:
  - "[[ch82-BLE开发GATT设计BlueZ-DFU]]"
related:
  - "[[ch90-P4-LoRa温湿度采集网关ChirpStack后端]]"
  - "[[ch84-NB-IoT-Cat1蜂窝IoT-AT指令PPP组网]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第83章 LoRa/LoRaWAN 组网：LoRaMac-node 与 ChirpStack 实战

> [!info] 导航
> ⏱ 45min | ★★★★☆ | 前置 [[ch82-BLE开发GATT设计BlueZ-DFU]] | → [[ch84-NB-IoT-Cat1蜂窝IoT-AT指令PPP组网]]

## 🎯 学习目标
- [ ] 说清 SF/BW/CR 三参数对速率、灵敏度与空口时间的影响
- [ ] 对比 Class A/B/C 接收窗口时机与功耗谱系，走通 OTAA 入网并解释 ADR 决策循环与关闭场景
- [ ] 用 LoRaMac-node+ChirpStack 搭私有网络，掌握 Join 失败排查链与 FUOTA 思路

## 83.1 物理层：CSS 扩频速成

| 参数 | 范围 | 影响 |
|------|------|------|
| SF 扩频因子 | 7~12 | 每 +1 速率减半，灵敏度 +~2.5dB(距离翻倍级) |
| BW 带宽 | 125/250/500k | 越宽越快但底噪越高 |
| CR 编码率 | 4/5~4/8 | 纠错冗余权衡 |
| Airtime 例 | SF7@125k 10B≈46ms；SF12≈1.4s | 占空比法规(中国 470MHz 通常 <5%)直接约束发送频率 |

## 83.2 Class A/B/C 模式对比（接收窗口时机与功耗）

| 设备类 | 接收窗口时机 | 功耗 | 下行能力 |
|--------|--------------|------|----------|
| Class A ★默认 | 上行后开 RX1/RX2 两个短接收窗，其余深度睡眠(µA 级) | 最优 | 只能「搭上行便车」，延迟不可预期 |
| Class B | Beacon 同步+预约 pingSlot 定时收窗(依赖网关 GPS 时钟，无 GPS 场景慎选) | 中 | 秒级可控延迟下行(阀门控制) |
| Class C | 除发送外持续监听 | mA 级，必须常供电 | 即时下行，阀门/继电器首选 |

## 83.3 OTAA 入网全流程

八元组：**DevEUI**(全球唯一)+**JoinEUI/AppEUI**+**AppKey**(根密钥)→ 终端发 **Join Request** → NS 回 **DevAddr+NwkSKey+AppSKey**(会话密钥下发)。

安全模型：网络层与会话层双密钥分离——NS 看不到业务明文 ★。

DevNonce 纪律：单调递增且永不复用——恢复出厂后必须清理 NVS 中的 nonce 计数，否则重放保护判定失败、入不了网。

## 83.4 ADR 自适应速率机制

NS 端 ADR 引擎每收到带 ADR 位的上行：① 统计最近 N 帧 SNR 边缘值(margin=SNR_max−所需SNR)；② margin>阈值→降 SF/缩功率；连续丢帧→升 SF。终端收到 LinkADRReq 后按序应用并回 MAC ack。

必须关 ADR 的三场景：移动资产(SNR 无稳态)/深室内固定点(已顶格 SF12)/Class B·C 强实时控制链(速率抖动影响下行窗口)；固定表计类则必开省电。实测技巧：SF7/SF9/SF12 三档各跑 24h 对比丢包率-能耗曲线，最优解就在图上。

## 83.5 CN470 频段参数

| 参数 | CN470-510 规定 | 工程含义 |
|------|----------------|----------|
| 上行信道 | 19 组×8 信道(470.3~489.5MHz 步进 2MHz 系) | NS 与终端必须同「信道计划版本」——混用即全网失联 |
| DataRate | DR0=SF12/125k … DR5=SF7/125k；DR6=SF7/500k(部分) | ADR 上限受限于最远节点 |
| 发射功率 | ≤17dBm(EIRP 法规口径) | 天线增益算入 EIRP——高增益天线要降功率 |
| 占空比 | 无 EU 式硬性 duty cycle 但有频率占用限值 | 仍建议软件自限 1%~5% 保合规余量 |
| RX2 默认 | 以 LoRaMac REGION 表为准 | 改 RX2 必须 NS/终端同步，否则下行全丢 ★高频事故 |

## 83.6 服务端架构：ChirpStack v4 数据链

数据链路：**packet forwarder**(网关上进程，Semtech UDP 或 Basics Station 协议) → **chirpstack-gateway-bridge**(协议转 MQTT) → MQTT broker(mosquitto) → **network server**(ChirpStack 本体+PostgreSQL+Redis)；docker compose 一键起全家桶(Web UI :8080)。

配置流：Device-profile(Class/ADR/Codec) → Service-profile → 注册 Gateway → Application → Device 录入八元组。编解码器 JS 把上行 payload 解码为 JSON——业务解耦关键层。多网关重叠区靠 NS 去重；Class B 站点间用 GPS 时间同步。

## 83.7 关键代码：LoRaMac-node 移植骨架

```c
LoRaMacRegion_t region = LORAMAC_REGION_CN470;      /* 中国470频段 */
LoRaMacInitialization(&LoRaMacPr, &LoRaMacCb, region);
MibRequestConfirm_t mib = { .Type = MIB_NET_ID };   /* OTAA 八元组经 MIB 注入 */
LmHandlerJoin();                                    /* 发起 OTAA 入网 */
LmHandlerAppData_t d = { .Port = 2, .BufferSize = 5, .Buffer = payload };
LmHandlerSend(&d, LORAMAC_HANDLER_UNCONFIRMED_MSG, false);
/* 移植三件事： SPI 收发器驱动(SX126x/SX127x)+定时器抽象+GPIO 中断(DIO0/1)；
   低功耗节拍： Standby RTC 唤醒(~3µA)→冷热启动识别→传感器 warmup→发 5B 包 */
/* 能量账： join 最贵(~2s 射频)仅首次与密钥过期发生；
   日常一包 TX 46ms(SF7)+双接收窗 → 平均电流 µA 级，10 年电池成立 */
```

调试利器：官方栈 github.com/Lora-net/LoRaMac-node；打开 LORAMAC_TRACE 宏看 MAC 层逐包日志，与 ChirpStack 日志时间轴对齐排丢包。

## 83.8 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 丢包随距离陡增 | NanoVNA 驻波+NS 端 SNR 分布 | 调天线/关 ADR 固定 SF12 对比 | SNR>0 且丢包 <1% |
| ADR 把远端压掉线 | NS 端 SF 分布统计 | margin 阈值上调或关 ADR | 远端帧计数稳定增长 |
| 发送被静默丢弃 | Airtime×频率预算表 | 降上报频率/上行聚合压缩 | 预算留 20% 余量 |

## 83.9 实测数据表：网关侧容量压测（8 通道 CN470，ChirpStack）

| 在线设备数 | 上报间隔 | SF 分布 | 丢包率 | NS CPU |
|------------|----------|---------|--------|--------|
| 50 | 5min | 混合(ADR) | 0.1% | <3% |
| 200 | 5min | SF7~10 | 0.8% | 11% |
| 500 | 1min | SF7~12 | 6.3%(碰撞主导) | 25% |

结论：500 台×1min 已到单站极限——错峰(随机相位)+分扇区多网关是标准续命方案。

## 83.10 排故速查表（含 Join 失败排查链）

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| Join 一直无响应 | 频段配置不符(Region)/网关未注册/AppKey 错 | 排查链：NS 看 gateway last seen → 频谱仪确认发射在发生(ch20) → 逐字节核对八元组 |
| 能入网上不了报 | FCnt 重放保护/DevNonce 复用 | 恢复出厂清理 NVS nonce；NS 端重置设备状态 |
| 距离远小于理论值 | 天线失配/遮挡/ADR 把 SF 压太低 | NanoVNA 调天线；关 ADR 固定 SF12 对比测试 |
| Class B 下行收不到 | Beacon 未锁/时钟漂移超窗 | 检查网关 GPS；终端 beacon 锁定日志与漂移补偿系数 |
| 占空比超限被静默 | 发送过频触发区域法规限制 | 计算 Airtime×频率预算表；上行聚合压缩 |

## 83.11 部署注意事项

1. RX2 改动必须 NS/终端同步，否则下行全丢——上线前固化到 device-profile 与固件双侧评审；
2. FUOTA 流程：McGroupSetup 建组播组→单播分发镜像到 slot→切 Class B/C 按 fragmentation 广播碎片(带宽效率 ×N)→镜像级 CRC+签名(MCUboot 校验)切换；按 DevEUI 尾号 5%/20%/75% 三批放量，失败率超阈值熔断；多播期间占空比预算翻倍要预留；
3. Class B 时间同步三关：LSE ±20ppm 在 128s 内偏差可达 2.5ms 超 pingSlot 半窗——每次 Beacon 更新漂移系数线性外推；冷启动锁星容忍 1~2 个 Beacon 周期；验收指标连续 72h pingSlot 命中率 ≥99.9%、下行首包成功率 ≥98%；
4. 电池设计账：join 最贵仅首次发生；日常一包 SF7 46ms+接收窗平均电流 µA 级。

> [!example]- 🧪 动手实验 L83-1：私有网络端到端组建（120 分钟）
> **步骤**：① Docker 起 ChirpStack 全家桶，注册网关(packet-forwarder 配置)；② 终端录入八元组完成 OTAA 入网；③ 制造三种故障逐一取证：网关断线/密钥错/频率计划不符；④ 用 TinySA 在发射瞬间验证信道合规；⑤ Grafana 出温度面板+告警规则。
> **验收**：一张「故障注入→现象→定位依据」三列表完整归档。

## 83.12 进阶话题
- LR-FHSS：新物理层抗干扰增强，上行容量提升一个量级——高密度场景开始值得评估；
- Class B 的 Beacon 纪律：网关 GPS 时间同步精度直接决定下行窗命中率；
- 规范：LoRaWAN L2 1.0.4 Specification(区域参数另册)；用 compliance 测试模式验证协议一致性。

> [!warning]- ❓ FAQ
> **Q1：为什么 ADR 开着反而丢包更多？** 移动场景 SNR 无稳态，NS 依据过期样本指挥降速——移动资产应关闭 ADR 固定速率。
> **Q2：自建 ChirpStack 还是上 TTN 公网？** 数据主权/成本/可靠性三维权衡：私有数据敏感选自建；小规模快速验证可先用公网。

> [!question] 📝 思考题
> 1. 推导 SF12@125k 单帧最大字节数与对应 airtime。
> 2. 设计「500 台电表每日一次上报」的信道容量核算与时隙错峰方案。
> 3. 对比自建 ChirpStack 与 TTN 公网的成本/数据主权/可靠性三维差异。

---
🏷️ #domain/protocol #topic/lorawan | 🔗 [[ch82-BLE开发GATT设计BlueZ-DFU]] ← **本章** → [[ch84-NB-IoT-Cat1蜂窝IoT-AT指令PPP组网]] | 📚 [[P8-MOC]]
