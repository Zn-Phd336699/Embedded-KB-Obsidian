---
title: "第Z4章 PS 裸机与 PS-PL 协同实战：AXI-Lite 与 DMA"
part: "[[P13-MOC]]"
chapter: "Z4"
tags:
  - domain/fpga
  - topic/dma
  - topic/axi
difficulty: 4
est_minutes: 35
prerequisites:
  - "[[chz3-Z3-PL快速入门Verilog-Vivado七步流程]]"
related:
  - "[[chz5-Z5-综合实战PS-PL数据采集系统]]"
  - "[[ch26-DMA与Cache一致性]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第Z4章 PS 裸机与 PS-PL 协同实战：AXI-Lite 与 DMA

> [!info] 导航
> ⏱ 35min | ★★★★☆ | 前置 [[chz3-Z3-PL快速入门Verilog-Vivado七步流程]] | → [[chz5-Z5-综合实战PS-PL数据采集系统]]

## 🎯 学习目标
- [ ] 使用 Vivado Create and Package IP 创建 AXI-Lite 从设备并接入 Block Design
- [ ] 在 Vitis 中编写裸机应用通过 MMIO 访问 PL 寄存器
- [ ] 说清 AXI-DMA Simple 与 Scatter-Gather 的取舍并用 ILA/Vitis 联调定位问题

## Z4.1 PS 裸机开发模型
ARM 通过 AXI 总线读写 FPGA 寄存器 = 软件控制硬件电路，这是 ZYNQ 异构开发的核心交互模式。裸机（Bare-metal）= 无操作系统直接跑 main()，是原型期最快路径：

| 层 | 内容 | 产出物 |
|----|------|--------|
| 应用层 | main.c 业务循环(读写 PL 寄存器) | ELF 可执行文件 |
| BSP 层 | 平台工程导入 XSA 自动生成：xil_io/xil_printf/GIC 驱动 + xparameters.h 地址宏 | 板级支持包 |
| 硬件层 | Vivado 导出的 XSA(Block Design+bitstream) | 硬件描述与比特流 |

工作流：Vivado 完成 PL 设计 → Export XSA → Vitis 建平台工程(BSP) → 建应用工程 → JTAG 下载调试。

## Z4.2 创建 AXI-Lite 自定义 IP（图形化流程）
```text
Tools → Create and Package New IP → Create AXI4 Peripheral
① Name: my_led_ip　② Interface: Lite(寄存器访问)　③ Data Width: 32bit
④ Template "Add registers"：添加 slv_reg0(控制) slv_reg1(状态)
⑤ 编辑 user_logic：slv_reg0[0] 控制 LED；slv_reg1 返回内部计数器值
⑥ Package IP → Re-Package IP 生成 .zip 组件
⑦ 主工程 Settings→IP→Repository 添加路径 → Block Design 添加实例
⑧ Connection Automation 连接 M_AXI_GP0；分配地址(如 0x43C00000)
⑨ Generate Output Products → Create HDL Wrapper → Generate Bitstream
```

## Z4.3 MMIO 寄存器访问：最小协同闭环
地址映射规则：基址由 Address Editor 分配并写进 `xparameters.h`，slv_regN 偏移为 N×0x04；`Xil_Out32/Xil_In32` 各触发一次 AXI-Lite 单拍写/读事务：
```c
#include "xil_io.h"
#include "xparameters.h"
#define MY_LED_BASE  XPAR_MY_LED_IP_0_S00_AXI_BASEADDR  /* 0x43C00000 */
#define MY_LED_CTRL  (MY_LED_BASE + 0x00)               /* slv_reg0 */
#define MY_LED_STAT  (MY_LED_BASE + 0x04)               /* slv_reg1 */
int main(void){
    while(1){
        Xil_Out32(MY_LED_CTRL, 1);            /* 点亮 LED——写 PL 寄存器 */
        for(volatile int i=0;i<5000000;i++);
        Xil_Out32(MY_LED_CTRL, 0);            /* 熄灭 */
        uint32_t cnt = Xil_In32(MY_LED_STAT); /* 读 PL 内部计数器 */
        xil_printf("counter=%u\r\n", cnt);    /* 打印到 UART */
        for(volatile int i=0;i<5000000;i++);
    }
}  /* ARM 写一字到 AXI 地址→总线传输→PL 寄存器变化→硬件响应：最小协同闭环 */
```

## Z4.4 AXI-DMA 数据搬运：Simple vs Scatter-Gather
| 维度 | Simple 模式 | Scatter-Gather(SG) 模式 |
|------|-------------|--------------------------|
| 编程模型 | 直写地址/长度寄存器启动一次 | 内存中 BD 描述符链，DMA 自取自续 |
| CPU 干预 | 每次传输都要设置一轮寄存器 | 一批缓冲排队后中断驱动连续搬运 |
| 适用场景 | 单块连续缓冲、低频启动、原型验证 | 多缓冲流水、零拷贝环形队列、量产 |

AXI-DMA 有 MM2S(内存→PL)与 S2MM(PL→内存 ★常用接收方向)两个通道。Simple 模式 S2MM 最小启动序列：
```text
① 写 S2MM_DMACR：复位后置 RS=1、IOC_IrqEn=1(完成中断使能)
② 写 S2MM_DA    ：目的 DDR 地址(按 cache 行对齐)
③ 写 S2MM_LENGTH：本次字节数 —— 写入即触发搬运
④ 等 S2MM_DMASR.IOC_Irq 置位 → 清标志 → 处理缓冲区数据
```

## Z4.5 GP 口 vs HP 口带宽场景（动寄存器走 GP，动数据走 HP，怕刷 cache 用 ACP）
| 口 | 位宽 | 定位 | 典型场景(典型值) |
|----|------|------|------------------|
| M_AXI_GP | 32bit | 配置面 | AXI-Lite 控制/状态轮询；批量数据仅限 KB 级调试 |
| S_AXI_HP | 64bit | 数据面 | DMA 音视频/ADC 流搬运，数百 MB/s 级吞吐 |
| S_AXI_ACP | 64bit | 一致性面 | PL 与 CPU 小块共享数据，免手动刷 cache |

## Z4.6 ILA 在线调试与 Vitis 联合调试
1. Vivado 在 AXI 互联或关键信号上插入 System ILA/ILA，设探针深度与触发条件（如握手有效）。
2. Hardware Manager 打开比特流后全速运行 + 条件触发抓波形。
3. Vitis 断点暂停 CPU，Memory 视图直看 0x43C00000 物理寄存器实时值——ILA 看「事务有没有发生」，Memory 看「值对不对」，双向印证。
4. 进阶交叉触发(cross-trigger)：ILA 与处理器断点互相同步定格软硬件现场。

## Z4.7 参数调试技巧
| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 读回数据陈旧 | 写入序列对比回读值 | DCache Flush/Invalidate 范围 | 回读与新写入一致 |
| DMA 偶发丢数据 | System ILA 抓 TLAST/握手 | FIFO 深度、burst 尺寸 | 长跑零丢失 |
| IRQ_F2P 不进 ISR | GIC 状态寄存器 + ILA 抓中断线 | 核对 ID 映射与 GIC 使能/优先级 | ISR 进入计数随事件递增 |

## Z4.8 实测数据表（典型值）
| 操作 | 耗时(典型值) | 说明 |
|------|--------------|------|
| AXI-Lite 单次写 slv_reg0 | 百 ns 量级 | 含总线往返与译码 |
| DMA 经 HP 口搬 2KB | ~12µs | Z5 实测口径，零 CPU 占用 |

## Z4.9 排故速查表
| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| MMIO 读回全 0xFFFFFFFF | AXI 互联未连接/地址未分配/bitstream 未更新 | Vivado Address Editor 核对；重新 Generate Bitstream |
| 写寄存器无效果 | IP 内部逻辑未正确响应 AXI 写事务 | System ILA 挂在 AXI 接口抓事务 |
| FSBL 后 PL 区域不可访问 | bitstream 未在 FSBL 中加载 | 检查 FSBL 是否包含 .bit 文件；核对 BOOT.BIN 组成 |
| 中断 IRQ_F2P 无响应 | GIC 未使能对应 ID/优先级被屏蔽 | 以 xparameters.h 生成的 XPAR_FABRIC_*_ID 为准查使能与优先级 |

## Z4.10 部署注意事项
1. PL 每次改动都重新导出 XSA 并让 Vitis 更新平台工程，否则地址宏与硬件脱节。
2. DMA 缓冲按 cache 行对齐并在收发两侧维护 cache（原理同 [[ch26-DMA与Cache一致性]]）。
3. Address Editor 分配避开 PS 外设区间，基址表纳入版本管理；中断号一律引用 xparameters.h 宏。
4. 先裸机打通再迁 Linux(UIO/dmaengine)，寄存器语义保持不变可平移。

> [!example]- 🧪 动手实验 LZ4-1：自定义 AXI-Lite IP 全流程（2 小时）
> **步骤**：① 按 Z4.2 创建 my_led_ip；② Block Design 例化并连 M_AXI_GP0；③ 生成 bitstream 后导出 XSA 到 Vitis；④ 编写裸机应用读写 PL 寄存器。**验收**：ARM 成功读写 PL 寄存器并控制 LED，示波器翻转周期与代码延时一致。

## Z4.11 进阶话题
- 自定义 AXI4-Full 突发主设备：PL 主动访存，摆脱 Lite 单拍限制。
- axidma 用户态库 / UIO 映射：Linux 下绕过内核拷贝的轻量方案。
- ACP 免维护共享缓冲 + System ILA 跨触发：省 cache 维护代码、关联软硬件事件。

> [!warning]- ❓ FAQ
> **Q1：为什么读回是 0xFFFFFFFF？** 该地址没有从机应答，互联以错误填充总线——先查连接与地址分配，再查 bitstream 是否最新。
> **Q2：本项目该选 Simple 还是 SG？** 原型验证用 Simple 半天就能通；连续采集多缓冲流水切 SG，CPU 只管喂 BD 和收中断。
> **Q3：裸机能直接 memcpy PL 里的 FIFO 吗？** 可以经 GP 口但单拍慢且占 CPU；大流量正确姿势是 AXI-Stream + DMA 走 HP 口。

> [!question] 📝 思考题
> 1. 若把 my_led_ip 改挂到 S_AXI_HP 上会发生什么？为什么不行？
> 2. Simple 模式连续采集时 CPU 要重复做哪些事？SG 如何减负？
> 3. 为什么 DMA 缓冲必须按 cache 行对齐？不对齐会出什么问题？

---
🏷️ #domain/fpga #topic/dma #topic/axi | 🔗 [[chz3-Z3-PL快速入门Verilog-Vivado七步流程]] ← **本章** → [[chz5-Z5-综合实战PS-PL数据采集系统]] | 📚 [[P13-MOC]]
