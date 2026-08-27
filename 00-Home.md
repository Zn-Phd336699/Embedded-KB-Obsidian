---
title: "🏠 嵌入式软件开发知识库"
tags:
  - moc
  - home
cssclasses: [wide-page]
---

# 🏠 嵌入式软件开发知识库

> [!abstract] 快速导航
> | | |
> |---|---|
> | 📖 总章节 | **133** 篇（十三篇 + 附录 A~E） |
> | 🧪 实验 | **122** 个动手实验 |
> | 🔬 排故卡片 | ~30 张原子知识卡 |
> | ⏱ 创建日期 | 2025-01-15 |

## 📚 十三篇总索引

| # | 篇章 | 核心内容 | MOC 链接 |
|---|------|----------|----------|
| P1 | 编程基础 | C/C++/汇编/链接器/MISRA/单元测试 | [[P1-MOC]] |
| P2 | 调试工具链 | GCC/GDB/OpenOCD/示波器/逻辑分析仪/频谱仪/Wireshark/perf | [[P2-MOC]] |
| P3 | 单片机开发 | Cortex-M 架构/F407 外设/DMA/低功耗/OTA/ESP32-S3 | [[P3-MOC]] |
| P4 | SoC 开发 | ARM-A 架构/RK 全系/i.MX6ULL/H3/ZYNQ7020/Buildroot/Yocto/NPU | [[P4-MOC]] |
| P5 | RTOS | FreeRTOS 源码精读/SMP/seL4/RT-Thread/Zephyr/Tracealyzer | [[P5-MOC]] |
| P6 | 嵌入式 Linux | 驱动开发/rootfs/epoll/TLS/Oops 取证/性能优化 | [[P6-MOC]] |
| P7 | Android 底层 | AOSP 编译/init/Zygote/AIDL HAL/Binder/OTA/Perfetto | [[P7-MOC]] |
| P8 | 协议开发 | UART/I2C/SPI/CAN/USB/lwIP/WiFi/BLE/LoRa/NB-IoT/PCIe/MQTT | [[P8-MOC]] |
| P9 | 综合项目集 | STM32 监测终端/ESP32 信息站/MCUboot OTA/LoRa 网关/AI 盒子/OpenWrt | [[P9-MOC]] |
| P10 | 安全测试量产 | Secure Boot/密钥管理/HIL 台架/产测工装 | [[P10-MOC]] |
| P11 | 工程算法 | 滤波七件套/卡尔曼族谱/PID 全集/LQR/SVPWM/S 曲线/CRC 族谱/FFT | [[P11-MOC]] |
| P12 | 性能工程 | USE 方法/火焰图/MCU 优化/RTOS 调优/Linux 进阶/反模式库 | [[P12-MOC]] |
| P13 | ZYNQ 异构 | PS+PL 架构/Verilog/Vivado 流程/AXI 协同/数据采集系统 | [[P13-MOC]] |

## 附录

| 编号 | 内容 | 链接 |
|------|------|------|
| A | 面试题库(五专项带答题要点) | [[A-面试题库]] |
| B | 工具命令速查卡(GCC/GDB/Linux/ESP-IDF/west) | [[B-命令速查卡]] |
| C | 芯片/模块/仪器选型对照表(含五块新板) | [[C-选型对照表]] |
| D | 术语表(按主题聚类) | [[D-术语表]] |
| E | Obsidian × LLM 知识管理工作流 | [[E-Obsidian×LLM工作流]] |

## 🔥 最近编辑

```dataview
TABLE file.mtime AS "修改时间", file.size AS "大小"
FROM ""
WHERE file.name != this.file.name
SORT file.mtime DESC
LIMIT 10
```

## 📊 学习进度总览

```dataview
TABLE length(rows) AS "章节数"
FROM ""
WHERE contains(tags, "domain") OR file.folder != ""
GROUP BY file.folder AS "目录"
SORT file.folder ASC
```

## 🏷️ 标签云

```dataview
TASK
FROM "排故卡片库"
WHERE !completed
```

---

*最后更新： 2025-01-15 | 由 OpenCode 协助生成 | [学习建议](00-学习路线图)*
