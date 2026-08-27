---
title: "第19章 逻辑分析仪实战：sigrok/PulseView 协议解码与时序测量"
part: "[[P2-MOC]]"
chapter: 19
tags:
  - domain/fundamentals
  - topic/logic-analyzer
difficulty: 3
est_minutes: 40
prerequisites:
  - "[[ch18-示波器实战]]"
related:
  - "[[ch76-I2C协议与排障时钟拉伸总线锁死多主机]]"
  - "[[ch77-SPI-QSPI与Flash驱动JEDEC-XIP磨损均衡]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第19章 逻辑分析仪实战：sigrok/PulseView 协议解码与时序测量

> [!info] 导航
> ⏱ 40min | ★★★☆☆ | 前置 [[ch18-示波器实战]] | → [[ch20-频谱仪与射频排障]]

¥30 的 24MHz 逻辑分析仪（Logic Analyzer, LA）是嵌入式性价比之王：多通道并行、深存储、自动协议解码。

## 🎯 学习目标
- [ ] 完成 PulseView 配置三要素：采样率、阈值电压、触发条件
- [ ] 解码 UART/I2C/SPI 并按「病灶指纹」定位协议层错误
- [ ] 会用组合触发蹲守偶发事件，并用 sigrok-cli 挂 CI 自动化

## 19.1 与示波器的分工
| 维度 | 示波器 | 逻辑分析仪 |
|------|--------|------------|
| 看什么 | 模拟细节：幅度/边沿/噪声 | 数字语义：0/1 序列与协议内容 |
| 通道数 | 2~4 | 8~16+ |
| 存储 | 浅（M 点级） | 深（百 M 点级，长窗口） |
| 触发 | 边沿/脉宽等模拟条件 | 多通道组合模式匹配（地址+数据精确触发） |

## 19.2 两类硬件架构：fx2 vs FPGA
| 架构 | 代表 | 采样引擎 | 实际能力 |
|------|------|----------|----------|
| fx2 MCU 直传 | ¥30 兼容仪 | Cypress FX2 内 8bit 并口→USB 实时流 | 24MHz 上限、无缓存抗丢包弱 |
| FPGA+缓存 | DSLogic/Saleae | FPGA 写板载 SDRAM，USB 慢速回传 | 400M~1G 采样、复杂触发引擎、断流不丢 |

选型判据：只调 I2C/UART 用 fx2 足够；SPI>16M、CAN-FD、长窗口抓偶发必须上 FPGA 架构。LA 能做到 GB 级深存储而示波器不行的根源：1bit 量化 vs ADC 位宽，数据量差数量级。

## 19.3 快速上手五步
```text
① 硬件：fx2lafw 兼容仪(24MHz/8ch)。接线共地！阈值电压设 1.65V(TTL 3.3V 系统)
② 软件：安装 PulseView(sigrok 套件)，驱动选 fx2lafw(fx2) 或 DSLogic 原生支持
③ 配置：采样率≥总线速率×6(1Mbps UART 取 12MHz)；样本数=采样率×时长(100MSamples@12MHz≈8 秒窗口)
④ 触发："D0 falling edge" 抓起始位；复杂触发如 "CS 下降沿且 D0=1"
⑤ 分析：Add decoder→选协议→绑定通道→填参数(波特率/极性/位序)→表格视图逐条核对
```

## 19.4 三大总线解码判读
**I2C**：
```text
参数：sda/scl 通道，7bit 地址；健康链 START→ADDR+R/W→ACK(从机拉低)→DATA...→STOP
病灶：ADDR 后 NACK=地址错/器件未上电/被其他主机占用；DATA 中途 NACK=从机忙(EEPROM 写周期!)
     SCL 卡死在低=从机 clock stretch 失控→[[ch76-I2C协议与排障时钟拉伸总线锁死多主机]]九步解锁
     连续 START 重复=主机重试风暴，查上层超时参数
```
**SPI**：
```text
参数：MOSI/MISO/CLK/CS + CPOL/CPHA 模式 + 位序
高频陷阱：模式配错→数据整体移位半个 bit，解码乱码但波形看着"正常"——对照手册第一个采样时钟沿确认
Flash 利器：解码出 9F(JEDEC ID) 应答 EF4018...；读 ID 不对→查 WP#/HOLD# 电平、QPI 残留([[ch77-SPI-QSPI与Flash驱动JEDEC-XIP磨损均衡]])
```
**UART/RS485**：停止位处仍是低=framing error（波特率失配/线路噪声）；fx2 不支持数学通道，RS485 差分直接测 A/B 各一路对地肉眼合成。

## 19.5 数字域独门绝技
固件里预留 4 个 GPIO 二进制编码输出当前状态号，LA 全程录制导出 CSV 后一行画出状态迁移甘特图：
```python
import pandas as pd
df = pd.read_csv("la.csv")                       # PulseView File->Export CSV
df["state"] = df.D0 + 2 * df.D1 + 4 * df.D2 + 8 * df.D3
df.state.plot(drawstyle="steps-post")            # 整个系统行为时间线尽收眼底
```
另两招：**中断延迟精测**——CH0=外部事件引脚、CH1=ISR 入口翻转脚，光标量两沿差即中断延迟（含 NVIC 仲裁+入栈 12 周期+handler 前奏）；**DMA 节拍验证**——请求与完成引脚间隔对照预期带宽。

## 19.6 组合触发与 sigrok-cli 自动化
- **组合触发**：「CS 下降沿 且 MOSI 第一个字节==0x9F」只在 Flash 读 ID 时停下；DSLogic 支持多级状态机式触发（先见 A 再见 B 才录）。长窗口蹲守=降采样率换时长+只开必要通道+分段模式，过夜任务前先用 5 分钟试跑验证触发命中率。
- **VCD 桥接仿真世界**：Export 可存 CSV/VCD，VCD 导入 GTKWave 长时间浏览、被 Verilator 复用——同一套分析语言贯通仿真与现实；双机联测以 LA 触发输出同步示波器 Single。

```bash
sigrok-cli -d fx2 -c samplerate=1M --time 30s -P i2c:address=0x48 -o dump.sr
sigrok-cli -d fx2 -c samplerate=1M --time 2s -P uart:baudrate=115200
```

## 19.7 参数调试技巧
| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 解码全是乱码 | 先看原始波形翻转是否干净 | 阈值电压/波特率/共地 | 游标量位宽反推波特率后解码可读 |
| 高速 SPI 采不到 | 核对仪器采样率上限 | 升 DSLogic(400M)/Saleae 或降 SCLK 调试 | 解码无丢帧 |
| 长窗口数据丢失 | 检查 USB 带宽丢流 | 降采样率；关多余通道；走内置缓存 | 样本数完整无断流 |

## 19.8 实测参考数据表
| 场景 | 指标 A | 指标 B |
|------|--------|--------|
| fx2 兼容仪 | 24MHz / 8ch 上限 | USB 直传无大缓存 |
| FPGA 架构（DSLogic） | 400M~1G 采样 | 板载 SDRAM 断流不丢 |
| LM75 写周期（案例器件） | tWC≈1ms | SMBus 要求 tBUSFREE≥4.7µs |
| 阈值电压科学 | 3.3V 系统 VIH≈2.0V/VIL≈0.8V | 取中点 1.4V 边沿抖动时误判率更低 |

## 19.9 排故速查表
| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 解码全是乱码 | 阈值电压错/波特率估错/共地缺失 | 先看原始波形；游标量位宽反推波特率 |
| 高速 SPI 采不到 | 超出 fx2 的 24MHz 极限 | 升 DSLogic/Saleae；或降 SCLK 调试 |
| 长窗口数据丢失 | USB 带宽不足丢流 | 降采样率；关多余通道；用内置缓存机型 |
| 通道间偏斜明显 | 杜邦线长短不一引入纳秒级歪斜 | 等长走线；关键测量用同轴探针 |

## 19.10 部署注意事项
1. 接线第一铁律：共地；阈值按电平体系中点设置而非想当然的 1.65V。
2. 采样率 ≥ 总线速率 ×6 起步，样本数按预计时长预算好再开录。
3. 过夜蹲守前必须短时试跑验证触发命中，避免白守一晚。
4. 采集归档 .sr/CSV/VCD 三格式之一保持管线可复现；LA 触发输出同步示波器做混合联测。

## 19.11 完整案例：I2C 读温感全程侦破
```text
背景：主机读 LM75 偶发读到 0xFFFF。
① @2MHz 采 SCL/SDA 各 5 秒，Add Decoder→I2C；表格视图过滤 NACK：发现「写指针寄存器」后偶发 NACK
② 展开该事务逐位看：STOP 后仅 0.4µs 就 START 下一次——手册要求写后 tBUSFREE≥4.7µs(SMBus)/该器件需 1ms 写周期！
③ 根因：驱动连发两条事务未等待器件内部写完成
④ 修复：写后 ack-polling 循环(地址 ACK 即就绪)——复测 10 万次零错
方法论沉淀：协议分析仪的价值在「把时序违规变成可见的帧级证据」。
```

> [!example]- 🧪 动手实验 L19-1：复刻完整侦破流程（50 分钟）
> **步骤**：① 用你的板子对 EEPROM(24C02) 连续快速写读制造 NACK；② 采集并解码定位违规间隙；③ 对照 datasheet 的 tWC 参数量化违规量；④ 加 ack-polling 后复测 10 万次；⑤ 导出前后两份 .sr 存档对比。
> **验收**：实验笔记含「参数表摘录+实测值+结论」三段式——这就是标准排障报告的雏形。

## 19.12 进阶话题
- **状态号 GPIO 法回归基线**：给 FSM 固件建立行为基线，改版前后 diff 状态迁移图。
- **自定义 decoder**：sigrok Wiki 的 Decoder 开发教程是私有二进制协议解析器入门路径。
- **廉价仪器原理**：读 Cypress FX2 TRM 理解 fx2 数据通路；DSView 源码 trigger engine 文档理解 FPGA 触发引擎。

> [!warning]- ❓ FAQ
> **Q1：为什么 LA 能 GB 级深存储而示波器不行？** LA 每样点仅 1bit，示波器要存 ADC 全位宽波形，同容量下记录长度差数量级。
> **Q2：fx2 能测 RS485 差分吗？** 不支持数学通道，只能 A/B 各挂一路对地测量后人工合成；严谨场景上 DSLogic 或示波器差分探头。

> [!question] 📝 思考题
> 1. 设计「I2C 从机地址扫描」的 LA 触发方案：只在 ADDR=NACK 时停下来人工分析。
> 2. 为什么逻辑分析仪可以做到 GB 级深存储而示波器不行？（提示：ADC 位宽 vs 1bit 量化）
> 3. 用状态号 GPIO 法给 FSM 模块建立完整的行为回归基线并设计 diff 判据。

---
🏷️ #domain/fundamentals #topic/logic-analyzer | 🔗 [[ch18-示波器实战]] ← **本章** → [[ch20-频谱仪与射频排障]] | 📚 [[P2-MOC]]
