---
title: "第17章 Wireshark / tcpdump 抓包分析与流量镜像方法"
part: "[[P2-MOC]]"
chapter: 17
tags:
  - domain/fundamentals
  - topic/network
difficulty: 3
est_minutes: 40
prerequisites:
  - "[[ch16-perf-ftrace-strace性能剖析]]"
  - "[[ch63-网络编程与TLS从socket到安全上云]]"
related:
  - "[[ch18-示波器实战]]"
  - "[[ch86-综合案例无线共存干扰排障全流程]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第17章 Wireshark / tcpdump 抓包分析与流量镜像方法

> [!info] 导航
> ⏱ 40min | ★★★☆☆ | 前置 [[ch16-perf-ftrace-strace性能剖析]] | → [[ch18-示波器实战]]

网络类故障（连不上/掉线/慢）没有抓包就是玄学。本章把「抓得到、看得懂、能定位」一次讲完：两种过滤器语法、TCP 异常指纹表、五大抓包点与 tshark 自动化。

## 🎯 学习目标
- [ ] 区分 BPF 捕获过滤器与 Wireshark 显示过滤器的语法与性能差异
- [ ] 读懂 TCP 握手/重传/ZeroWindow/MTU 黑洞的包级表现并映射到排查动作
- [ ] 按场景选择五大抓包点：板端/镜像口/monitor/usbmon/逻辑分析仪转 pcap
- [ ] 用 tshark 把协议字段断言塞进 CI 回归脚本

## 17.1 双工具分工与两种过滤器

| 工具 | 位置 | 优势 |
|------|------|------|
| tcpdump | 板端命令行 | 轻量、可脚本化、先粗筛后落盘 |
| Wireshark | 主机 GUI | 协议树解析、流追踪、专家信息、IO 图 |

BPF 捕获过滤器跑在内核逐包裁剪（性能高、语法古老），显示过滤器跑在用户态事后筛选（表达力强）——**两者语法完全不同，不可混用**。另记一条：「连不上云」一半案子破在 DNS，`dns.flags.response==0` 查询无应答/应答 IP 错误都是嫌疑。

## 17.2 TCP 包级读片表（排障核心）

| 包特征 | 含义 | 常见根因 |
|--------|------|----------|
| SYN 无响应 ×N | 连接被丢弃 | 端口未监听/IP 错误/防火墙；ARP 未解析成功（先看 ARP 有无 reply） |
| SYN→SYN,ACK 但 ACK 缺失 | 半开连接堆积 | 客户端回程路由不通（网关配置） |
| RST 立即返回 | 主动拒绝 | 服务未起、backlog 满、防火墙 REJECT |
| DUP ACK 洪流 + Fast Retransmit | 丢包恢复中 | 无线链路质量/WiFi 重传（联动 [[ch86-综合案例无线共存干扰排障全流程]]） |
| ZeroWindow 反复出现 | 接收方应用消费不动 | 对端任务阻塞/缓冲满——查应用而非网络 |
| 大包丢小包通（MTU 黑洞） | 路径 MTU 问题 | PMTU 发现失效；临时 MSS clamp 或降 MTU 验证 |

## 17.3 关键代码：板端抓包、显示过滤、五抓包点与 tshark

```bash
tcpdump -i eth0 -w /tmp/cap.pcap -s 0 'host 192.168.1.100 and port 502'
  # 板端只抓目标交互防爆盘：-s0 全包；-C 10 -W 5 滚动文件(10MB×5)；-U 实时落盘
```

```text
Wireshark 显示过滤器（注意与 BPF 捕获过滤器语法完全不同！）：
ip.addr==192.168.1.20 && tcp.port==1883        # MQTT
mqtt.msgtype==3                                 # PUBLISH
tcp.analysis.retransmission                     # 只看重传
tcp.flags.syn==1 && tcp.flags.ack==0            # 新建连接
```

嵌入式五大抓包点：

```text
① 板端 tcpdump —— 最方便，但高吞吐时丢包（先看 dropped 计数）
② 交换机镜像口(SPAN) —— 主机侧旁路，零侵入最真实
③ WiFi monitor 模式：airmon-ng start wlan0; iw dev mon0 set channel 6;
   能看 802.11 管理/控制帧全貌（重传率统计联动 [[ch81-WiFi协议栈实战wpa_supplicant-hostapd]]）
④ USB 场景：usbmon 内核模块抓枚举与传输（[[ch79-USB协议与驱动枚举描述符HID-CDC-Gadget]]）
⑤ 串口/总线没有"包"概念 → 逻辑分析仪导出 CSV 脚本转 pcap，
   让 Modbus/CAN 帧也享受 dissector 解析（[[ch19-逻辑分析仪与sigrok]]）
```

```bash
tshark -r cap.pcap -Y 'mqtt' -T fields \
    -e frame.time_relative -e ip.src -e mqtt.msgtype -e mqtt.topic | head
tshark -r cap.pcap -z conv,tcp            # 会话排行；字段级断言塞进回归脚本比人眼可靠一个量级
```

多源时间轴对齐三板斧：

```text
① 统一 NTP/PTP 源：SNTP 校时 ~10ms 够用；µs 级用 PTP 或 GPIO 秒脉冲打标
② 各端记录同一触发事件（拔插网线）的时间戳三方对照，Wireshark 改 Absolute 时间+参考帧对齐——因果争论就此消停
```

## 17.4 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 抓包文件巨大难分析 | 文件大小 vs 业务时长 | BPF 先筛；tshark -Y 二次提取；按 stream 分割 | 单文件只含目标流 |
| 高吞吐丢包 | tcpdump 结束时读 dropped | 换 SPAN 镜像口旁路抓 | dropped=0 |
| TLS 流量看不懂 | 只看握手时延与证书链 | 测试环境配 SSLKEYLOGFILE 解密 | 明文可见且不影响行为 |

## 17.5 实测数据表：MQTT 偶发断连归因时间线（真实案例）

| 观察点 | 时间差 | 含义 |
|--------|--------|------|
| client keepalive publish → 无响应 | 静默期 ~60s | 设备侧 lwIP 栈停摆（任务长时间关调度） |
| 断连前大量 DupACK | 静默期前后 | 链路恢复中的伴随现象，非根因 |
| server 发 RST | publish 后 15s | broker 心跳超时踢人，是结果不是原因 |
| DWT 实测 OTA 校验函数阻塞 | 单次 62s | 根因：改分片+让步后断连归零 |

经验：「网络问题」八成最终是本机软件问题——抓包给了证据链。

## 17.6 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| tcpdump 抓不到任何包 | 接口名错/权限不足/VLAN tag | ip -br link 列接口；sudo；vlan 关键字或交换机侧剥 tag |
| Wireshark 显示 checksum bad | 网卡 offload 导致校验和留空（正常现象） | ethtool -K eth0 tx off 复测或忽略该告警 |
| 抓包文件巨大难分析 | 无过滤全抓 | BPF 先筛；tshark -Y 二次过滤；按 stream 分割 |
| TLS 流量看不懂 | 加密正常现象 | SSLKEYLOGFILE 解密；或只看握手时延与证书链 |

## 17.7 部署注意事项

1. 板端永远带 BPF 过滤器抓包，配 `-s 0` 全包 + `-C/-W` 滚动文件，防 SD 卡写爆。
2. 高吞吐场景优先 SPAN 镜像口或树莓派透明桥（两网卡 bridge+tc mirror，成本约 ¥200），板端只做兜底。
3. 长案取证一律存 pcapng：支持多接口+注释+每包纳秒时间戳。
4. 抓包前先做时间轴对齐（17.3 第四块），否则跨设备证据链不被采信。

> [!example]- 🧪 动手实验 L17-1：MQTT 断线 RST 归因（40 分钟）
> **步骤**：① 板端 tcpdump 只抓 broker 流量；② 制造一次真实断线（路由器重启或心跳超时）；③ Wireshark 追踪流，定位第一个 FIN/RST 的发送方与前一包时间差；④ 结合 keepalive 配置判断是 NAT 超时还是主动踢；⑤ 按 [[ch63-网络编程与TLS从socket到安全上云]] 结论调整心跳并复测。**验收**：能用一张带注释的时序截图向他人讲清整条断线因果链。

## 17.8 进阶话题
- **TLS 时代调试姿势**：mbedTLS 自导 session key，或前置终结 TLS 的网关上看明文
- **ZeroWindow 复现实验**：接收端 sleep 不 read，观察发送端 cwnd 与 Win 字段演变
- **dissector 平权思想**：UART/CAN 转 pcap 后，串行总线也能享受字段级解析与 CI 断言

> [!warning]- ❓ FAQ
> **Q1：BPF 与显示过滤器为何性能差异巨大？** BPF 在内核逐包裁剪，落盘前就丢弃无关流量；显示过滤器是用户态事后筛选，全量数据先进盘。
> **Q2：板端抓包丢包了怎么办？** 先读 tcpdump 的 dropped 计数确认，再换 SPAN 镜像口或透明桥旁路采集，板端只留低速率兜底。

> [!question] 📝 思考题
> 1. 解释 BPF 捕获过滤器与显示过滤器为何性能差异巨大（内核裁剪 vs 用户态筛选）。
> 2. 设计实验复现 ZeroWindow：接收端 sleep 不 read，观察发送端 cwnd 与 Win 字段演变。
> 3. 把逻辑分析仪的 UART 数据转成 pcap 并用 Wireshark 的 Modbus dissector 解析。

---
🏷️ #domain/fundamentals #topic/network | 🔗 [[ch16-perf-ftrace-strace性能剖析]] ← **本章** → [[ch18-示波器实战]] | 📚 [[P2-MOC]]
