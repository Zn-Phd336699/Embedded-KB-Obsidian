---
title: "附录C 选型对照表"
tags:
  - topic/hardware
  - topic/selection
description: "芯片/模块/仪器/存储/开发板选型快查：MCU、无线模块、仪器预算方案、存储介质与 Linux SoC 板卡大对照"
created: 2025-01-15
---
# 附录C · 芯片 / 模块 / 仪器 / 开发板选型对照表

> 2026 视角的常用货盘点。价格档位为大致区间（典型值），采购前以立创商城/官方渠道现价为准；选型方法论见 [[ch34-ARM-A架构与国产SoC选型地图]] 与 [[ch74-总线与无线选型总表]]。

## MCU 快选表

| 型号 | 内核/主频 | RAM/Flash | 亮点 | 参考价 |
|------|-----------|-----------|------|--------|
| STM32F103C8T6 | M3@72M | 20K/64K | 教程之王（蓝 pill） | ¥6 |
| STM32F407ZGT6 | M4F@168M | 192K/1M | 本库锚点，外设全 | ¥28 |
| STM32H743 | M7@480M | 1M/2M | 双精度 FPU + 大 Cache | ¥45 |
| GD32F470 | M4@240M | 512K/2M | F407 平替，性价比高 | ¥15 |
| CH32V003 | RV32EC@48M | 2K/16K | RISC-V 入门神器 | ¥1.5 |
| nRF52840 | M4F@64M | 256K/1M | BLE 标杆 + USB | ¥25 |
| ESP32-S3 | LX7×2@240M | 512K(+PSRAM)/16M Flash | WiFi/BLE/AI 指令集 | ¥18 |
| RP2040/RP2350 | M0+/M33 双核 | 264K/520K | PIO 可编程 IO | ¥8/¥15 |

### MCU 场景速查

| 需求场景 | 首选 | 理由 |
|----------|------|------|
| 入门学习 | STM32F103C8T6 | 教程密度最高，试错成本最低 |
| 全外设练手/本库配套 | STM32F407ZGT6 | 本库锚点平台，外设覆盖全 |
| F407 缺货降本 | GD32F470 | 国产平替，主频更高价格近半 |
| 高算力+大 Cache | STM32H743 | 480M 主频 + 双精度 FPU，图形/DSP 场景 |
| 极限成本 RISC-V | CH32V003 | 一块五毛钱跑起来再说 |
| BLE 专项产品 | nRF52840 | 协议栈成熟度标杆，自带 USB |
| WiFi/BLE 一体 + AI | ESP32-S3 | 无线全家桶 + 向量指令集 |
| 可定制外设逻辑 | RP2040/RP2350 | PIO 解决「外设不够怪」的问题 |

## 无线模块快选表

| 模块 | 协议 | 要点 | 参考价 |
|------|------|------|--------|
| ESP32-C3-WROOM-02 | WiFi4+BLE5 | RISC-V 核，性价比王 | ¥9 |
| AP6212/AP6256 | WiFi+BT combo | Linux SDIO 常客 | ¥20/¥35 |
| SX1268+SMA | LoRa CN470 | +22dBm，配 STM32 或 ESP32 主控 | ¥25 |
| SX1302 半卡 | LoRaWAN 8 通道网关基带 | 自建 NS（ChirpStack）必备 | ¥260 |
| EC800M-CN | Cat.1 | 移远经典，OpenCPU 可跑业务 | ¥28 |
| BC26/BC28 | NB-IoT | 超低功耗表计类 | ¥18 |
| CYW43439(Waveshare) | WiFi6+BLE5 | RP2040/2350 官配无线 | ¥30 |

协议层深度对照与共存排障：[[ch81-WiFi协议栈实战wpa_supplicant-hostapd]] · [[ch82-BLE开发GATT设计BlueZ-DFU]] · [[ch83-LoRaWAN组网LoRaMac-node-ChirpStack]] · [[ch84-NB-IoT-Cat1蜂窝IoT-AT指令PPP组网]]

### 无线场景速查

| 需求场景 | 首选 | 理由 |
|----------|------|------|
| 性价比联网单品 | ESP32-C3-WROOM-02 | 一颗芯片同时解决 WiFi+BLE |
| Linux 板载无线 | AP6212/AP6256 | SDIO 接口驱动生态成熟 |
| 自建 LoRaWAN 网关 | SX1302 半卡 | 8 通道基带是 NS 的硬件门槛 |
| 远距离电池节点 | SX1268+SMA | +22dBm 配 CN470 频段 |
| 蜂窝实时上报 | EC800M-CN | Cat.1 资费/时延均衡，可 OpenCPU |
| 表计级超低功耗 | BC26/BC28 | NB-IoT PSM 休眠电流微安级 |

## 仪器预算方案表

| 预算档 | 配置 | 能干什么 |
|--------|------|----------|
| ¥100 入门 | 24M 逻辑分析仪 + 万用表 | I2C/SPI/UART 解码排障；电压电流粗测 |
| ¥600 进阶 ★推荐 | 入门四通道示波器(FNIRSI/OWON) + TinySA | 时序测量/电源纹波/频段占用扫描 |
| ¥2000 标准 | DS1054Z(软解100M) + NanoVNA-F + DSLogic Plus | 完整第二篇全部实验无妥协 |
| ¥5000+ 专业 | 100M+ 四通道(Siglent SDS1104X-E) + Joulescope JS220 | 功耗能量分析/EMI 预兼容更从容 |

仪器实操入口：[[ch18-示波器实战]] · [[ch19-逻辑分析仪与sigrok]] · [[ch20-频谱仪与射频排障]]

## 存储介质对照

| 介质 | 擦写寿命 | 掉电安全 | 典型用途 |
|------|----------|----------|----------|
| FRAM(FM25V05) | 10^13 次 | 即时落盘 | 高频计数器/黑匣子 ★贵而值 |
| NOR W25Q128 | 10 万次/扇区 | 需文件系统保障 | 固件/参数/字体（XIP 友好） |
| eMMC 8GB+ | P/E 千~万级 | 日志型文件系统保障 | Linux rootfs+数据 |
| SD 卡 | 看品控波动大 | 无保障 | 日志导出/媒体缓存 |
| EEPROM 24C02 | 100 万次 | 页写保护设计 | 小参数传统方案 |

磨损均衡与 Flash 驱动细节：[[ch77-SPI-QSPI与Flash驱动JEDEC-XIP磨损均衡]] · 只读 rootfs 与 overlayfs：[[ch57-根文件系统构建只读overlayfs]]

## Linux / SoC 开发板快选表

| 板卡 | SoC/算力 | 内存 | 软件支持 | 定位 |
|------|----------|------|----------|------|
| ZYNQ7020 领航者 | XC7Z020 双核 A9+PL | 1GB DDR3 | Vivado/PetaLinux 2020.2 | 异构入门 ★第十三篇 |
| NanoPC-T6 RK3588 | 4×A76+4×A55 | 16GB LPDDR5 | FriendlyELEC/Armbian | 旗舰 AI 盒/NAS ★44A/B |
| NanoPC-T4 RK3399 | 2×A72+4×A53 | 4GB LPDDR4 | FriendlyELEC/Armbian | 大小核实验台 |
| 泰山派 RK3566 | 4×A55@1.8G | 2-8GB LPDDR4 | LCKFB Buildroot/Debian | P5 换板/RK 入门 |
| 夸克 Quark(H3) | 4×A7@1.2G | 256-512MB DDR3 | Seeed Wiki/Buildroot | 极简 IoT 节点/ch37 联动 |

平台详解与启动链：[[ch35-i-MX6U-ALPHA平台详解]] · [[ch36-RK平台ATK-DLRK3568-RK3588-Luckfox]] · [[ch37-全志H3-OrangePiZero-NanoPiNEO实战]] · [[ch38-SoC启动链深度剖析]] · [[chz2-Z2-ZYNQ7020架构全景]]

## 选型决策速判原则

1. **先定生态再定型号**：教程密度（学习期）vs 供货周期（量产期）权重不同——学习用 F103/F407，量产评估 GD32 国产平替
2. **资源预算倒推**：带宽/RAM/功耗预算画完数据流框图后再看芯片参数，而不是反着来
3. **无线选型三问**：数据量多大（速率）？电池多大（功耗）？资费敏感吗（蜂窝 vs 免费频段）？
4. **仪器投资优先级**：逻辑分析仪 → 示波器 → 频谱仪，按排障频率递增投入
5. **存储按「掉电安全 × 擦写寿命」二维矩阵**选：高频落盘选 FRAM，固件选 NOR，系统盘选 eMMC+日志文件系统

---
🏷️ #appendix #reference | 📚 [[附录-MOC]]
