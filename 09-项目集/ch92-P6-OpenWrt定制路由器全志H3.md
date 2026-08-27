---
title: "第92章 P6 · OpenWrt 定制路由器：全志 H3 从固件到插件开发"
part: "[[P9-MOC]]"
chapter: 92
tags:
  - domain/soc
  - topic/linux
  - topic/qos
difficulty: 4
est_minutes: 40
prerequisites:
  - "[[ch37-全志H3-OrangePiZero-NanoPiNEO实战]]"
related:
  - "[[ch54-全景认知与发行版抉择QEMU路线]]"
  - "[[ch90-P4-LoRa温湿度采集网关ChirpStack后端]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第92章 P6 · OpenWrt 定制路由器：全志 H3 从固件到插件开发

> [!info] 导航
> ⏱ 40min | ★★★★☆ | 前置 [[ch91-P5-RK3568边缘AI盒子多路视频检测推流]] | → [[chsa-S1安全架构与SecureBoot实战]]

## 🎯 学习目标
- [ ] 为 Orange Pi Zero 定制一台带完整管理界面（LuCI）的路由器
- [ ] 掌握 OpenWrt 包体系并开发一个自定义 LuCI 应用
- [ ] 落地 SQM 智能 QoS 消除 bufferbloat 与流量统计等实用功能

## 92.1 构建与刷机全流程

```bash
git clone https://github.com/openwrt/openwrt && cd openwrt
./scripts/feeds update -a && ./scripts/feeds install -a
make menuconfig:   # Target: sunxi/cortexa7 ; Profile: Orange Pi Zero
                   # LuCI → Collections: luci ; Applications: luci-app-* 按需
make download -j8 && make -j$(nproc) V=s
# 刷机 dd 到 SD 卡；串口 115200 看 first boot；passwd 设 root 密码
```

## 92.2 网络规划与基础配置

| 项 | 规划 |
|----|------|
| WAN | eth0，DHCP 上联 |
| LAN | wlan0 无线 AP + USB 网卡（AX88772）有线扩展 |
| 防火墙 | /etc/config/network + firewall 的 wan→lan masquerade zone |
| QoS ★ | opkg install luci-app-sqm → 配置 CAKE 限速曲线消除 bufferbloat |

## 92.3 自定义包与 LuCI 插件最小可跑样例

```text
# 包结构（feeds 或 package/ 下）：UCI 是 OpenWrt 一切配置的灵魂，
# 守护进程读 uci 配置执行业务；LuCI 插件 = uci 配置界面生成器
mypkg/
├── Makefile            # Build/Prepare/Compile/Install 四段式
└── src/mydaemon.c      # 你的守护进程

luci-app-mystat/                        # 最小 LuCI 插件
├── Makefile                            # 包定义(依赖 luci-base)
├── root/usr/lib/lua/luci/controller/mystat.lua
    module("luci.controller.mystat",package.seeall)
    function index()
        entry({"admin","status","mystat"},template("mystat"),"MyStat",60)
    end
└── root/usr/lib/lua/luci/model/cbi/mystat.lua   # 表单→UCI 映射
    m=Map("mystat","流量统计")
    s=m:section(NamedSection,"global","stat"); s.addremove=false
    o=s:option(Flag,"enable","启用统计"); o.rmempty=false
# 数据面： nft 加计数规则 → mystat 页面读计数或 ubus 调用（现代栈：LuCI3+rpcd ubus）
```

## 92.4 进阶功能路线

1. **流量分账**：iptables/nft 计数规则按 IP 统计 → Lua 页面图表展示；
2. **广告过滤**：集成 dnsmasq full + AdGuard Home 二选一部署；
3. **异地组网**：WireGuard 站点到站点隧道（内核态性能远优于用户态）；
4. **监控上报**：collectd/node_exporter 把路由器纳入 Grafana 体系（联动 [[ch90-P4-LoRa温湿度采集网关ChirpStack后端]]）。

## 92.5 BOM 与资源占用

| 物料 | 规格 | 说明 |
|------|------|------|
| 主板 | Orange Pi Zero（H3, cortex-a7） | 见 [[ch37-全志H3-OrangePiZero-NanoPiNEO实战]] |
| 扩展网卡 | USB AX88772（可换千兆型号） | 有线 LAN 扩展 |
| 存储/电源 | ≥8GB SD 卡；5V≥2A | 典型值：基础系统 <64MB RAM；NAT 高压留裕量 |

## 92.6 里程碑与验收门

| 门 | 里程碑 | 出口准则 |
|----|--------|----------|
| M1 | 固件构建+刷机 | 串口看到 first boot，root 密码可设 |
| M2 | WAN/NAT/防火墙通 | lan 下设备经 wan 上网，zone 规则生效 |
| M3 | SQM 生效 | waveform bufferbloat 测试从 F 级到 A 级截图存档 |
| M4 | 自研插件上线 | mystat 菜单出现、表单落盘 UCI、计数可见 |
| M5 | 可靠性演练 | 72h NAT 高压不死机；sysupgrade 与恢复出厂通过 |

## 92.7 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| bufferbloat 仍 C/D 级 | waveform 测试+sqm 日志 | CAKE 带宽设链路速率 ~85% 开 ack-filter | 达到 A 级 |
| 插件菜单不显示 | 检查 controller entry 路径 | luci-base 未选/entry 冲突 | Web 出现 MyStat 菜单 |

## 92.8 实测数据表

| 场景 | 指标 | 结果判据 |
|------|------|----------|
| SQM 前后对比 | bufferbloat 等级 | F→A 级截图存档 |
| 72h NAT 高压(BT 类多连接) | 死机/漏表次数 | 0 次 |

## 92.9 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 构建期 feeds 报错缺包 | update/install 顺序或网络问题 | 先 update 再 install；换源重试 |
| 刷机后串口无输出 | DTB 与板型不符/dd 目标错 | 核对 Profile 与写卡设备；查 TX 接线 |
| WAN 通但 LAN 不通 | firewall 未挂 forwarding zone | 检查 wan→lan 转发与 masquerade |

> [!example]- 🧪 动手实验 L92-1：SQM 抗 bufferbloat 实战（45 分钟）
> **步骤**：① 未启用 SQM 跑 waveform bufferbloat 记录等级与延迟曲线；② 安装 luci-app-sqm，CAKE 带宽设为实测下行/上行 ~85%，开 fq_cake+ack-filter；③ 同一时段复测三次；④ 前后截图归档。
> **验收**：bufferbloat 达到 A 级且三次稳定；上传满载时延迟增量 <30ms（典型值）。

## 92.10 开源对照

| 参考对象 | 收获 |
|----------|------|
| OpenWrt Wiki 的 sunxi 平台页 | H3 设备树与已知坑清单 |
| openwrt/packages 任意 luci-app | 插件工程范本（挑 star 多的中型项目精读） |
| pandora-box / FriendlyWrt | 国产衍生发行版的差异化思路 |

## 92.11 进阶话题

- **UCI 的哲学**：一切配置皆文件+版本化——「配置即代码」在路由器世界的原生实践；
- **硬件流表卸载**：flowtable offload 把 NAT 打入快路径——H3 上也能白拿 30% 吞吐；
- **多 WAN 策略路由**：双 ISP 负载均衡与故障切换（mwan3）——小企业级功能在家用板上落地。

> [!warning]- ❓ FAQ
> **Q1：守护进程为什么读 UCI 而不是自己写配置文件？** UCI 统一存储/版本化/命令行操作，LuCI 表单、ubus、启动脚本共享同一份真相——绕开它等于放弃生态；新插件建议直接上 LuCI3(RactJS)+rpcd ubus 现代栈。

> [!question] 📝 思考题
> 1. 解释 CAKE 相比 HTB+FQ_CODEL 在对抗 bufferbloat 上的算法优势。
> 2. 把 P4 的 LoRa 网关管理界面移植成本项目的 LuCI 插件需要动哪里？
> 3. 评估 H3 百兆口对 QoS 精度的限制及 USB 千兆扩展后的变化。

🎓 **毕业寄语**：项目集到此闭环。回到 [[ch01-导学与能力地图]] 做 L1~L5 自评。「测量驱动决策、分层控制复杂度、证据链说话」——三句话带走，剩下的路你已经会走了。

---
🏷️ #domain/soc #topic/linux #topic/qos | 🔗 [[ch91-P5-RK3568边缘AI盒子多路视频检测推流]] ← **本章** → [[chsa-S1安全架构与SecureBoot实战]] | 📚 [[P9-MOC]]
