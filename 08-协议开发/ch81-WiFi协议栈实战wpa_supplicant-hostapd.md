---
title: "第81章 WiFi协议栈实战：wpa_supplicant/hostapd"
part: "[[P8-MOC]]"
chapter: 81
tags:
  - domain/protocol
  - topic/wifi
difficulty: 4
est_minutes: 40
prerequisites:
  - "[[ch80a-MQTT-CoAP云协议本体与实现]]"
related:
  - "[[ch32-ESP32外设与WiFi-BLE上手]]"
  - "[[ch86-综合案例无线共存干扰排障全流程]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第81章 WiFi协议栈实战：wpa_supplicant/hostapd

> [!info] 导航
> ⏱ 40min | ★★★★☆ | 前置 [[ch80a-MQTT-CoAP云协议本体与实现]] | → [[ch82-BLE开发GATT设计BlueZ-DFU]]

## 🎯 学习目标
- [ ] 复述关联五步曲与各步抓包失败指纹，完成 wpa_supplicant(STA)/hostapd(软AP) 双角色配置与 wpa_cli/iw 诊断
- [ ] 制定 RSSI 门限+迟滞的漫游策略与断线自愈闭环
- [ ] 说清 DTIM/省电模式对延迟的影响，并搭通一条 ESP-NOW 直连链路

## 81.1 关联五步曲与失败指纹

802.11 关联五步：扫描→认证→关联→四次握手→DHCP。抓包对照即可知断在哪一环：

| 阶段 | 动作 | 失败指纹 |
|------|------|----------|
| ① 扫描 Scan | 主动 Probe Req→Resp 或被动听 Beacon | 扫不到=信道/地区码错 |
| ② 认证 Auth | Open/SAE | - |
| ③ 关联 Assoc | 能力协商速率/HT/VHT | status≠0=AP 拒绝(17=容量满，1=能力不匹配) |
| ④ 密钥协商 4-Way Handshake | EAPOL 派生 PTK | M3 不来=密码错(AP 静默丢弃) |
| ⑤ DHCP | Discover→Offer→Request→ACK(DORA) | 超时=服务器不可达/VLAN 未放行 |

安全模式选型：WPA2-PSK(AES) 家用基线；WPA3-SAE 新基准(防字典攻击)；WPA2-Enterprise(EAP-TLS) 企业级设备身份★产品化推荐——EAP-TLS 与证书体系同构，设备证书即身份，比 PSK 强一个量级。

## 81.2 Linux 双角色配置与诊断全家桶

STA 与软AP 的核心命令如下（wpa_cli 是 supplicant 的标准控制接口）：

```bash
# STA：生成配置并后台运行，dhclient 拿 IP
wpa_passphrase MySSID pass123 > /etc/wpa.conf
wpa_supplicant -i wlan0 -c /etc/wpa.conf -B && dhclient wlan0
wpa_cli status ; wpa_cli scan_results ; wpa_cli signal_poll   # RSSI 实时监控
# 软AP：hostapd + dnsmasq DHCP = 配网门户标配
cat > hostapd.conf <<EOF
interface=wlan0
ssid=GW-Setup
hw_mode=g
channel=6
wpa=2
wpa_key_mgmt=WPA-PSK
wpa_passphrase=setup1234
EOF
hostapd hostapd.conf
iw dev wlan0 station dump ; iw survey dump   # 空口诊断：单站重传+信道占用度
```

## 81.3 稳定性工程化：漫游阈值与自愈闭环

1. **RSSI 门限策略**：>-60dBm 优 / -70dBm 可用 / <-75dBm 主动换 AP 或降速率保联；
2. **漫游阈值+迟滞**：企业多 AP 用 802.11k/v/r 三件套辅助快速切换；嵌入式简化版=信号低于门限(如 -70dBm)触发 scan+roam，且仅当候选 RSSI 比当前高 8~10dB 才切换——迟滞带防止两 AP 之间乒乓振荡；
3. **重传率监控**：`iw station dump` 的 tx failed/retries 比值>10% 即环境劣化预警；
4. **断线自愈闭环**：supplicant 断开后指数退避重连，连续 N 次失败重启射频驱动。

## 81.4 DTIM/省电对延迟的影响 与 esp_wifi 事件纪律

Modem-sleep(如 `esp_wifi_set_ps(WIFI_PS_MIN_MODE)`) 让终端在 DTIM 间隙休眠，用吞吐换电流：DTIM=3、Beacon=100ms 时下行包最多要等 300ms 才被取走，ping 尾延迟被拉到数百毫秒；缓冲不足还会出现「低功耗下 ping 丢包率高」。对策：实时性敏感链路调 MIN 或关 PS 复测，AP 侧重传缓存兜底。

初始化顺序铁律：NVS→netif→event_loop→wifi_init，乱序必 panic。事件分流：STA_DISCONNECTED 看 reason——4=密码错停止重试并告警，201=AP 无响应退避重试；STA_CONNECTED 后要等 IP_EVENT 才算就绪。**纪律：所有业务只听事件回调，绝不轮询 esp_wifi 内部状态。**

## 81.5 关键代码：ESP-NOW 直连模式

```c
/* 乐鑫私有轻量协议：无关联/无 IP，点对点载荷 <=250B，延迟 ~2ms */
wifi_init();
esp_wifi_set_channel(6, WIFI_SECOND_CHAN_NONE);   /* 全网必须同信道 */
esp_now_init();
esp_now_register_send_cb(on_sent);
esp_now_register_recv_cb(on_recv);
esp_now_peer_info_t p = { .channel = 6 };
memcpy(p.peer_addr, peer_mac, 6);                  /* 广播地址=FF:FF:FF:FF:FF:FF */
esp_now_add_peer(&p);
esp_now_set_pmk(pmk);                              /* 加密防窃听；防重放需自加 seq */
esp_now_send(peer_mac, payload, len);
```

典型组网：星型遥控(手柄→车)/Mesh 式中继(自研跳表)。与 WiFi 共存：同信道时 ESP-NOW 包会被 WiFi 挤压——高可靠场景固定信道+关闭 STA 或错峰发送(时分思想见 ch86)。

## 81.6 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 漫游乒乓 | 双 AP RSSI 曲线对比 | 加 8~10dB 迟滞带 | 单位时间切换次数骤降 |
| 低功耗 ping 丢包 | 开/关 PS 对照复测 | WIFI_PS_MIN_MODE 或关 PS | 丢包率回落至 0 |
| 速率只有 54M | iw phy info 看 HT capability | 国家码/40MHz 共存设置 | 协商上 HT/VHT |

## 81.7 实测数据表：不同信号强度下的可用速率与丢包（同房间实测）

| RSSI | 协商速率 | TCP 吞吐 | 丢包率 | 建议动作 |
|------|----------|----------|--------|----------|
| -40dBm | HT80 最高档 | ~45Mbps | 0 | 理想 |
| -60dBm | 中高 | ~25Mbps | <0.5% | 良好 ★设计目标下限 |
| -70dBm | 低速档 | ~8Mbps | 2~5% | 可工作，禁 OTA 大包 |
| -80dBm | 最低基本速率 | <2Mbps | 10%+ | 触发换网逻辑(81.3) |

## 81.8 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 偶发掉线集中高峰期 | 信道拥塞/路由器踢空闲 | survey 占用度记录；心跳周期小于 NAT/ARP 老化 |
| EAP-TLS 偶发认证失败 | 时钟漂移致证书有效期窗口越界 | SNTP 强制校时后再连；日志看 TLS alert 码 |
| 软AP 手机搜不到 | 信道与 STA 冲突/MAC 过滤 | 另一台手机扫原始 Beacon(Kismet 类工具) |

## 81.9 部署注意事项

1. 配网选型：SmartConfig/AirKiss 依赖路由器组播行为，脆弱不推荐新品；SoftAP 门户最稳；BLE 配网体验与可靠性双优★主流(S3 双模)；ZTP(option43/云注册码)是企业批量必备；
2. PMF(802.11w) 兼容坑：新路由器默认 required PMF，老 IoT 模组不支持即连不上——产品认证矩阵要覆盖；
3. Sniffer 模式抓空口包喂 Wireshark 排查自家干扰；ESP-NOW/SoftAP 固定信道避免跳频失配。

> [!example]- 🧪 动手实验 L81-1：空口级 WiFi 体检报告（75 分钟）
> **步骤**：① ESP32 sniffer 抓 10 分钟全信道流量，统计各信道占用；② wpa_cli signal_poll 记录 RSSI 曲线与位置关系；③ 制造干扰(微波炉)复测丢包率变化；④ iw dev wlan0 station dump 观察重传计数器演化；⑤ 输出「信道热力+RSSI 走廊+重传曲线」三合一报告。
> **验收**：报告方法可直接迁移到客户现场勘测；干扰前后丢包率对比数据完整。

## 81.10 进阶话题
- 802.11k/v/r 快速漫游三件套的落地条件；
- mDNS/DNS-SD 零配置发现：配网页面与本地控制的发现层(IDF mdns 组件开箱即用)；
- EAP-TLS 落地清单：RADIUS+CA 体系+supplicant 配置模板；书目 Gast《802.11 Wireless Networks》与工具 horst/Kismet 值得常备。

> [!warning]- ❓ FAQ
> **Q1：为什么 WiFi「能连上容易，连得稳很难」？** 环境全是变量——信道占用、干扰、AP 行为不可控，只能靠 RSSI/重传率指标闭环管理。
> **Q2：ESP-NOW 能和 WiFi 同时用吗？** 能，但必须同信道且互相挤压带宽；高可靠 ESP-NOW 链路建议固定信道+错峰发送。

> [!question] 📝 思考题
> 1. 推导 DTIM=3、Beacon=100ms 时 Modem-sleep 的平均监听占空比。
> 2. 设计「产线批量配网」方案：BLE 传凭证 vs SoftAP 门户 vs SmartConfig 取舍。
> 3. 用 ESP32 sniffer 模式量化你办公室 6 号信道的占用度曲线。

---
🏷️ #domain/protocol #topic/wifi | 🔗 [[ch80a-MQTT-CoAP云协议本体与实现]] ← **本章** → [[ch82-BLE开发GATT设计BlueZ-DFU]] | 📚 [[P8-MOC]]
