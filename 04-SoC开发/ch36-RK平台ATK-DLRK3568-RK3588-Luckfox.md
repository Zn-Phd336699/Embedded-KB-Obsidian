---
title: "第36章 RK 平台：ATK-DLRK3568 / RK3588 / Luckfox Pico"
part: "[[P4-MOC]]"
chapter: 36
tags:
  - domain/soc
  - topic/npu
difficulty: 3
est_minutes: 30
prerequisites:
  - "[[ch35-i-MX6U-ALPHA平台详解]]"
related:
  - "[[ch43-NPU-GPU应用开发RKNN-MPP]]"
  - "[[ch41-Buildroot定制rootfs全流程]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第36章 RK 平台：ATK-DLRK3568 / RK3588 / Luckfox Pico

> [!info] 导航
> ⏱ 30min | ★★★☆☆ | 前置 [[ch35-i-MX6U-ALPHA平台详解]] | → [[ch37-全志H3-OrangePiZero-NanoPiNEO实战]]
## 🎯 学习目标
- [ ] 说清 RK 启动链 TPL/SPL/idblock/miniloader/ATF 的角色分工与偏移布局
- [ ] 掌握 rkdeveloptool/RKDevTool 烧写流程与 Maskrom 救砖全步骤
- [ ] 会用「版本三角」排查 RKNN 推理故障并评估主线化进度

Rockchip 是国产 SoC 的开源标杆：主线内核推进积极、rknn 生态完整。本章覆盖三档硬件的开发要点。
## 36.1 三档硬件定位

| 型号 | 定位 | 关键差异 |
|------|------|----------|
| Luckfox Pico(RV1103) | ¥50 微型视觉节点 | A7+SVC(RISC-V 小核)+ISP；Buildroot 精简系统；SPI NAND 启动 |
| **ATK-DLRK3568** | 教学/量产主力 ★本篇锚点 | A55×4+NPU 0.8T+双千兆+MIPI CSI/DSI；eMMC+SD 双启 |
| ROCK 5B(RK3588S) | 高性能旗舰 | 大小核+6T NPU+PCIe3；Armbian 主线体验最佳 |
## 36.2 原理深挖：RK 启动链与 idblock 偏移

```text
BootROM → 校验 idblock → TPL(DDR init, 类似 i.MX DCD 角色但是独立固件)
        → SPL(加载下一级) → { miniloader 或直接 } → ATF(bl31) → U-Boot → Kernel
update.img = 多分区镜像集合：
  loader(TPL+SPL) · uboot.img · trust.img(ATF) · boot.img(kernel+dtb) · rootfs.img
eMMC/SD 布局(RK3568 关键偏移速记)：
  loader(idblock: TPL+SPL+usbplug) @ 64×512B 起
  uboot.img @ ~16KB · trust(ATF bl31) 紧随其后
  boot(kernel+dtb) @ 8MB · rootfs @ ~20MB（以实际 parameter.txt 为准）
idblock 头含 magic「21」与 DDR 初始化参数包 —— 角色类比 i.MX 的 DCD
rkdeveloptool 三步曲：db(下 bootloader 进 SRAM) → wl(逐分区写) → rd(reset)
Maskrom 触发条件：eMMC 无有效 loader 或按住 MASKROM 键上电
  —— 枚举为 VID_2207 PID_320B 即进入成功
```

烧写工具两套：Windows 用 RKDevTool 图形界面（Loader 模式=正常升级，Maskrom=底层救援）；Linux/macOS 用 rkdeveloptool：`db MiniLoaderAll.bin` → `wl boot.img` → `rd`。
**救砖口诀**：按住 MASKROM 键上电 → 设备枚举为 MASKROM device → 先下 loader 再刷全部。
## 36.3 专属子系统地图

| 子系统 | 功能 | 用户态入口 |
|--------|------|-----------|
| VOP2 | 显示控制器(多图层混合) | DRM/KMS：modetest -c 查看 |
| RGA | 2D 图形加速(缩放旋转合成) | librga API |
| MPP | H264/H265/JPEG 硬编解码 | librockchip_mpp / mpp_dec_test |
| RKNPU | 神经网络推理 | rknn_runtime(rknn_model_zoo 示例) |
| SARADC/IOMUX | ADC 与引脚复用 | IIO / pinctrl 子系统 |
## 36.4 关键代码：新板三分钟出图验证链

```bash
# ① NPU 驱动健康：
cat /sys/kernel/debug/rknpu/version
# ② 硬解验证(CPU 应<10%)：
ffmpeg -c:v h264_rkmpp -i test.mp4 -f null - ; echo $?
# ③ NPU 官方 demo 出框：
rknn_yolov5_demo model/yolov5s.rknn bus.jpg
# 任一步失败 → 按 36.9 排故表对应行处理，不要跳步。
```

Luckfox Pico 快览（超低成本路线）：官方 Buildroot SDK 含 IPC 例程(抓拍+RTSP)。`./build.sh lunch` 选 luckfox_pico 板型后 `./build.sh` 全量构建；SPI NAND 128MB 起步 → rootfs 用 squashfs 只读+overlay；RISC-V 小核跑 RTOS 走 rpmsg——AMP 架构练手绝佳（Buildroot 全流程见 [[ch41-Buildroot定制rootfs全流程]]）。
## 36.5 实测数据表：NPU 推理基准(rknn_model_zoo 口径+社区复测)

| 模型(int8) | RK3566/68 (0.8T) | RK3588 单核(1T) | 备注 |
|------------|-------------------|------------------|------|
| yolov5s-640 | ~28fps | ~55fps | 后处理 CPU 开销另计 |
| yolov8n-320 | ~45fps | ~90fps | P5 项目选型依据 |
| RetinaFace-320 | ~30fps | ~60fps | 人脸检测基线 |

经验：NPU 利用率上不去先查预处理——CPU resize 是隐形瓶颈（详见 [[ch43-NPU-GPU应用开发RKNN-MPP]]）。
## 36.6 RK3588(S) 深度剖析

| 维度 | RK3588(S) | RK3576 | RK3568 |
|------|-----------|--------|--------|
| CPU | **4×A76+4×A55**(DSU 大小核) | 4×A72+4×A53 | 4×A55 |
| NPU | **3 核 6TOPS** | 6TOPS(单簇) | 0.8~1T |
| 编解码 | 8K@60 解码/8K 编码, AV1 | - | 4K H265 |
| PCIe | **Gen3×4 + Combo PIPE** | Gen2 | Gen3×2+Gen2×1 |
| 内存 | LPDDR4x/LPDDR5 ×4 通道 | LPDDR4/5 | LPDDR4x |
| 典型定位 | 旗舰 AI 盒/NVR/边缘服务器 | 中端 AIoT/车舱 | 网关/轻 AI ★教学主力 |

- **三核 NPU 分配(rknn core_mask)**：单模型大 batch 用多核模式(`_0_1`/`_0_1_2` 自动拆 batch)吞吐 ↑2~2.5×；多模型并发每核绑一个模型避免调度抖动；实测三路 1080p yolov8n 各占一核 ≈每路 55fps 互不干扰。
- **大小核调度**：业务线程 `sched_setaffinity` 绑 A76(通常 cpu4-7)，系统杂务留 A55；cpufreq policy 分域，大小核调频档独立。
- **VOP4 显示管线**：4×VP+4×Esmart 图层，HDMI×2+MIPI DSI×2+eDP 并发组合——多屏广告机/会议盒子基础。
- **PCIe Gen3×4 可拆分(x4/x2/x1)**：NVMe+双千兆卡+FPGA 同时挂载的带宽分配表要在载板设计前画好（时序教训同 [[ch85-PCIe总线拓扑BAR空间lspci排障]]）。
- **内存带宽核算(LPDDR5×4≈34GB/s 峰值)**：4 路 1080p30 采集 ≈4GB/s + NPU 权重特征 ≈3GB/s + 编码读写 ≈2GB/s + 系统——利用率控制在 60% 内才稳。
- **RK3588 vs S 版**：S 砍 PCIe×4/部分 HDMI 与第二 ISP——「单摄+NPU」产品用 S 省 20%；多目/存储服务器必须满血版。
## 36.7 参数调试技巧

| 目标 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| NPU 驱动确认 | cat rknpu/version | 固件驱动版本对齐 | 版本号正常返回 |
| 硬解码生效 | ffmpeg h264_rkmpp + time | 换 rkmpp 解码器 | CPU 占用 <10% |
| 多模型并发稳态 | 每路 fps 打点 | core_mask 固定绑核 | 各路帧率无互扰 |
| 满载不过热墙 | /sys/class/thermal 采样 | 主动配 thermal zones 降频曲线 | 不触发被动卡顿 |
## 36.8 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| Maskrom 认不到设备 | USB 线只能充电/驱动未装(WinUsbFilter) | 换数据线；DriverAssistant 安装后重启 |
| 刷机后 HDMI 黑屏 | dtb 选择与实际接口不符(HDMI/MIPI) | u-boot 串口日志看加载的 dtb 名；换对应 board dtb |
| NPU 推理报 RKNN_ERR | 模型与 runtime/toolkit 版本不匹配 | 版本三角锁定：toolkit2 ↔ runtime so ↔ 固件驱动 |
| 双网口只有一个通 | dts 里 phy 地址/复位脚配置缺失 | ethtool 看 PHY link；mdio 总线扫描比对原理图 |

rknn-toolkit2 文档首页的版本三角匹配表(toolkits ↔ runtime ↔ driver)★必读。
## 36.9 部署注意事项

1. RK3588 BSP 现状：厂商 SDK(5.10/6.1 内核分支)功能完整；主线已支持 CPU/网口/eMMC 等，但 **VOP3 显示、RKISP 多摄、NPU 驱动仍依赖厂商树或 out-of-tree 补丁**；
2. 产品决策表把「哪些 IP 锁定厂商 BSP」写清楚，锁定 u-boot/kernel/deb 三者版本三角；
3. RK3568 已可纯主线启动(VPU/NPU 仍需补丁集)——先列「哪些 IP 还靠厂商树」清单再做技术路线决策；
4. 温控策略产品化：RK3588 满载必撞温度墙——主动配 thermal zones 与降频曲线，而非被动接受卡顿。

> [!example]- 🧪 动手实验 L36-1：Maskrom 救砖全流程演练（50 分钟）
> **步骤**：① 备份当前镜像；② dd 清零 loader 区前 4MB 制造砖；③ 断电按住 MASKROM 上电，lsusb 确认 VID_2207 PID_320B 枚举；④ `rkdeveloptool db MiniLoaderAll` → 逐分区 `wl` → `rd`；⑤ 验证复活并记录全程耗时与卡点。
> **验收**：变砖后 15 分钟内独立完成救援——从此面对变砖心如止水，这是 RK 平台开发的心理护城河。
## 36.10 进阶话题四则

- **主线化的真实进度**：3568 纯主线可启动但 VPU/NPU 仍需补丁集——决策前先盘点 IP 清单；
- **SVC 小核 AMP 用法**(RV1103)：RISC-V 核跑 RTOS 走 rpmsg——低成本双架构样本，OpenAMP 思想落地处；
- **VOP2 图层规划**：Cluster/Esmart 能力不同(缩放/YUV)——多路 OSD 先画图层分配图再动手；
- **Luckfox 的 Buildroot 流程**：squashfs 只读+overlay 是小容量 SPI Flash 的标准答案，通向 [[ch41-Buildroot定制rootfs全流程]]。

> [!warning]- ❓ FAQ
> **Q1：对比 i.MX 的 DCD 与 RK 的 TPL 在 DDR 初始化上的架构取舍？** DCD 由 ROM 解释，链路短但表达能力受限于命令集；TPL 是独立固件可单独替换升级、还能塞更多初始化逻辑，代价是启动链更长、多一次加载跳转。
> **Q2：为何 RK3588 的 Armbian 主线体验优于厂商 Debian？主线化的代价是什么？** Armbian 社区把通用部分(CPU/存储/网络)推到主线并持续维护；代价是厂商专属 IP(VPU/NPU/ISP)滞后或缺失——所以高性能场景仍需厂商 SDK 补丁集兜底。

> [!question] 📝 思考题
> 1. 规划一个「双目摄像头+本地检测」项目，写出它在三档硬件上的落地差异表。
> 2. idblock 头的 magic「21」损坏后，BootROM 会走到哪个分支？如何验证你的推断？
> 3. 解释为何 Maskrom 模式不受 loader 区清零影响——它的代码来自哪里？

---
🏷️ #domain/soc #topic/npu #topic/bootloader | 🔗 [[ch35-i-MX6U-ALPHA平台详解]] ← **本章** → [[ch37-全志H3-OrangePiZero-NanoPiNEO实战]] | 📚 [[P4-MOC]]
