---
title: "第84章 NB-IoT/Cat.1 蜂窝IoT：AT指令工程化与PPP组网"
part: "[[P8-MOC]]"
chapter: 84
tags:
  - domain/protocol
  - topic/nb-iot
difficulty: 3
est_minutes: 35
prerequisites:
  - "[[ch83-LoRaWAN组网LoRaMac-node-ChirpStack]]"
related:
  - "[[ch28-串口工程化IDLE-DMA-RS485]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第84章 NB-IoT/Cat.1 蜂窝IoT：AT指令工程化与PPP组网

> [!info] 导航
> ⏱ 35min | ★★★☆☆ | 前置 [[ch83-LoRaWAN组网LoRaMac-node-ChirpStack]] | → [[ch85-PCIe总线拓扑BAR空间lspci排障]]

## 🎯 学习目标
- [ ] 建立「上电→SIM→注网→PDP→业务」AT 注网状态机，每步带超时重试
- [ ] 会计算 PSM/eDRX 参数（TAU/T3324），推算电池设备平均电流与十年需求
- [ ] 在 Linux 用 pppd/chat 或 qmicli 完成拨号，制定 NAT 保活与四级自愈策略

## 84.1 核心概念：NB-IoT vs Cat.1 选型速断

| 维度 | NB-IoT | Cat.1 |
|------|--------|-------|
| 速率 | <60kbps | 下行 10 / 上行 5 Mbps |
| 时延 | 秒级 | 百 ms 级 |
| 移动性 | 弱（静止为主） | 支持切换 |
| 语音/TCP长连接 | 受限（CoAP/UDP 为主） | ✅ MQTT/TLS 无压力 |
| 资费 | 最低档 | 中档 |
| 典型场景 | 水气表/烟感 | 追踪器/POS/音视频 ★当前主流 |

## 84.2 AT 注网上电序列与工程化五原则（以移远 EC800 为例）

```text
上电序列（每步带超时重试 N 次）：
AT            → OK                  锁波特率: AT+IPR=115200&W；ATE0 关回显
AT+CPIN?      → READY               +CME ERROR:11 = PIN 码未解锁
AT+CSQ        → RSSI 0-31           ≤10 弱信号告警
AT+CEREG?     → 0,1 已注册本地       0,2 = 搜索中（见排故表）
AT+QICSGP/CID → APN 配置 → AT+QIACT 激活 PDP
MQTT 直连系列： QMTOPEN→QMTCONN→QMTPUB/QMTSUB（模组内置 TLS: QMTSSLC）
工程化五原则：
① URC 异步事件(+QIURC) 必须独立线程/任务解析，不阻塞主命令流 ② 所有命令匹配「预期响应集合」而非单字符串
③ AT+QGDCNT 定期读流量防异常刷量 ④ 断线自愈分级： 重连MQTT→重激活PDP→软重启模组(AT+CFUN=1,1)→硬重启 ⑤ AT+QTEMP 极端温度主动上报（车规刚需）
```

## 84.3 关键代码：Linux 侧两条组网路线

| 路线 | 机制 | 适用 |
|------|------|------|
| PPP 拨号 | pppd + chat 脚本走 AT 建立点对点 | 兼容所有模组 ★入门 |
| QMI/MBIM | 原生网卡 wwan0 + qmicli 管理 | 高通系高性能低延迟 ★现代首选 |

```bash
pppd /dev/ttyUSB2 115200 connect 'chat -v -f /etc/chatscripts/gprs' \
     noauth defaultroute usepeerdns user "" password ""
# chatscript 核心： AT+CGDCONT=1,"IP","cmnet" → ATD*99# → CONNECT
qmicli -d /dev/cdc-wdm0 --nas-get-signal-strength  # QMI 读信号
ip link set wwan0 up && udhcpc -i wwan0            # raw-ip 先设模式再 DHCP
```

接入方案补充：DTU 透传零协议开发但断线丢数据/无 QoS；OpenCPU(QCPU/Luat) 业务跑模组内省一颗 MCU 但生态锁定。需离线缓存/QoS/多连接 → AT 自研状态机。

## 84.4 关键代码②：连接管理器状态机骨架（cmgr.c）

```c
/* 状态流： OFF → SIM_OK → REGISTERED → PDP_ACT → MQTT_ONLINE → 循环监控 */
void cm_tick(void) {                        /* 1s 周期调用 */
    switch (cm.st) {
    case ST_SIM_CHECK:
        at_send("AT+CPIN?"); expect("READY", next = ST_PDP_CFG); break;
    case ST_PDP_CFG:                        /* APN 大小写敏感！ */
        at_printf("AT+CGDCONT=1,\"IP\",\"%s\"", apn);
        goto_act(); break;                  /* AT+QIACT 激活 PDP */
    case ST_MQTT_ONLINE:
        if (now - last_tx > HEARTBEAT_S) mqtt_ping();
        if (now - last_rx > 3 * HEARTBEAT_S)
            escalate();                     /* 重连→重拨→软重启→硬重启 */
        break;
    }
}
/* URC(+QIURC:"closed")独立队列处理；每日 QGDCNT 与云端统计对账，偏差>20% 告警 */
```

## 84.5 低功耗两件套：PSM 与 eDRX 参数计算

| 参数 | 含义 | 示例取值与计算 |
|------|------|----------------|
| TAU(T3412) | 周期性注册更新间隔 | 设 6h：均摊电流=E_note/21600s；一次注网能量约 3.7V×650mA×1s≈0.66mWh → 约 30µA 均摊 ★大头 |
| Active Timer(T3324) | PSM 前可达窗口 | 取 30s：窗口内可被寻呼，下行交互须在此完成 |
| eDRX 周期 | 寻呼监听间隔(20s~41min 可配) | 取 20min：下行延迟均值 10min，电流介于 PSM 与常连之间 |

决策公式：可容忍下行延迟 ≥TAU → PSM 最省；秒~分级下行 → eDRX；实时业务 → 常连+心跳。注网比发数据更耗电（突发 A 级电流）——减少注网次数才是王道（实测联动 [[ch29-低功耗设计]]）。

## 84.6 信号质量判读与参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| CSQ 只有个位数 | AT+CSQ 反复查读 | 天线/IPEX 座/安装点位 | RSSI≥13 才有注网意义 |
| 注网慢或频繁掉注册 | qmicli 读信号强度 | 外置天线/高处布点 | RSRP≥-105dBm 且 SINR>0 |
| 心跳频繁掉线 | 服务端断连间隔统计 | 心跳周期 | 心跳间隔 < 运营商 NAT 寿命 |

## 84.7 实测数据表：心跳周期 vs NAT 存活率（三家运营商）

| 心跳间隔 | 移动 | 电信 | 联通 |
|----------|------|------|------|
| 60s | 存活率 100% | 100% | 100% |
| 5min | 97% | 99% | 95% |
| 10min | **81%** | 92% | 88% |

## 84.8 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| CEREG 一直搜索中 | SIM 未开通该制式/APN 错/欠费 | 五层漏斗：CPIN→CSQ(RSSI≥13)→COPS=? 扫全网 2~5min→APN 逐字核对(大小写敏感!)→CFUN=1,1 兜底+CGEEVENT 上报云端 |
| TCP 连接频繁被断 | 运营商 NAT 超时(常 5min 内) | 应用心跳<NAT 寿命(实测 5min 是安全线)；或改 UDP+CoAP 方案 |
| PSM 睡不下去 | URC 频繁/RI 引脚被拉住/驱动未释放 | 电流波形逐段归因；关不必要订阅 |
| 高温环境掉网 | 模组过温降频/PA 保护 | AT+QTEMP 监控曲线；导热垫+外壳风道整改 |
| 流量异常暴涨 | 重连风暴/固件 bug 死循环上传 | QGDCNT 分段审计；云端限流熔断 |

## 84.9 部署注意事项
1. 五层注网自诊断漏斗做成脚本随设备出货，售后工单量可减半；APN 收敛为配置项并逐字核对；
2. 海量设备严禁同步重试注网——随机退避不是可选项而是公德（信令风暴打瘫基站）；
3. 流量对账纳入日常巡检：每日 QGDCNT 与云端统计偏差 >20% 即告警；车规/户外必接 QTEMP 上报。

> [!example]- 🧪 动手实验 L84-1：从 SIM 到云完整链路+PSM 寻优（120 分钟）
> **步骤**：① AT 手动走通五层注网流程并记录每步响应；② cmgr 状态机接管连 Mosquitto(TLS)；③ 故障注入矩阵：拔卡/屏蔽天线/APN 错改/欠费模拟，记录每种检出时长与恢复动作；④ 记录「注网-上报-休眠」全周期电流波形，TAU 取 1h/6h/24h 各跑 24h 统计平均电流并推算十年电池。**验收**：四行故障矩阵记录+三条 TAU 能耗曲线与最优参数结论。

## 84.10 进阶话题
- eSIM/RSP 远程切号解决「出厂不知道卖到哪家」；GNSS 组合机型横评冷/热启动 TTFF、CEP50、功耗四指标——AGNSS 使冷启动 30s→3s，双频城市峡谷 1.5m→0.7m，标称打折看。

> [!warning]- ❓ FAQ
> **Q1：PSM 与 eDRX 如何取舍？** 下行容忍度 ≥TAU 用 PSM 最省电；要秒~分级响应用 eDRX；实时业务只能常连+心跳，并把保活流量成本计入十年 TCO。
> **Q2：注网失败为何先怀疑卡和天线？** 五层漏斗里 SIM 欠费/未开通制式与天线松动占大多数；RSSI≥13 且换卡交叉验证通过后再查 APN 与锁频。

> [!question] 📝 思考题
> 1. 推导「每小时上报 100B」场景下 NB-IoT PSM 的平均电流与十年电池需求。
> 2. 设计模组固件 FOTA 流程（差分包+双镜像+签名），复用 ch30 思想。
> 3. 对比 QMI 与 PPP 在弱网恢复速度上的差异原因。

---
🏷️ #domain/protocol #topic/nb-iot | 🔗 [[ch83-LoRaWAN组网LoRaMac-node-ChirpStack]] ← **本章** → [[ch85-PCIe总线拓扑BAR空间lspci排障]] | 📚 [[P8-MOC]]
