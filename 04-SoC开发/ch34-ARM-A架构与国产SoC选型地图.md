---
title: "第34章 ARM-A 架构与国产 SoC 选型地图"
part: "[[P4-MOC]]"
chapter: 34
tags:
  - domain/soc
  - topic/architecture
difficulty: 4
est_minutes: 32
prerequisites:
  - "[[ch33-综合实战环境监测终端]]"
related:
  - "[[ch40-内核适配与设备树dts语法-pinctrl-overlay]]"
  - "[[C-选型对照表]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第34章 ARM-A 架构与国产 SoC 选型地图

> [!info] 导航
> ⏱ 32min | ★★★★☆ | 前置 [[ch33-综合实战环境监测终端]] | → [[ch35-i-MX6U-ALPHA平台详解]]
## 🎯 学习目标
- [ ] 说清 Cortex-M 与 Cortex-A 的六大本质差异及其对软件栈的影响
- [ ] 手推 AArch64 四级页表（Page Table）VA→PA 走查路径并解释 TLB 的作用
- [ ] 用 GIC 两级模型区分 SGI/PPI/SPI 并写出设备树中断描述
- [ ] 独立完成一次 SoC 五维选型打分，并用利特尔法则核算核数容量
## 34.1 M 核 vs A 核：六个本质差异

| 维度 | Cortex-M | Cortex-A |
|------|----------|----------|
| 地址空间 | 物理直通 4GB | MMU 虚拟内存，每进程独立 4GB/2^48 |
| 执行模型 | 单程序+ISR | 多进程多线程+调度器（内核） |
| 特权级 | Handler/Thread | EL0 用户/EL1 内核/EL2 虚拟化/EL3 安全监控（ATF） |
| 异常返回 | EXC_RETURN 值 | ERET + SPSR/ELR 寄存器组 |
| 中断控制器 | NVIC 内建 | GIC 独立 IP：分发器+CPU 接口两级 |
| 典型软件栈 | 裸机/RTOS | Linux/Android/RTOS（A 核也能跑） |

M 核工程师最常翻的车：把物理地址当虚拟地址直接解引用 → imprecise abort（不精确中止）。
## 34.2 MMU：四级页表的完整走查

四级页表走查(AArch64, 48位VA, 4KB粒度)：`TTBR0_EL1 → L0 表 → L1(1GB 块) → L2(2MB 块) → L3(4KB 页) → PA`，TLB 缓存翻译结果，miss 才走页表遍历(硬件 walker)。

对嵌入式 BSP 的三个实际影响：① 设备树 `reg` 里写的是**物理地址**——驱动经 `ioremap` 之后拿到的才是虚拟地址；② DMA 缓冲必须走一致性映射或 swiotlb 弹跳缓冲（对照 [[ch26-DMA与Cache一致性]]）；③ 改页表属性（XN/缓存策略）要走 `set_memory_xx` 接口，手改 TTE 会踩 TLB 一致性坑。
## 34.3 GIC 中断路由模型

路由模型：SPI(共享外设中断 32~1019) → GIC Distributor(按 CPU 掩码路由) → CPU Interface(每核一个) → IRQ/FIQ 进核心；SGI(0~15) 核间通信——smp_call_function 靠它踢其他核；PPI(16~31) 每核私有——各核自己的 timer/watchdog。

设备树写法（dts 实战在 [[ch40-内核适配与设备树dts语法-pinctrl-overlay]] 展开）：`interrupt-parent = <&gic>; interrupts = <GIC_SPI 42 IRQ_TYPE_LEVEL_HIGH>;`
## 34.4 多核启动、DSU 与大小核

- **冷启动不对称**：BootROM 固定从核 0 起，其余核停在 holding pen（WFI 循环），由 U-Boot/ATF 通过 PSCI 接口唤醒——这就是 Linux `maxcpus=` / cpu-hotplug 的底层机制；
- **big.LITTLE**（RK3588）：A76+A55 异构，调度器按负载迁移任务；性能敏感线程用 `sched_setaffinity` 绑大核（[[ch65-性能优化CPU隔离cgroup-io调优]]实操）；
- **DSU 一致性单元**：多核共享 L3，缓存行靠 MESI 协议维持一致——所以 A 核上 spinlock 不必像 M 核那样关中断，但要防伪共享（False Sharing）：结构体成员跨缓存行做 64B padding 隔离。

**利特尔法则(Little's Law)做容量核算**：并发实体数 L = 吞吐率 λ × 平均驻留时间 W。例：目标 200 帧/s × 单帧处理 20ms = 同时有 4 帧在处理 → 4 个 A55 刚好贴水位，必须上大核或 NPU 才有安全余量；再乘安全系数 2 对照核数/TOPS 决策。
## 34.5 国产平台对照与五维选型打分

| 平台 | CPU | 亮点 | 主线内核支持 | 适合场景 |
|------|-----|------|--------------|----------|
| i.MX6ULL | A7×1 900MHz | NXP 文档极全、正点原子教程体系成熟 | ★★★★★ 完美支持 | Linux 入门教学首选 |
| 全志 H3/H616 | A7×4 / A53×4 | Orange Pi 生态、价格屠夫 | H3 ★★★★★ / H616 ★★★☆ | 软路由、轻量网关 |
| RK3566/3568 | A55×4 2.0G | NPU 0.8~1T、双千兆、工业温宽 | ★★★★ 持续完善(rk3568-dts) | 边缘计算网关、NVR |
| RK3588(S) | 4×A76+4×A55 | 6T NPU、8K 编解码、PCIe3.0×4 | ★★★☆ 快速演进中 | AI 盒子、桌面级终端 |
| Luckfox Pico(RV1103) | A7×1 | ¥50 带 RISC-V MCU 核、摄像头 ISP | ★★★★ 厂商维护积极 | 超小型视觉节点 |
| RV1106/K230 等 RISC-V 补充 | - | K230 双 RV 核+KPU；D1/D1s 单 RV64 | 各家自维护 SDK | 低功耗 AI 感知、RISC-V 练手 |

| 维度(权重) | 评分要点 | 信息来源 |
|------------|----------|----------|
| 算力匹配×0.25 | 像素流×算子→TOPS/DMIPS 反推×安全系数 2 | TRM + rknn_model_zoo 基准 |
| 外设账单×0.20 | 硬需求逐条打勾(双网口/CAN/MIPI 数量)，一票否决制 | Datasheet 外设清单 |
| 主线支持度×0.25 | kernel.org 是否含 dts、社区 Armbian 状态页 | git log arch/arm/boot/dts/ |
| BOM 与供货×0.15 | 整板成本+核心料现货周期 | 立创商城搜索现货 |
| 资料密度×0.15 | GitHub issue 活跃度/论坛帖子数/官方 wiki 质量 | 半天检索摸底 |

**权重心法**：主线内核支持度 = 未来五年维护成本，厂商私有 BSP 是甜蜜的负债。教学/原型期优先「主线支持度+资料密度」，量产期「BOM 与供货」权重飙升。选型直觉：A7 够做「带屏幕的 RTOS 替代品」，NPU 需求 ≥1 路 AI 视频才值得上 RK35xx。
## 34.6 关键代码：物理 vs 虚拟地址对照打印

```c
static int __init addr_probe(struct platform_device *pdev)
{
    struct resource *res = platform_get_resource(pdev, IORESOURCE_MEM, 0);
    void __iomem *virt = devm_ioremap_resource(&pdev->dev, res);
    pr_info("PA=%pR  VA=%px\n", res, virt);     /* 同一寄存器的两副面孔 */
    writel(readl(virt) ^ (1u << 5), virt);      /* 必须经虚拟地址访问 */
    return PTR_ERR_OR_ZERO(virt);
}
```

板上快速验证：`cat /proc/iomem | grep -i uart` 得物理区间，再用 `devmem <物理地址>` 读同一寄存器比对内容一致。
## 34.7 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 大小核绑核不生效 | taskset -pc PID；lscpu 查拓扑 | sched_setaffinity 重绑 cpu4-7(A76) | 满载落在大核域 |
| 怀疑伪共享 | perf c2c 采样 HITM | 计数器 64B 对齐隔离 | HITM 事件归零 |
| SGI/IPI 流量异常 | /proc/interrupts 的 IPI 列采样 | 减少 smp_call_function 频次 | IPI 增量与业务匹配 |
| 温控降频误判性能 | /sys/class/thermal + dmesg | 散热或 thermal 曲线 | 频率钉住最大档 |
## 34.8 实测数据表：同任务在不同平台的真实表现

| 任务 | i.MX6ULL(A7) | RK3568(A55×4) | RK3588(A76×4) |
|------|--------------|----------------|----------------|
| Linux 冷启动到 shell | 4.5s(BusyBox)/12s(systemd) | 3.8s/9s | 2.1s/5s |
| yolov5n CPU 推理一帧 | >2s(不实用) | ~380ms | ~90ms / NPU 18ms |
| H264 1080p 解码 | 软解 12fps | 硬解 60fps(CPU<10%) | 硬解 8K@30 能力 |
| 静态待机功耗(整机) | ~0.6W | ~1.2W | ~2.5W |
## 34.9 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 单核跑满其余闲置 | 应用单线程/亲和性被绑死 | top 按 1 展开；taskset -pc PID 查掩码 |
| 中断风暴 CPU 100% | 电平触发且未清源 | /proc/interrupts 连续采样看增量；检查 handler 清标志逻辑 |
| 多核数据偶发错乱 | 伪共享/缺原子操作/内存序假设错误 | pahole 查缓存行布局；改 atomic/锁；加 dmb ish 屏障验证 |
| 性能远低于规格 | governor 在 powersave/降频温控 | cpupower frequency-info；设 performance 后复测 |
## 34.10 部署注意事项

1. 把「哪些 IP 还锁在厂商 BSP」列成清单写进产品决策表，锁定 u-boot/kernel/发行版版本三角；
2. 先查立创商城现货周期，再看 GitHub issue 密度——顺序反了会为情怀买单；
3. TRM 的「总线框图」章是选型第一手资料；ARM Architecture Reference Manual(DDI0487) 只查用不通读；
4. 混合关键性需求优先评估 A 核 Linux + 同片 M/R 核跑 RTOS 的 OpenAMP/rpmsg 方案。

> [!example]- 🧪 动手实验 L34-1：亲手验证「物理 vs 虚拟」地址差（30 分钟）
> **步骤**：① 板上 `cat /proc/iomem | grep -i uart` 记录物理区间；② 写 10 行模块打印 `platform_get_resource → devm_ioremap_resource` 返回的虚拟地址；③ 对比两者偏移并解释 PAGE_OFFSET 映射关系；④ 用 `devmem` 读同一寄存器验证内容一致。
> **验收**：产出一张三列对照表（物理/虚拟/读值），数值逻辑自洽且可复现——MMU 迷雾从此散开。
## 34.11 进阶话题四则

- **DSU 的 L3 共享与伪共享**：perf c2c 在 A 核同样可用，跨核高频写的计数器必须缓存行隔离；
- **PSCI 的存在感**：secondary core 启动/CPUIdle 全走 ATF，内核日志 `psci: probing` 就是握手成功；
- **RISC-V 平台差异**：中断控制器随厂商(CLINT/PLIC/APLIC)，BSP 移植工作量集中在 irqchip 驱动；
- **混合关键性架构**：A 核 Linux + 同片 M/R 核 RTOS 是「既要又要」的标准解，RK3588/i.MX8 双系都支持。

> [!warning]- ❓ FAQ
> **Q1：为什么 M 核的 spinlock 要关中断而 A 核 Linux 不必？** 抢占模型不同：M 核裸机下 ISR 可随时打断持锁者形成死锁，临界区必须手动关中断保护；Linux 的 spin_lock 已隐式禁抢占，中断场景交给 spin_lock_irqsave 局部按需处理。
> **Q2：厂商 SDK 和主线内核怎么选？** 教学/原型跟主线（Armbian）；用到厂商专属 IP（NPU/ISP/VPU）时锁厂商树，但把升级路线和版本三角写死在文档里。

> [!question] 📝 思考题
> 1. 为你的项目做一次五维打分：RK3568 vs H616 vs i.MX6ULL，每个维度给出证据。
> 2. 推导 SGI 实现「让核 3 执行某函数」的完整调用链直到汇编入口。
> 3. 若把 DSU 共享 L3 改成每核私有 L2-only 设计，伪共享问题会消失吗？为什么？

---
🏷️ #domain/soc #topic/architecture | 🔗 [[ch33-综合实战环境监测终端]] ← **本章** → [[ch35-i-MX6U-ALPHA平台详解]] | 📚 [[P4-MOC]]
