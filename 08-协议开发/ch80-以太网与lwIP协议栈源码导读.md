---
title: "第80章 以太网与 lwIP 协议栈源码导读"
part: "[[P8-MOC]]"
chapter: 80
tags:
  - domain/protocol
  - topic/network
  - topic/lwip
difficulty: 4
est_minutes: 40
prerequisites:
  - "[[ch79-USB协议与驱动枚举描述符HID-CDC-Gadget]]"
related:
  - "[[ch62-应用编程epoll进程线程IPC]]"
  - "[[ch63-网络编程与TLS从socket到安全上云]]"
  - "[[ch80a-MQTT-CoAP云协议本体与实现]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第80章 以太网与 lwIP 协议栈源码导读

> [!info] 导航
> ⏱ 40min | ★★★★☆ | 前置 [[ch79-USB协议与驱动枚举描述符HID-CDC-Gadget]] | → [[ch80a-MQTT-CoAP云协议本体与实现]]

## 🎯 学习目标
- [ ] 说清 MAC+PHY 架构、RMII 接线与 BMSR/LPA 寄存器的自协商判读
- [ ] 对比 raw/netconn/socket 三种 API 并解释 lwIP 线程模型与保护机制
- [ ] 读懂 pbuf 四类型与收发零拷贝路径，定位 ethernetif 移植点
- [ ] 用 TCP 三重门参数把板子吞吐从默认值调到接近线速

## 80.1 MAC+PHY 架构与 RMII 调试三板斧
硬件链路：MAC（芯片内）←RMII 50MHz→ PHY（LAN8720）←磁变压→ RJ45。调试三板斧：
1. MDIO 读 PHY 寄存器：BMSR bit2=link 状态、bit5=自协商完成；
2. 自协商结果读 LPA 寄存器，解析对端能力（10/100M 全半双工）；
3. LED 判读：LINK/ACT 闪烁模式对照 datasheet——双灯全亮但无数据 = 常见于速率双工不匹配。

F407+LAN8720 经典坑：RMII REF_CLK 来源（外部 50M 晶振 vs MCO 输出）与宏 `ETH_RMII_PHY_ADDR` 必须一致，否则「网线插着也 link down」。

## 80.2 lwIP 三种 API 对比与线程模型

| API | 上下文 | 性能 | 适用 |
|-----|--------|------|------|
| raw/callback | 中断/轮询上下文回调 | 最高，零拷贝潜力 | 裸机无 OS；高性能 UDP 流 |
| netconn ★RTOS 推荐 | RTOS 线程安全封装 | 中 | FreeRTOS 下首选 |
| socket(BSD) | 标准套接字 | 有拷贝开销 | 可移植性优先/教学 |

线程模型：netconn/socket 把所有内核操作投递到唯一的 tcpip_thread 邮箱串行执行；多线程必须经此统一入口，绕过则需 `SYS_LIGHTWEIGHT_PROT=1` 保护核心临界区——配置错了就是随机崩溃（裸机 NO_SYS=1 时 raw 回调直接跑在中断/轮询上下文，禁止阻塞）。

## 80.3 pbuf 四类型与零拷贝

```c
/* pbuf 四类型：
   PBUF_RAM:          堆分配（发送构造用）
   PBUF_POOL:         固定尺寸池链（接收主力——预分配防碎片）
   PBUF_ROM/PBUF_REF: 引用已有数据区 —— 零拷贝关键! */
struct pbuf { struct pbuf *next; void *payload; u16_t len, tot_len; u8_t type; };
/* 收包路径：DMA 直接写 PBUF_POOL 的 payload（RW 对齐偏移 4 字节留头部空间）
   → eth_input 剥以太网头 → IP/TCP 分发 —— 全程无 memcpy ★ */
/* 发送零拷贝技巧：应用数据直写 PBUF_RAM 的 payload，
   或 PBUF_REF 包住应用缓冲（生命周期——发送完成前不许释放!） */
```

ethernetif 移植点就在三个函数：`low_level_init()` 初始化 ETH DMA 描述符环；`low_level_input()` 从 DMA 取帧装进 PBUF_POOL 再交 eth_input；`low_level_output()` 把 pbuf 链挂到 TX 描述符发出。

## 80.4 TCP 三重门与性能调优参数

| 参数(lwipopts.h) | 作用 | 建议起点(F407) |
|------------------|------|----------------|
| MEM_SIZE | 堆式内存总量 | 16KB~48KB |
| PBUF_POOL_SIZE | 接收池数量 | ≥8（突发容忍） |
| TCP_MSS / TCP_WND | 最大段/接收窗口 | MSS=1460, WND=4×MSS 起 |
| TCP_SND_BUF/QUEUE | 发送缓冲 | =2×WND；队列开 |
| CHECKSUM_BY_HARDWARE | 硬校验卸载 | F407 ETH 支持→开启 |

三重门打满症状：TCP_SND_BUF 满 → write 返回 ERR_MEM 阻塞；TCP_WND 小 → 对端 cwnd 停滞、吞吐腰斩；TCP_MSS 过小→包头税、过大→分片丢包敏感。调优顺序：先保 WND≥2×MSS×带宽时延积需求，再看 SND_BUF 匹配应用节奏。

```c
err = netconn_write_partly(conn, buf, len, NETCONN_COPY, &sent);
if (err == ERR_OK && sent < len) {
    /* 只发了一部分——把剩余重新入队，别硬写！(背压感知) */
}
/* 零拷贝变体：NETCONN_NOCOPY + pbuf 引用用户缓冲，
   发送完成回调里才释放 —— 高频遥测的省 CPU 大招 */
```

## 80.5 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 吞吐只有理论 20% | 统计每包 memcpy 占比 | 加大 WND+合并小包(Nagle 权衡) | 吞吐阶梯上升 |
| 运行数小时分配失败死机 | stats 显示 mem.err 计数 | 审查所有 pbuf_free 配对 | 泄漏计数不再增长 |
| 偶发重传风暴 | 读 ETH DMA 统计寄存器 | 加描述符数量/降低中断负载 | 丢包计数归零 |
| 网线插着 link down | MDIO 读 BMSR/LPA | REF_CLK 来源与 PHY ADDR 宏一致 | BMSR bit2=1 稳定为 1 |

## 80.6 实测数据表：lwIP 吞吐调优实录（F407+LAN8720，100M 全双工）

| 配置版本 | TCP RX 吞吐 | CPU 占用 |
|----------|-------------|----------|
| 默认配置(WND=4×MSS) | 31Mbps | 68% |
| WND 提到 8×MSS + 池加深 | 52Mbps | 74% |
| +硬件校验和卸载 | 61Mbps | 58% |
| +ETH DMA 描述符翻倍 | **72Mbps** | 55% |

100M 线速理论 ≈100Mbps，实测 72% 即优秀——剩余是协议开销的物理极限。

## 80.7 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| PING 通但 TCP 连不上 | 监听未起/端口错 | tcp_bind 返回值核查；Wireshark 看 SYN-RST 方向 |
| 吞吐只有理论 20% | 每包一次 memcpy/窗口太小 | perf 统计拷贝占比；加大 WND+合并小包 |
| 运行数小时后分配失败死机 | pbuf 泄漏(引用后忘 free) | stats 显示 mem.err 计数；审查 pbuf_free 配对 |
| 偶发重传风暴 | DMA 描述符环溢出丢包 | ETH DMA 统计寄存器；加描述符或降中断负载 |
| 多线程调用 socket 随机崩溃 | lwIP 核心保护缺失(NO_SYS 配置错) | SYS_LIGHTWEIGHT_PROT=1 且 netconn 层统一入口 |

## 80.8 部署注意事项
1. MEM_SIZE 与 PBUF_POOL 分工明确：堆给动态对象、池给收包——互借必碎片化；
2. SNTP 校时成功前禁止任何证书校验类连接——把「时间就绪」做成事件（TLS 前置条件）；
3. 双网卡网关显式管理 netif 默认路由与源地址选路；透明桥非 lwIP 强项，交硬件交换芯片；
4. lwIP 无内置 NAT——需要时移植 lwIP-NAT 补丁或换 Linux 方案；
5. 用 iperf2（嵌入式兼容性优于 3）建立回归基线，改版前后留存吞吐/CPU 数据。

> [!example]- 🧪 动手实验 L80-1：把吞吐从 31 调到 60+ 的全程记录（70 分钟）
> **步骤**：① iperf2 客户端指向板子建立基线；② 按 80.4 三重门逐项调整并每步测吞吐/CPU；③ GPIO 翻转+LA 观察 ETH 中断负载变化；④ 记录每步收益形成瀑布图。
> **验收**：一张「参数→吞吐」阶梯图，最终吞吐 ≥60Mbps。

## 80.9 进阶话题
- **大流量饿死小流量**（工业相机案例）：千兆图像流打满 PBUF_POOL→控制连接零窗饿死 28s；药方只有分池隔离（图像专用 MEM 区）+tcp_prio 优先级+UDP 心跳兜底，改造后连续 1000h 零失控——「一条 TCP 连接被另一条饿死」是共享内存栈的固有病；
- **LWIP_NETIF_STATUS_CALLBACK**：网口插拔事件钩子，业务层断线自愈的标准入口（思想同 [[ch63-网络编程与TLS从socket到安全上云]]）；
- **HTTP/SNTP/DNS 三件套**：makefsdata 把 html 目录编译成 fsdata.c 零文件系统依赖；http_set_cgi_handlers 做 /led.cgi 动态控制；dns_gethostbyname 异步解析；
- **双网口形态**：IP 路由器（双 netif 各自 IP 段+ip_forward）、单臂路由（VLAN tag 解析）、透明桥建议硬件方案；MQTT 云连接直接跑在本章栈上（[[ch80a-MQTT-CoAP云协议本体与实现]]）。

> [!warning]- ❓ FAQ
> **Q1：raw API 回调里能阻塞等待吗？** 不能——回调运行在内核/中断上下文，只做搬运与标记，重活交回主循环或邮箱。
> **Q2：netconn_write 返回 sent<len 正常吗？** 正常，这是背压信号——重新入队剩余数据即可，不要硬写耗尽 SND_BUF。

> [!question] 📝 思考题
> 1. 推导 100Mbps 满载时 PBUF_POOL_SIZE 的最小值需求（含突发余量）。
> 2. 把 TLS 客户端移植到 netconn API 并测握手耗时。
> 3. 阅读 tcp_out.c 的 tcp_write 分支逻辑，总结「何时触发分段」。

---
🏷️ #domain/protocol #topic/network #topic/lwip | 🔗 [[ch79-USB协议与驱动枚举描述符HID-CDC-Gadget]] ← **本章** → [[ch80a-MQTT-CoAP云协议本体与实现]] | 📚 [[P8-MOC]]
