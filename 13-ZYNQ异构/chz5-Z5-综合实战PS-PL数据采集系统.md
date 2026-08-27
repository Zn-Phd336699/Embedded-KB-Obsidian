---
title: "第Z5章 综合实战：PS+PL 数据采集系统"
part: "[[P13-MOC]]"
chapter: "Z5"
tags:
  - domain/fpga
  - topic/dma
  - topic/adc
difficulty: 5
est_minutes: 45
prerequisites:
  - "[[chz4-Z4-PS裸机与PS-PL协同AXI-Lite-DMA]]"
related:
  - "[[A-面试题库]]"
  - "[[ch27-ADC-DAC与模拟前端]]"
  - "[[ch80a-MQTT-CoAP云协议本体与实现]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第Z5章 综合实战：PS+PL 数据采集系统

> [!info] 导航
> ⏱ 45min | ★★★★★ | 前置 [[chz4-Z4-PS裸机与PS-PL协同AXI-Lite-DMA]] | → [[A-面试题库]]

## 🎯 学习目标
- [ ] 构建「PL 加速 → DMA 搬运 → ARM 消费」完整数据通路
- [ ] 设计一套 AXI-Lite 控制寄存器集并核算资源占用
- [ ] 用性能预算表对比纯软件 vs 硬件加速，跑通 G1~G4 验收门

## Z5.1 项目架构与端到端数据流
PL 实现 FIR 滤波硬件加速 → AXI-DMA 搬运到 DDR → ARM 读取打包 MQTT 上云——ZYNQ 异构架构的经典应用范式（采集前端选型回看 [[ch27-ADC-DAC与模拟前端]]）：

| 层 | 组件 | 职责 | 工具链 |
|----|------|------|--------|
| PL(FPGA) | XADC/ADC 接口 → FIR 滤波 IP → AXI-Stream FIFO | 采集原始信号→数字滤波→缓冲输出 | Vivado(HDL+Block Design) |
| DMA | AXI-DMA(S_AXI_HP0) | PL→DDR 零拷贝搬运(64bit 突发) | Vivado + Linux dma driver |
| PS(Linux) | /dev/uio 或 DMA proxy driver | 读滤波后数据→协议打包→MQTT 上云 | PetaLinux(GCC 应用) |

```text
数据面：ADC ─▶ FIR(64-tap LPF) ─AXI4-Stream─▶ AXI-DMA(S2MM) ─S_AXI_HP0─▶ DDR 环形缓冲
控制面：ARM ─M_AXI_GP0(AXI-Lite)─▶ 控制寄存器组；消费面：ARM 读缓冲 ─▶ 打包 ─▶ MQTT 上云
```

## Z5.2 AXI-Lite 控制寄存器集设计（挂在 M_AXI_GP0，偏移按 32bit 步进）
| 偏移 | 名称 | 位定义 | 属性 |
|------|------|--------|------|
| 0x00 | CTRL | bit0 START · bit1 ABORT · bit31:16 每批采样数 | RW |
| 0x04 | STATUS | bit0 BUSY · bit1 DONE(写1清) · bit2 FIFO_OVERFLOW 标志 | RO/W1C |
| 0x08 | FIR_CFG | bit0 BYPASS 直通 · bit7:4 抽取比 | RW |
| 0x0C | VERSION | 比特流版本戳；SAMPLE_CNT 已完成样本计数放 0x10 | RO |

设计守则：控制位单拍生效、状态位 W1C 防丢事件、保留位读 0；VERSION 用于联调首查——确认软件、设备树、比特流三方配套。

## Z5.3 PL 侧设计要点
```text
Block Design 关键 IP：
① XADC/ADC 接口 IP(输入级)
② FIR Compiler v9.0：导入 MATLAB fdatool 低通系数(Q15)；Data Width 16bit；
   Single Rate；输入/输出接口 AXI4-Stream
③ AXI-DMA：Simple 或 Scatter-Gather 模式；Write Channel PL→内存(★核心接收方向)
   Data Width 64bit ; Burst Size 256
④ AXI Interconnect：连 M_AXI_GP0(控制) + S_AXI_HP0(数据)
FIR 参数示例(低通截止 10kHz @ fs=100kHz)：Tap 数 64；系数量化 Q15；群延迟 32 个采样周期
```

## Z5.4 Linux 侧数据消费框架（上云栈参考 [[ch80a-MQTT-CoAP云协议本体与实现]]）
```c
/* 方案A UIO 用户态 DMA proxy(原型期推荐)：dts 绑定 uio → mmap 缓冲+寄存器 → read() 阻塞等 IRQ
   方案B 标准 dmaengine API(量产推荐)：dmaengine framework + virtqueue，或厂商 axidma 库 */
int fd_uio = open("/dev/uio0", O_RDWR);              /* 中断+寄存器区 */
int fd_mem = open("/dev/mem", O_RDWR | O_SYNC);      /* DMA 缓冲映射 */
void *dma_buf  = mmap(NULL, BUF_SZ, PROT_READ|PROT_WRITE, MAP_SHARED, fd_mem, dma_phys);
void *dma_regs = mmap(NULL, PAGE_SIZE, PROT_READ|PROT_WRITE, MAP_SHARED, fd_uio, 0);
while (running) {
    writel(dma_regs + S2MM_DMACR, ENABLE | IRQ_EN);  /* 启动接收通道 */
    uint32_t n; read(fd_uio, &n, 4);                 /* 阻塞等完成中断 */
    process_samples(dma_buf, sample_count);          /* 业务处理 */
}
```

## Z5.5 性能对比：纯软件 vs 硬件加速（实测口径）
| 环节 | 硬件通路(实测口径) | 纯软件对照(典型值) |
|------|--------------------|--------------------|
| FIR 64-tap ×1024 样本 | **~10µs（PL 并行）** | ~200µs（A9 软算），约 20× 差距 |
| 搬运 2KB 至 DDR | ~12µs(@S_AXI_HP 64bit)，零 CPU 占用 | CPU memcpy 占核且慢 |
| MQTT 打包+TLS 发送 | ~2ms(含网络 RTT)，A 核处理 | 相同——软件环节无差异 |
| 端到端延迟(采样→云端) | **≤5ms**(不含网络传播) | 数十 ms 级 |

## Z5.6 资源占用核算（典型值，以自家 Utilization 报告为准）
| 模块 | LUT | FF | DSP48E1 | BRAM36 |
|------|-----|----|---------|--------|
| FIR 64-tap(低采样率下时分复用) | ~800 | ~600 | 4~8 | 2 |
| AXI-DMA(S2MM) | ~1500 | ~1200 | 0 | 2 |
| Interconnect/转换/控制 IP | ~3000 | ~2500 | 0 | 2 |
| 合计占 xc7z020 容量 | ~10% | ~4% | <5% | ~4% |

7020 余量充足，叠加第二路采集无压力。

## Z5.7 测试矩阵与验收门
1. **G1 功能**：注入已知正弦信号，FFT 验证 FIR 截止特性正确；
2. **G2 性能**：端到端延迟 ≤5ms、吞吐 ≥50k samples/s、CPU 占用 <10%；
3. **G3 稳定**：72h 连续运行零丢样、零重启；
4. **G4 安全**：断电恢复后系统自动重连并恢复数据流。

## Z5.8 参数调试技巧
| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| FIR 输出幅度异常 | 注入满幅正弦看削顶 | Q15 系数缩放/输入位宽 | 通带增益≈理论值 |
| 吞吐不达 50k samples/s | 时间戳统计速率 | DMA burst、缓冲批大小 | 达标且 CPU<10% |
| 偶发丢样/端到端抖动大 | STATUS 溢出标志计数 / p99 打点分布 | FIFO 深度水线 / 批大小与线程优先级 | 计数停涨且 p99≤5ms |

## Z5.9 排故速查表
| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| DMA 完成中断不来 | S2MM 未使能 IOC/目的地址未对齐 | System ILA 抓握手；复查 DMACR 配置 |
| DDR 数据错乱 | cache 未维护/双缓冲指针复用冲突 | 核对 Flush/Invalidate 范围与乒乓切换时序 |
| FFT 看不到截止特性 | 系数导入格式错(Q15 缩放) | 回放已知正弦逐 tap 验证系数通路 |
| 72h 老化重启/断电后无法恢复 | 内存泄漏 BD 未回收/重连状态机缺陷 | 长跑监控 RSS 与 BD 队列深度；断网注入测重连路径 |

## Z5.10 部署注意事项
1. 比特流、设备树、应用三方版本必须配套，VERSION 寄存器作为产线自检项。
2. 量产走标准 dmaengine/厂商 axidma 库，UIO 方案仅限原型期。
3. 缓冲策略用乒乓/环形双缓冲，杜绝处理期间被新样本覆盖。
4. 72h 零丢样零重启纳入产线门槛；上云链路必须有断网重连+本地缓存兜底并配自动化测试。

> [!example]- 🧪 动手实验 LZ5-1：正弦注入验证滤波链路（40 分钟）
> **步骤**：① 注入 1kHz 与 20kHz 正弦（截止 10kHz@fs=100kHz 口径）；② 应用层对结果做 FFT；③ 测端到端打点延迟。**验收**：通带衰减 <3dB、阻带明显抑制、延迟 ≤5ms 三项同时满足。

## Z5.11 进阶话题
- 多通道扩展：每路独立 Stream+FIFO，DMA SG 分散收集汇流。
- AXI4-Stream 的 TLAST/TKEEP 语义：保证帧边界与字节有效性。
- 零拷贝环形缓冲：mmap 共享 + 头尾索引同步，彻底消除中间拷贝。
- FIR 升级多相/抽取结构降后级负载；Vivado/PetaLinux 全流程深潜见工作区《ZYNQ 教程》。

> [!warning]- ❓ FAQ
> **Q1：为什么 FIR 放在 PL 做？** 乘累加是 DSP48E1 的本职且天然并行——~10µs 对 ~200µs 约 20× 加速，还零 CPU 占用。
> **Q2：Simple 和 SG 在本项目怎么选？** 原型期 Simple 快速打通；连续采集多缓冲流水切 SG，让 CPU 只管喂描述符收中断。
> **Q3：要加第二路 SPI 加速度计，架构怎么扩？** PL 新增 SPI 主机 IP → 独立滤波支路 → 复用 DMA(SG 多 BD)或加第二台 DMA，控制面扩一组寄存器即可。

> [!question] 📝 思考题
> 1. 为什么 FIR 滤波放在 PL 做？如果改在 ARM 上做软滤波，性能差距多少倍？
> 2. AXI-DMA 的 Simple 模式和 Scatter-Gather 模式各适合什么场景？
> 3. 若在此系统上叠加第二路传感器(如 SPI 接口的加速度计)，架构需要怎么扩展？

---
🏷️ #domain/fpga #topic/dma #topic/adc | 🔗 [[chz4-Z4-PS裸机与PS-PL协同AXI-Lite-DMA]] ← **本章** → [[A-面试题库]] | 📚 [[P13-MOC]]
