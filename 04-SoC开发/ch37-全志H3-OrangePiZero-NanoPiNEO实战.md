---
title: "第37章 全志 H3：Orange Pi Zero / NanoPi NEO 实战"
part: "[[P4-MOC]]"
chapter: 37
tags:
  - domain/soc
  - topic/gpio
difficulty: 3
est_minutes: 28
prerequisites:
  - "[[ch36-RK平台ATK-DLRK3568-RK3588-Luckfox]]"
related:
  - "[[ch38-SoC启动链深度剖析]]"
  - "[[ch60-子系统驱动GPIO-input-IIO-RTC-WDT]]"
  - "[[ch92-P6-OpenWrt定制路由器全志H3]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第37章 全志 H3：Orange Pi Zero / NanoPi NEO 实战

> [!info] 导航
> ⏱ 28min | ★★★☆☆ | 前置 [[ch36-RK平台ATK-DLRK3568-RK3588-Luckfox]] | → [[ch38-SoC启动链深度剖析]]
## 🎯 学习目标
- [ ] 说清 H3 启动链 BROM→SPL→U-Boot→主线内核的最短路径与 eGON 头偏移
- [ ] 用 sunxi-fel 完成 FEL 免卡刷 RAM 引导与内存读写
- [ ] 用 Armbian build 框架定制自己的镜像并套用 dtbo overlay
- [ ] 用 libgpiod 三种方法操作 GPIO 并换算引脚编号

¥60 的小板跑完整主线 Debian——H3 是「把玩 Linux 系统本身」的最佳沙盒。
## 37.1 平台与启动链

```text
H3： 4×Cortex-A7@1.2GHz + Mali450(弃用) + 百兆 MAC
启动： BROM(SD 卡偏移 8KB 找 SPL 签名头 eGON) → sunxi SPL(初始化 DRAM)
      → U-Boot → boot.scr(uEnv.txt 可编辑!) → 主线 zImage+sun8i-h3-orangepi-zero.dtb
特色： 无 ATF 也能跑（bl31 可选），社区主线支持五星 —— mainline u-boot/kernel 直接可用
烧写： dd if=Armbian.img of=/dev/sdX bs=4M conv=fsync ；Windows 用 Rufus
      eMMC/SPIFlash 版本另有 sunxi-fel(USB FEL 模式免卡刷) 工具链
```
## 37.2 原理深挖：sunxi 家族的 FEL 模式（免卡刷开发）

```bash
sunxi-fel list                              # 枚举 FEL 设备
sunxi-fel uboot u-boot-sunxi-with-spl.bin   # 直接 RAM 引导 U-Boot
sunxi-fel write 0x43000000 file             # 任意内存读写 —— 砖头救活/裸机实验
sunxi-fel ver                               # 读芯片信息确认 SoC 活性
sunxi-fel spiflash-write                    # 直刷 SPI Flash(NanoPi NEO2 Black 等)
```

FEL = BROM 内置的 USB 恢复协议（OTG 口），连 SD 卡都不需要。价值：板级 Bring-up 阶段「不依赖任何存储介质」验证 SoC 活性，也是全志平台产线烧录的底层通道。
## 37.3 Armbian 定制构建

```bash
git clone https://github.com/armbian/build && cd build
./compile.sh build BOARD=orangepizero BRANCH=current RELEASE=bookworm BUILD_MINIMAL=yes
# 产物在 output/images/
./compile.sh kernel-config BOARD=orangepizero BRANCH=current   # menuconfig 改内核配置
# overlay 应用：/boot/armbianEnv.txt 加 overlays=uart1 spi-spidev can-waveshare...
# 用户补丁放 userpatches/ 目录自动套用 —— 二次开发的标准姿势
```

armbianEnv overlays 机制与 [[ch40-内核适配与设备树dts语法-pinctrl-overlay]] 的 dtbo 完全同构，学会一处等于学会两处。
## 37.4 板上 IO 操作三法

```bash
# 法1 libgpiod（现代标准，替代已废弃的 sysfs）
gpioset gpiochip0 17=1 ; gpioget gpiochip0 16
gpiomon --rising-edge gpiochip0 5    # 命令行等中断，脚本利器
# 法2 /sys/class/gpio 遗留接口（老教程大量使用，认识即可）
echo 17 > /sys/class/gpio/export ; echo out > .../gpio17/direction
# 法3 C 库：
#   struct gpiod_chip *c = gpiod_chip_open_by_name("gpiochip0");
#   gpiod_line_request_output(line, "led", 0);
```

编号换算公式：引脚名 PA10 → linux 编号 = (组字母-'A')×32 + 组内号 → PA10=10。Orange Pi Zero 26pin 排针的 GPIO 映射查官方 wiki 表；libgpiod 工程化用法在 [[ch60-子系统驱动GPIO-input-IIO-RTC-WDT]] 复用展开。
## 37.5 典型玩法：百元软路由

```text
OpenWrt for H3：官方 snapshot 有 sunxi/cortexa7 目标
USB 百兆网卡(AX88772) 做 WAN → LAN 口桥接 WiFi(ap6212 或外置)
性能预期：NAT 转发 ~90Mbps(HW flowtable 可再提升)
```

OpenWrt 定制、QoS 与插件开发的完整实战见 [[ch92-P6-OpenWrt定制路由器全志H3]]——本章只负责把板子跑起来。
## 37.6 实测数据表：H3 小板的真实性能水位

| 指标 | 实测值(Orange Pi Zero) |
|------|------------------------|
| 百兆 NAT 转发 | ~90Mbps(iperf 单流)；HW flowtable 后 ~140Mbps(需双百兆口) |
| SquashFS 冷启动到登录 | Armbian ~11s / OpenWrt ~6s |
| 1GB DDR3 可用内存 | ~780MB(默认内核+u-boot 占用后) |
| 持续负载温度(无壳) | 4 核满载 ~78°C → 触发 912MHz 温控墙 |
## 37.7 参数调试技巧

| 目标 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 外设 overlay 生效 | ls /sys/class/gpio*；dmesg | armbianEnv.txt 的 overlays= 行 | 新 uart/spi 节点出现 |
| 频率温度联动观察 | armbianmonitor -m | 散热措施/温控曲线 | 满载频率不跌到 480MHz |
| FEL 活性验证 | lsusb + sunxi-fel ver | 按 FEL 键(或短接)上电 | 枚举出 Allwinner 设备 |
| 按键边沿捕获 | gpiomon --rising-edge | 上拉配置/去抖参数 | 单次按压仅一条事件 |
## 37.8 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| SD 卡不启动 | 卡兼容性(H3 对 UHS-I 挑剔)/写坏偏移 8KB 头 | 换 Class10 老卡或三星白卡；dd 后 sync 并校验 md5 |
| 串口乱码 | 波特率 115200 但电平 3.3V 接错 TX/RX | 交叉接线核对；GND 共地；CH340 驱动版本 |
| WiFi 固件缺失 | minimal 镜像未含 firmware 包 | apt install firmware-brcm80211 / xradio-wlan(H3 XR819) |
| 过热降频卡顿 | 无散热壳环境温度高 | armbianmonitor -m 看频率与温度联动；加散热片 |
## 37.9 部署注意事项

1. BUILD_MINIMAL=yes 的镜像不带 WiFi 固件包——联网需求请选标准镜像或手动补固件；
2. XR819 WiFi 高负载吞吐抖动大——严肃网关项目换 USB 网卡或 MT7601；
3. H3 的 CPU Hotplug erratum 导致核 3 无法热插拔——压测脚本避开 online/offline 操作；
4. 同是 H3 不同厂板 DDR 参数不同——换板不启动先怀疑 SPL 的 DRAM 配置而非软件栈；
5. arisc coprocessor(内置 OpenRISC 小核)管电源/时钟，主线通过 SCPI 协议对话——改 DVFS 表时别把它当黑盒。

> [!example]- 🧪 动手实验 L37-1：FEL 免卡刷点亮 U-Boot（40 分钟）
> **步骤**：① 安装 sunxi-tools 包（或自编译 u-boot/tools 下的 fel）；② 按住 FEL 键(或短接)上电，`lsusb` 确认 Allwinner 设备；③ `sunxi-fel ver` 读芯片信息；④ `sunxi-fel uboot u-boot-sunxi-with-spl.bin` RAM 引导进串口交互；⑤ 记录与传统 SD 卡启动的差异。
> **验收**：不插 SD 卡进入 U-Boot 命令行并能 `bdinfo` 输出版本信息——理解「BROM→SRAM」这条最小生命线，所有 SoC 的第一口气都是这么喘的。
## 37.10 进阶话题四则

- **H3 的 CPU Hotplug 缺陷**：erratum 导致核 3 无法热插拔，cpufreq 压测绕过 online/offline 即可；
- **XR819 WiFi 的软肋**：xradio 驱动高负载吞吐抖动大，严肃项目直接换硬件方案；
- **arisc coprocessor**：OpenRISC 小核经 SCPI 协议管电源/时钟，DVFS 调参前先理解它的角色；
- **DRAM 参数的板级差异**：换板不启动的第一嫌疑人是 SPL 的 DRAM 配置，其次才是软件栈。

> [!warning]- ❓ FAQ
> **Q1：eGON 头为什么要求 SPL 位于 SD 卡 8KB 偏移？** 这是 BROM 固化的扫描约定：ROM 上电后固定从 SD 卡 8KB 处找 eGON 签名头开始加载——偏移写错则 ROM 找不到有效头，直接落入 FEL 模式等待救援。
> **Q2：Armbian userpatches 与 Buildroot external layer 两种定制哲学怎么选？** userpatches 是「覆盖式补丁」：上手快、跟随上游更新，适合个人与原型；external layer 是「增量式扩展」：边界清晰可版本化管理，适合团队与量产——前者快后者稳。

> [!question] 📝 思考题
> 1. 用 gpiomon 实现「按键长按关机」脚本，并讨论按键抖动的处理策略。
> 2. 对比 Armbian userpatches 与 Buildroot external layer 的定制哲学与适用规模。
> 3. H3 无 ATF 也能跑完整 Linux，那 bl31 在哪些场景下才成为必需？

---
🏷️ #domain/soc #topic/gpio #topic/openwrt | 🔗 [[ch36-RK平台ATK-DLRK3568-RK3588-Luckfox]] ← **本章** → [[ch38-SoC启动链深度剖析]] | 📚 [[P4-MOC]]
