---
title: "第44C章 新板矩阵：五块新硬件开箱与分析"
part: "[[P4-MOC]]"
chapter: "44C"
tags:
  - domain/soc
  - topic/bsp
  - topic/bringup
difficulty: 3
est_minutes: 30
prerequisites:
  - "[[ch44b-RK3588-NAS边缘服务器]]"
related:
  - "[[ch36-RK平台ATK-DLRK3568-RK3588-Luckfox]]"
  - "[[ch37-全志H3-OrangePiZero-NanoPiNEO实战]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第44C章 新板矩阵：五块新硬件开箱与分析

> [!info] 导航
> ⏱ 30min | ★★★☆☆ | 前置 [[ch44b-RK3588-NAS边缘服务器]] | → [[ch45-实时性理论与调度算法]]

## 🎯 学习目标
- [ ] 建立六板（含已有 ATK-RK3568）能力矩阵，按项目需求快速选型
- [ ] 掌握每块新板的 BSP 入口与首日开箱验证流程
- [ ] 理解各板在知识库中的角色定位与交叉引用关系

## 44C.1 六板能力矩阵总览
五块新板：正点原子领航者 ZYNQ7020 · 友善 NanoPC-T4(RK3399) · NanoPC-T6(RK3588) · 立创泰山派(RK3566) · 稚晖君夸克(全志 H3)，加上已有 ATK-RK3568 构成六板矩阵——从 µA 级 IoT 到异构计算的全谱覆盖。

| 维度 | 夸克 H3 | 泰山派 RK3566 | NanoPC-T4 (RK3399) | NanoPC-T6 (RK3588) | ZYNQ7020 |
|------|---------|---------------|--------------------|--------------------|----------|
| CPU | 4×A7@1.2GHz | 4×A55@1.8GHz | 2×A72+4×A53 | 4×A76+4×A55 | 2×A9 + PL(FPGA) |
| NPU | ✗ | 0.8~1T | ✗ | **3 核 6T** | PL 可定制加速器 |
| PCIe | ✗ | ✗(3566 无) | Gen2×4(NVMe) | Gen3×4 + Combo | PS GEM 以太网×2 |
| 特色 | 超迷你/开源 | 立创教程生态 | 大小核/NVMe | 旗舰全能 | RTL 硬件可编程 |
| 知识库定位 | 极简 Linux 入门 | P5 换板实录(ch91) | 大小核实验室 | ch44A/B 实机验证 | 第十三篇主线(Z1~Z5) |

选型决策树：
- 需要硬件级并行加速 / 时序确定 / 协议自定义 → **ZYNQ7020**（唯一选择）；
- 需要旗舰 AI 推理 + 多路视觉 + 大内存 → **T6 RK3588**；
- 需要大小核调度实验 / NVMe 存储 / 预算敏感的 Linux 开发板 → **T4 RK3399**；
- 需要 RK 标准流程入门 / 立创生态教程 → **泰山派 RK3566**；极致小型化 IoT 节点 → **夸克 H3**。

## 44C.2 各板 BSP 入口与首日开箱路线

| 板卡 | BSP 来源 | 首日验证三步 | 知识库联动 |
|------|----------|--------------|------------|
| 夸克 H3 | Seeed wiki + 稚晖君 GitHub(开源工程) | ①烧写出厂镜像→串口登录 ②WiFi 扫描确认 ③GPIO 点灯 | [[ch37-全志H3-OrangePiZero-NanoPiNEO实战]] + 本章 44C.4 |
| 泰山派 RK3566 | LCKFB 立创开发板资料中心(lckfb.com) | ①烧写 Buildroot/Debian 镜像 ②HDMI 出桌面 ③GPIO/I2C 外设测试 | ch36/[[ch41-Buildroot定制rootfs全流程]] + ch91(P5 换板) |
| NanoPC-T4 | FriendlyELEC wiki + Armbian | ①SD 卡启动 Armbian ②NVMe 识别确认 ③大小核拓扑检查(lscpu) | 本章 44C.3 + SO 系列([[chs1-SO1性能分析方法论与火焰图专题]]) |
| NanoPC-T6 | FriendlyELEC wiki + armbian/build rk35xx | ①eMMC 出厂系统验证 ②NPU 设备节点确认(/dev/rknpu) ③双网口连通 | ch36.10/ch43/ch44A·B 实机化 |
| ZYNQ7020 领航者 | 正点原子资料中心 + Vivado/Vitis/PetaLinux 2020.2 | ①JTAG 连接确认 ②PL 波形仿真跑通 ③FSBL→U-Boot→Linux 启动链 | **第十三篇(Z1~Z5)** + [[chz1-Z1导学与异构价值]] |

## 44C.3 NanoPC-T4：大小核实践第一板
RK3399 是国产 SoC 中最早成熟的 big.LITTLE 平台（2016 发布），虽已非旗舰，但社区维护恰好处于「厂商 BSP 可用、Armbian 主线可用但非完美」的中间态，是学习 BSP 差异与大小核调度的理想实物载体。

| 资源 | NanoPC-T4 规格 | 实验价值 |
|------|----------------|----------|
| CPU | 2×A72@1.8GHz(cluster1) + 4×A53@1.4GHz(cluster0) | 绑核实测 A72 vs A53 性能比；EAS 能效感知调度观察 |
| GPU | Mali-T860 MP4 | OpenGL ES 基准(与 RK3588 G610 对照) |
| 存储 | eMMC 16/32GB + M.2 M-key NVMe(Gen2×4≈1.6GB/s) | fio 存储基准；NVMe vs eMMC 对比 |
| 网络 | 千兆以太网×1 + PCIe WiFi 模组位 | NAT 转发/iperf 基准 |
| 接口 | USB3.0×1+USB2.0×2+HDMI2.0+DP1.2(Alt mode)+MIPI-CSI×2+MIPI-DSI | 多显示/摄像头扩展实验 |
| 系统 | FriendlyCore/FriendlyWrt/Lubuntu/Android7.1/Armbian(mainline u-boot+kernel 6.x) | **三代内核对比实验**(vendor 4.4 vs mainline 6.x) |

💡 T4 的最佳用法不是当主力开发板，而是当「性能差异标尺」：同一套 benchmark(cyclictest/fio/iperf3/AI 推理)分别在 T4(A72+A53)、T6(A76+A55)、泰山派(A55)上运行，产出跨代性能对照表——这就是面试时「我有实测数据」的底气来源。

## 44C.4 夸克 Quark (全志 H3)：极小型化设计决策分析

```text
为什么选 H3 而不是更新的芯片？
 ① 成本：H3 裸片已降至冰点(¥5 级)，整板 BOM 控制在 ¥50 内
 ② 生态：全志 H3 是 Linux 主线社区支持最完善的国产 SoC 之一(ch37)
 ③ 功耗：A7 四核典型负载 ~300mW，电池供电可行
 ④ 够用：目标场景(IoT 节点/传感器网关/教育)不需要 NPU 或 4K
设计决策(开源硬件学习范本)：
 · 超迷你(~21×51mm)：双排排针全引脚引出，无屏幕/无按键——纯核心板定位
 · 存储：SPI Nor Flash(16MB)+TF 卡座双通道——SPI 放最小系统固件，TF 放 rootfs
 · 无线：XR819 SDIO Wi-Fi(802.11 b/g/n)；无蓝牙(H3 无控制器)
 · 供电：USB Micro OTG 单口(供电+数据复用)
 · 调试：UART0 引出到排针，无板上 USB-UART——省空间，用户自备 CH340
对比 Orange Pi Zero(同 SoC)：OPi Zero 有 HDMI/红外/音频等「盒子功能」，
夸克砍掉一切非必需——定位就是「焊进你产品里的 Linux 核心」，做减法的产品思维值得学习。
```

## 44C.5 六板互操作路线图

| 路线 | 涉及板卡 | 描述 | 关联章节 |
|------|----------|------|----------|
| Linux 能力阶梯 | 夸克→泰山派→T4→T6 | 从最小系统到旗舰全功能，逐级解锁技能 | ch37→41→SO 系列 |
| AI 视觉梯度 | 泰山派→T6 | RK3566 单摄检测→RK3588 四目并行(ch44A) | ch43/ch91/44A |
| 软路由对比 | T4 vs T6 | FriendlyWrt 双机对比 NAT/QoS/容器 | ch92/P6 方法迁移 |
| 异构入门 | ZYNQ + 任一 Linux 板 | ZYNQ 做 PL 加速前端，Linux 板后端处理——跨板协作原型 | Z4/Z5 + ch80 |

## 44C.6 参数调试技巧（首日开箱期）

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 串口无输出 | 核对波特率 115200 与排针丝印 TX/RX | 换 USB-UART 接线/供电方式 | 见启动 banner 日志 |
| NVMe 不识别 | lspci 查链路是否 up | 确认 M.2 key 位型与插槽供电 | lsblk 出现 nvme0n1 |
| NPU 节点缺失 | dmesg 中 grep rknpu | 换含 RKNPU 驱动的内核分支 | /dev/rknpu 存在且版本匹配 |

## 44C.7 实测数据表（跨代性能标尺）

| 项目 | T4 (RK3399) | T6 (RK3588) | 说明 |
|------|-------------|-------------|------|
| NVMe 顺序读(Gen2×4) | ≈1.6GB/s(规格值) | Gen3×4 更高 | fio bs=1M 实测为准 |
| NPU 算力 | 无 | 3 核 6TOPS(int8) | 泰山派 0.8~1T 居中 |
| 典型负载功耗 | 数瓦量级(典型值) | 满载约 10W+(典型值) | 以整板实测为准 |
| 大小核拓扑 | 2×A72+4×A53 双簇 | 4×A76+4×A55 双簇 | lscpu -e 观察 cluster |

## 44C.8 排故速查表（新板首日）

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| SD/eMMC 启动失败 | 镜像与板型不匹配 | 核对 BSP 来源表 44C.2 再重烧 |
| WiFi 扫描为空(夸克) | XR819 固件未加载 | dmesg 查 sdio/XR819 报错 |
| JTAG 连接失败(ZYNQ) | 仿真器驱动/供电问题 | 查 Vivado hw_server 日志 |

## 44C.9 部署注意事项
1. 每块新板建立独立 git 仓库存放 dts/kernel 配置改动与验证脚本；
2. 台账记录各板 MAC 地址、串号、BSP 版本，避免多板混用出错；
3. 锁定第二供货源并保存全量可复现构建（Buildroot external tree 思想）；
4. 串口调试件(CH340)与 5V/3A 电源列为标配外设随板管理；
5. 新板先跑「首日三步」再接入项目代码，隔离硬件问题与软件问题。

> [!example]- 🧪 动手实验 L44C-1：五板首日验证流水线（40 分钟）
> **步骤**：① 按 44C.2 对每块板执行「首日验证三步」；② 记录 uname -a / lscpu / lsblk 输出截图归档；③ 五块 Linux 板统一跑一轮 cyclictest 与 iperf3 并填入跨代性能标尺表；④ 为每块板生成一张「首日验证卡」。
> **验收**：五张首日验证卡齐套，每张含系统版本、CPU 拓扑、存储清单、基准数值四要素，且任一板复烧镜像后可按卡复验通过。

## 44C.10 进阶话题
- T4 的 Armbian 主线内核 vs 厂商 4.4 内核外设差异清单是 BSP 能力的试金石（见思考题 2）；
- 异构协作原型：ZYNQ 做 PL 加速前端 + Linux 板做后端处理，打通第十三篇与第四篇；SO 系列性能方法论在各板的实跑是后续章节前置作业；
- 夸克「做减法」的产品思维可直接迁移到自研产品定义（砍掉非必需接口换取 BOM 与尺寸）。

> [!warning]- ❓ FAQ
> **Q1：预算有限只能留两块板怎么取舍？** 视方向而定：AI/视觉方向留 T6(实机化 44A/B)+泰山派(能力阶梯)；异构/底层方向留 ZYNQ7020+T4(标尺与大小核教学)。论证过程比结论重要（思考题 1）。
> **Q2：夸克为什么敢砍掉 HDMI/音频？** 它的定位是「焊进产品的 Linux 核心」而非开发盒子——目标场景不需要这些功能，减法换来 ¥50 内 BOM 与 21×51mm 尺寸。

> [!question] 📝 思考题
> 1. 如果只能保留两块板做未来一年的学习，你会留哪两块？给出选型论证。
> 2. T4 的 Armbian 主线内核与厂商 4.4 内核在哪些外设上有差异？列出清单。
> 3. 夸克砍掉 HDMI/音频的设计决策对你的产品有什么启发？

---
🏷️ #domain/soc #topic/bsp #topic/bringup | 🔗 [[ch44b-RK3588-NAS边缘服务器]] ← **本章** → [[ch45-实时性理论与调度算法]] | 📚 [[P4-MOC]]
