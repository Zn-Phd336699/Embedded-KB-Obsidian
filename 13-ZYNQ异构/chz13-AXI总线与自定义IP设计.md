---
title: "AXI总线与自定义IP设计"
date: 2025-09-09
category: "ZYNQ异构"
tags: ["ZYNQ", "AXI", "自定义IP", "PS-PL协同"]
description: "AXI总线协议详解、AXI-Lite/AXI-Full/AXI-Stream、自定义IP封装、PS+PL协同设计综合实验"
---

# AXI总线与自定义IP设计

> AXI总线协议详解、AXI-Lite/AXI-Full/AXI-Stream、自定义IP封装、PS+PL协同设计综合实验

## 目录

1. [[#AXI 总线与自定义 IP 设计|AXI 总线与自定义 IP 设计]]
2. [[#PS+PL 协同设计综合实验|PS+PL 协同设计综合实验]]

---

## 第9章 AXI 总线与自定义 IP 设计
这是全课程**最重要的一章**：学会把任意逻辑包装成 CPU 可访问的寄存器 —— 软 PLC 的 PL 侧 IO 引擎就是它的放大版。

**🎯 学习目标**
- 理解 AXI 握手机制与三种形态的工程取舍
- 用模板法开发一个 AXI4-Lite 自定义 IP（LED 控制器）并集成测试
- 掌握地址分配、IP 升级、软件侧寄存器读写的完整闭环

### 9.1 AXI 握手：五通道与 VALID/READY
AXI4 是 AMBA 家族的存储映射总线。一次写事务涉及三组通道（地址、写数据、写响应），读事务两组（地址、读数据）。所有通道靠 **VALID/READY 双向握手**同步：发送方拉 VALID 表示数据有效，接收方拉 READY 表示可接收，两者同时为高时传输完成。

| 形态 | 突发 | 典型场景 | 复杂度 

| AXI4-Lite | 否，单拍 | 寄存器配置/状态读取 | ★ 本章主角 

| AXI4 (Full) | 是，1~256 拍 | 大块内存搬运（配 DMA） | ★★★ 

| AXI4-Stream | 无地址概念 | 流式数据（视频/AD采样） | ★★ 

💡 新手只需记住
AXI4-Lite 下，**CPU 的一次 32 位寄存器写 = 总线上一个地址通道包 + 一个写数据包 + 一个响应包**。你的 IP 只需要像填表格一样实现「收到地址→给出数据」「收到数据→存进对应寄存器」，模板已经把协议细节全部封装好了。

### 9.2 生成 AXI4-Lite IP 模板

- 菜单 **Tools → Create and Package New IP → Create AXI4 peripheral**。
- 命名：`led_ctrl`；接口类型 **AXI4-Lite (Lite)**，Slave only，数据 32 位，寄存器数量 **4**。
- 选择 *Edit IP*（生成可编辑工程）而非仅打包。

生成的工程中，`led_ctrl.sv/v` 顶部是标准 AXI 从机状态机（**不要动**），用户逻辑集中在两处：寄存器写解码（`slv_reg0..3`）与读多路选择（`reg_data_out` case）。

### 9.3 定义寄存器映射（先文档后代码）

| 偏移 | 名称 | 方向 | 位定义 

| 0x00 | CTRL | R/W | bit0=使能，bit1=模式(0流水/1呼吸)，bit2=软件复位 

| 0x04 | SPEED | R/W | 呼吸/流水速度分频系数（默认 12500_000） 

| 0x08 | STATUS | R | bit0=IP运行标志 

| 0x0C | VERSION | R | 固定 0x2020_0901，软件用于探测 IP 存在 

⚠️ 寄存器映射是「软硬件合同」
这张表一旦定稿，PL 与软件并行开发都依赖它。工业项目里请把它写进接口文档并加版本号 —— 第27章 PLC IO 引擎的寄存器表就是本章方法的直接放大。

### 9.4 用户逻辑实现（核心代码）
```
/* ---------- 在 led_ctrl.v 的架构体中追加 ---------- */
// 1) 把模板生成的 slv_reg 接到用户逻辑
wire        en    = slv_reg0[0];
wire        mode  = slv_reg0[1];
wire        sw_rst = slv_reg0[2];
wire [31:0] speed = slv_reg1;

// 2) 节拍发生器：speed 个周期产生一个 tick
reg [31:0] div_cnt;
reg        tick;
always @(posedge s_axi_aclk or negedge s_axi_aresetn) begin
    if (!s_axi_aresetn) begin
        div_cnt <= 32'd0; tick <= 1'b0;
    end else if (sw_rst) begin
        div_cnt <= 32'd0; tick <= 1'b0;
    end else if (div_cnt >= speed - 1'b1) begin
        div_cnt <= 32'd0; tick <= 1'b1;      // 单周期脉冲
    end else begin
        div_cnt <= div_cnt + 1'b1; tick <= 1'b0;
    end
end

// 3) PWM/流水输出（对外端口 led_o[3:0] 需自行添加到端口列表）
reg [3:0]  led_r;
reg [15:0] pwm_cnt;                            // 呼吸模式：三角波调占空比
reg        pwm_dir;
always @(posedge s_axi_aclk or negedge s_axi_aresetn) begin
    if (!s_axi_aresetn)
        led_r <= 4'b0001;
    else if (sw_rst)
        led_r <= 4'b0001;
    else if (tick & ~mode)
        led_r <= {led_r[2:0], led_r[3]};       // 流水
    else if (tick & mode) begin
        pwm_cnt = pwm_dir ? pwm_cnt - 1'b1 : pwm_cnt + 1'b1;
        if (pwm_cnt == 16'd999)  pwm_dir <= 1'b1;
        if (pwm_cnt == 16'd0)    pwm_dir <= 1'b0;
        led_r   <= (pwm_cnt > 8'd500) ? 4'b1111 : 4'b0000;  // 简化呼吸
    end
end

// 4) 只读 STATUS/VERSION：在读多路 case 中补两个分支
//    3'h2 : reg_data_out = {31'd0, en};        // 0x08 STATUS
//    3'h3 : reg_data_out = 32'h20200901;       // 0x0C VERSION
```

### 9.5 打包与集成

- **Review and Package IP** 页签 → Merge changes → **Re-Package IP**（生成 zip 到 IP 仓库目录）。
- 回到 BD 工程：Settings → IP → Repository 添加仓库路径；+ 添加 `led_ctrl_v1.0`。
- 点击 **Run Connection Automation**：勾选 led_ctrl 的 S_AXI，Vivado 自动插入 **SmartConnect** 并连到 ZYNQ 的 `M_AXI_GP0`。
- **Address Editor** 确认分配：`led_ctrl_0/s_axi/Reg` 落在 `0x43C0_0000` 段（记下你的实际值！）。
- Validate → Generate Output Products → Export Hardware（**含 bitstream**）。

### 9.6 软件侧测试（Vitis 裸机）
```
#include <xparameters.h>
#include <xil_io.h>
#include <xil_printf.h>
#include <sleep.h>

#define IP_BASE  XPAR_LED_CTRL_0_S0_AXI_BASEADDR   /* 自动生成，勿手抄 */

int main(void)
{
    xil_printf("version = 0x%08x\r\n", Xil_In32(IP_BASE + 0x0C));
    if (Xil_In32(IP_BASE + 0x0C) != 0x20200901) {
        xil_printf("IP not found!\r\n"); return -1;
    }
    Xil_Out32(IP_BASE + 0x04, 62500000 / 8);       /* SPEED */
    Xil_Out32(IP_BASE + 0x00, 0x1);                /* 使能·流水模式 */
    sleep(3);
    Xil_Out32(IP_BASE + 0x00, 0x3);                /* 切呼吸模式 */
    while (1) {
        xil_printf("status=%d\r\n", Xil_In32(IP_BASE + 0x08));
        sleep(1);
    }
}
```
上板验证：串口应打印 version 与 status=1，LED 先流水后呼吸；在调试模式下修改 `slv_reg1`（Memory 窗口直写 IP_BASE+4），速度立即变化 —— **CPU 与 FPGA 逻辑实时握手成功**。

### 9.7 对照组：AXI GPIO IP
同样的需求也可以用现成 AXI GPIO：BD 中添加 `AXI GPIO`，双通道配置（CH1 输出 LED、CH2 输入按键），勾选中断。软件用 `xgpio.h` 或直接 `Xil_In32(XPAR_AXI_GPIO_0_BASEADDR)`。对比结论：**简单 IO 用现成 IP，带时序逻辑/协议的用自定义 IP**。PLC 篇两者都会用到（AXI GPIO 做 DO，自定义 IP 做 DI 滤波与 PWM）。

### 常见问题 FAQ（避坑指南）
Q1：软件读 IP 寄存器全是 0 或总线挂死？① 地址没分配（Address Editor 显示 Unassigned）——读写会落到空地址；② 基地址抄错（必须用 xparameters.h 宏）；③ IP 的 ACLK 没接时钟（SmartConnect 自动接，手工连线时常见遗漏）；④ bitstream 是旧的（改了 PL 忘了重新下载）。

Q2：修改了 IP 源码，BD 里没变化？IP 是「打包-引用」模型：改源码后必须重新 Re-Package，然后在 BD 里右键 IP → **Upgrade IP**（或 Report IP Status），再重新生成输出与比特流。建议 IP 仓库用 Git 管理，每次 Re-Package 打 tag。

Q3：什么时候需要 SmartConnect 而不是 AXI Interconnect？2020.2 中 SmartConnect 是推荐的新互联（自动优化、支持更多主从），AXI Interconnect 是老核。两者对 AXI4-Lite 单从机场景无差别，Vivado 自动化默认插 SmartConnect 即可。

Q4：一个 IP 能挂多个寄存器页吗？地址怎么扩？AXI4-Lite 地址位宽可到 40 位，模板默认按 4×32bit 生成；在打包向导里把 Number of Registers 调大（如 256），或自己解码高位地址。注意 M_AXI_GP 窗口总大小 1GB，足够任何 IO 引擎。

**🧪 动手实验 L9-1：输入回读 IP**
给 led_ctrl 增加：① 端口 `key_i[3:0]`（连到板卡按键，经消抖）；② 只读寄存器 0x10 KEYSTAT 实时反映按键电平；③ 寄存器 0x14 KEYCNT 记录按键按下次数累计。软件侧轮询打印。完成后你将拥有一套「CPU↔PL 双向数据通路」的最小完整样例。

**📝 思考题**
- 为什么 AXI4-Lite 不支持突发？如果配置类操作也想要高吞吐，应该怎么改设计？
- CPU 写寄存器时，IP 内部如何保证跨时钟域安全？（提示：本设计 IP 与 AXI 同时钟；若用户逻辑在别的时钟域怎么办）
- 设计 PLC 的 DO 寄存器：8 路输出、需要「软件强制（force）」功能覆盖硬件逻辑，画出寄存器映射并说明 force 的优先级实现。

[← 上一篇第8章 PS外设编程](#ch08)
### 9.8 深潜：AXI 五通道全景与突发传输（为38章铺路）
```
写地址 AW: AWADDR/AWLEN/AWSIZE/AWBURST + VALID/READY
写数据 W : WDATA/WSTRB(字节使能!) + WLAST(最后一拍)
写响应 B : BRESP(OKAY/SLVERR/DECERR)
读地址 AR: 同AW结构
读数据 R : RDATA/RLAST/RRESP
/* 突发三要素: AWLEN=拍数-1; AWSIZE=每拍字节数(2^size);
   AWBURST: FIXED(定址)/INCR(递增·常用)/WRAP(cache行填充用) */
```
AXI4-Lite 是五通道的"单拍特例"(LEN恒0)；理解 WSTRB 让你明白为什么模板代码要按 32bit 对齐写寄存器。38章的 DMA 突发即 INCR 模式的工程化放大。

### 9.9 深潜：自定义 IP 的仿真闭环（不依赖板卡）
IP 交付前必须过「AXI 协议验证」：Vivado 自带 **JTAG AXI Master** IP 或 **AXI Verification IP (VIP)**：

```
/* tb 中例化 AXI VIP (Master) 直接读写你的从机 —— 上板前抓协议违例 */
axi_vip_mst mst_i(...);          /* 配置为 AXI4LITE */
initial begin
  mst_i.start_master();
  mst_i.AXI4LITE_WRITE_BURST(32'h43C10000, 32'h1, resp);
  mst_i.AXI4LITE_READ_BURST (32'h43C10008, data, resp);
end
```

[下一篇 →第10章 PS+PL协同设计综合实验](#ch10)

---

## 第10章 PS+PL 协同设计综合实验
第一篇毕业项目 —— 把第6~9章的全部技能拧成一台「可交互数字控制原型」，它就是第四篇软 PLC 的骨架预演。

**🎯 学习目标**
- 独立完成多 IP 协同的 BD 设计与地址规划
- 实践「中断驱动 + 主循环状态机」的标准裸机软件架构
- 建立软硬件联调的系统级验证思维

### 10.1 项目定义
**需求**：构建一个「定时采集 - 逻辑处理 - 输出执行」闭环：

- KEY0~KEY3 作为 4 路数字输入（DI），经 AXI GPIO 读入；
- PS 每 200ms（AXI Timer 中断）扫描一次输入；
- **业务逻辑**（模拟 PLC 程序）：KEY0=启动，KEY1=停止 —— 按下 KEY0 后 LED 组开始流水（运行态），按下 KEY1 停止并全灭（待机态）；KEY2 切换速度档位，KEY3 记录事件次数；
- LED0~3 由第9章 led_ctrl IP 驱动（走 AXI 寄存器而非 EMIO）；
- 串口打印运行日志（状态迁移、事件计数、扫描节拍）。

PS (Cortex-A9 ×2)
应用层：状态机 + 日志
GIC 中断
私有定时器 200ms

PL (FPGA)
SmartConnect(M_AXI_GP0)
led_ctrl IP0x43C0_0000
AXI GPIO按键 CH1 输入
- AXI4-Lite 配置/读数
LED0~3 ◀── led_ctrl
KEY0~3 ──▶ GPIO
数据流：按键→GPIO寄存器→CPU读取→状态机判决→写 led_ctrl 寄存器→LED 变化

图10-1 综合实验系统框图

### 10.2 Vivado 侧实施清单

BD 中已有 ZYNQ7 PS（第7章配置基础上，勾选 **M AXI GP0** 接口）；
- 添加 `led_ctrl_v1.0`（IP 仓库）与 `AXI GPIO`（双通道关闭，单通道 Input only，宽度 4，勾选中断可选）；
- Run Connection Automation 一键互联所有 S_AXI → SmartConnect → M_AXI_GP0；led_ctrl 的 `led_o[3:0]` Make External 并 XDC 约束到 LED 引脚；AXI GPIO 的 `gpio_io_i[3:0]` 约束到按键引脚（板载按键多为低有效，逻辑里取反）；
- Address Editor 核对两个基地址不重叠；Validate → Export XSA（含 bitstream）；Vitis 更新平台。

### 10.3 软件分层架构（工业代码雏形）
```
#include <xparameters.h>
#include <xil_io.h>
#include <xscutimer.h>
#include <xscugic.h>
#include <xil_printf.h>

/* ===== 硬件抽象层 HAL：把"合同"(第9章寄存器表)固化为一组宏 ===== */
#define LED_REG_CTRL     (*(volatile u32 *)(XPAR_LED_CTRL_0_S0_AXI_BASEADDR+0x00))
#define LED_REG_SPEED    (*(volatile u32 *)(XPAR_LED_CTRL_0_S0_AXI_BASEADDR+0x04))
#define LED_REG_STATUS   (*(volatile u32 *)(XPAR_LED_CTRL_0_S0_AXI_BASEADDR+0x08))
#define KEY_REG_DATA     (*(volatile u32 *)(XPAR_AXI_GPIO_0_BASEADDR))

#define KEY_MASK   0xF
#define SCAN_MS    200

typedef enum { ST_IDLE = 0, ST_RUN } state_t;

static volatile int g_scan_flag;                 /* 定时器 ISR 置位 */
static state_t      g_state = ST_IDLE;
static int          g_speed_idx, g_events;

static const char *speed_name[] = {"slow", "fast"};

void timer_isr(void *p){ static XScuTimer *t = p;
    XScuTimer_ClearInterruptFlag(t); g_scan_flag = 1; }

static void app_init(void)
{
    LED_REG_SPEED = (g_speed_idx ? 4000000 : 12500000);
    LED_REG_CTRL  = 0x0;                         /* 上电默认待机 */
}

static void logic_scan(void)                     /* 业务逻辑：纯函数式 */
{
    static int prev = 0xF;
    int key = KEY_REG_DATA & KEY_MASK;           /* 低有效 → 取反为按下 */
    int press = prev & ~key;                     /* 下降沿检测 */
    prev = key;

    if (press & 0x1) {                           /* KEY0: 启动 */
        if (g_state != ST_RUN) {
            g_state   = ST_RUN;
            LED_REG_CTRL = 0x1;                  /* 使能 · 流水模式 */
            xil_printf("[%6d] RUN\r\n", g_events);
        }
    }
    if (press & 0x2) {                           /* KEY1: 停止 */
        g_state = ST_IDLE; LED_REG_CTRL = 0x0;
        xil_printf("[%6d] IDLE\r\n", g_events);
    }
    if (press & 0x4) {                           /* KEY2: 速度切换 */
        g_speed_idx ^= 1;
        LED_REG_SPEED = (g_speed_idx ? 4000000 : 12500000);
        xil_printf("speed=%s\r\n", speed_name[g_speed_idx]);
    }
    if (press & 0x8) {                           /* KEY3: 事件计数 */
        xil_printf("events=%d\r\n", ++g_events);
    }
}

int main(void)
{
    intc_timer_init();                           /* 复用第8章代码 */
    app_init();
    while (1) {                                  /* 前后台架构 */
        if (g_scan_flag) {
            g_scan_flag = 0;
            logic_scan();
        }
        /* WFI 省电可加：asm("wfi"); */
    }
}
```

### 10.4 验证清单（逐项打勾）

| # | 用例 | 预期现象 | 结果 

| V1 | 上电初始 | LED 全灭，串口无异常刷屏 | ☐ 

| V2 | 按 KEY0 | LED 开始流水 + 打印 RUN | ☐ 

| V3 | 按 KEY2 | 流水速度立即切换 | ☐ 

| V4 | 按 KEY1 | LED 全灭 + 打印 IDLE | ☐ 

| V5 | 快速连按 KEY0/KEY1 | 状态正确翻转无死锁（200ms 扫描容忍丢键属正常，思考为什么） | ☐ 

| V6 | 调试器暂停 CPU | LED 保持当前帧不变（验证 PL 自治性） | ☐ 

💡 V6 的深意
暂停 CPU 后 LED 冻结 —— 因为 led_ctrl 是自治时序逻辑。这正是 PLC 架构的精髓：**实时输出由 PL 保证，CPU 只负责「决策」**。第四篇会把这条边界划得更清晰：IO 采样与输出在 PL，梯形图解算在 Linux。

### 第一篇通关自测

| 能力项 | 达标标准 

| Verilog | 能默写三段式状态机与消抖模块 

| Vivado 流程 | 从空工程到 bitstream ≤15 分钟且不看教程 

| 裸机开发 | 能独立完成「外设初始化四步法」与中断四级使能排查 

| 自定义 IP | 能独立完成「映射表→模板改造→打包→集成→测试」闭环 

| 系统思维 | 能解释任一信号从引脚到 CPU 变量经过的完整路径 

**📝 思考题**
- 若把扫描周期从 200ms 改为 5ms，前后台架构会遇到什么问题？有哪些改造方向？
- V6 中如果想让 CPU 暂停时 LED 继续呼吸，硬件上应如何修改 led_ctrl？
- 为本项目补充一个「掉电前状态保存」功能：利用 OCM 或 DDR 保留区存储 g_state 与 g_events，重新上电恢复。（提示：裸机下没有文件系统，直接约定内存地址）

[← 上一篇第9章 AXI总线与自定义IP设计](#ch09)
[下一篇 →第11章 嵌入式Linux开发环境准备](#ch11)

---

