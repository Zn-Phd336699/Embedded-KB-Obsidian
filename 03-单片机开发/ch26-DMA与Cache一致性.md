---
title: "第26章 DMA 与 Cache 一致性（M7 重点）"
part: "[[P3-MOC]]"
chapter: 26
tags:
  - domain/mcu
  - topic/dma
difficulty: 4
est_minutes: 40
prerequisites:
  - "[[ch25-定时器全家桶]]"
  - "[[ch21-Cortex-M架构精讲]]"
related:
  - "[[ch06-链接器与内存布局]]"
  - "[[ch28-串口工程化IDLE-DMA-RS485]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第26章 DMA 与 Cache 一致性（M7 重点）

> [!info] 导航
> ⏱ 40min | ★★★★☆ | 前置 [[ch25-定时器全家桶]] | → [[ch27-ADC-DAC与模拟前端]]

## 🎯 学习目标
- [ ] 掌握 DMA 流/通道/请求映射的查表方法与优先级仲裁规则
- [ ] 实现循环模式+半满/全满+IDLE 三合一高吞吐接收架构
- [ ] M7 平台正确运用 Clean/Invalidate 或 MPU 免缓存区维护一致性
- [ ] 会做总线矩阵带宽核算，定位多 DMA 并发抖动

## 26.1 F407 DMA 架构要点
| 概念 | 说明 | 查表位置 |
|------|------|----------|
| 两个控制器×8流 | DMA1/DMA2 各 8 个 Stream | RM0090 表43 请求映射 |
| 每流8通道选1 | CHSEL 位选择外设请求源 | 同一张表横向对应 |
| FIFO vs 直连 | 突发打包提带宽；外设对齐受限时必须 FIFO | FCR 寄存器 |
| 仲裁 | 流间软件优先级 + 流内硬件轮询 | SxCR PL 位 |

## 26.2 循环+半满/全满双区接收（串口/ADC 万金油）
乒乓双缓冲时间轴——CPU 处理 A 的同时 DMA 填 B，永不等待：
```text
DMA :  [--DMA→bufA--][--DMA→bufB--][--DMA→bufA--][--DMA→bufB--
                 ●半满中断     ●全满中断     ●半满中断
CPU :            (处理A拷出)   (处理B滤波)   (处理A…)
切换点即红点：ISR 内只置事件，处理放任务侧——ISR 越短抖动越小(ch24)
```
```c
#define BUF_SZ 256
static uint8_t rxbuf[BUF_SZ] __attribute__((aligned(32)));
HAL_UART_Receive_DMA(&huart1,rxbuf,BUF_SZ);        /* 循环模式自动重装 */
/* 半满回调：处理 [0,128)；全满回调：处理 [128,256)
   两区交替，主循环用写指针快照消费——永不丢字节且无需逐字节中断 */
void HAL_UART_RxHalfCpltCallback(UART_HandleTypeDef*h){ feed_parser(rxbuf,BUF_SZ/2,0); }
void HAL_UART_RxCpltCallback(UART_HandleTypeDef*h){ feed_parser(rxbuf+BUF_SZ/2,BUF_SZ/2,1); }
```

## 26.3 M7 Cache 一致性三方案（H7/F7 必修课）
背景：D-Cache 缓存了 rxbuf，DMA 直接写 RAM 绕过 Cache → CPU 读到旧数据。
```c
/* ── 方案① 手动维护（精细控制，易漏易错）──*/
SCB_CleanDCache_by_Addr((uint32_t*)txbuf,len);      /* 发送前：Cache→RAM 冲洗 */
SCB_InvalidateDCache_by_Addr((uint32_t*)rxbuf,len); /* 接收后：丢弃Cache行逼CPU读RAM */
/* 注意：Invalidate 前若 Cache 行有脏数据会被丢掉！缓冲必须是"纯DMA用途" */

/* ── 方案② MPU 划非缓存区（推荐，一劳永逸）──*/
MPU_Config_Region(DMA_BUF_BASE,DMA_BUF_SZ,
    MPU_ATTR_NORMAL_NONCACHEABLE);                  /* 该区间所有DMA缓冲免维护 */
/* 对齐要求：区域边界32字节对齐；缓冲本身也 aligned(32) */

/* ── 方案③ 双缓冲乒乓 + 显式屏障（极致性能）──*/
/* CPU处理bufA的同时DMA填bufB；切换点做一次 Clean/Invalidate
   A核Linux等价概念：dma_alloc_coherent(一致性映射) vs dma_map_single(流式映射) */
```
M7 Cache line 为 32B：相邻全局变量跨同一行时 CPU 写 A 会连带失效 B 的缓存行（伪共享）；热成员用 `aligned(32)` 强制分行；DMA 缓冲必须 32B 对齐，Invalidate 才不会误伤邻居。

## 26.4 原理深挖：总线矩阵带宽账本（F407）
| 主设备 | 挂接总线 | 峰值需求示例 |
|--------|----------|--------------|
| CPU(I/D) | AHB1/AHB2 | 168M×4B 取指+数据 ≈1.3GB/s |
| DMA2(存储器到存储器) | AHB1 | 与 CPU 抢 SRAM |
| Ethernet DMA | AHB1 | 100M 线速 ≈12.5MB/s×2 |
| USB OTG HS(DMA) | AHB1 | 480Mbps≈60MB/s |

SRAM 总带宽有限 → 多 DMA 并发「偶发抖动」的物理根源；优先级 PL 位就是仲裁筹码。

## 26.5 完整工程：三合一接收模块（DMA 循环+半满/全满+IDLE）
```text
Bsp/bsp_rx_dma.c —— UART 不定长接收终极方案
├─ 缓冲: rxbuf[512] aligned(32), DMA 循环模式
├─ 半满回调 → feed(rxbuf,   0, 256)
├─ 全满回调 → feed(rxbuf, 256, 256)
└─ IDLE 中断 → pos=512-NDTR; feed(rxbuf,last,pos-last); last=pos
/* feed() 把区间拷进解析环形缓冲或直接喂协议状态机；
   长流靠半/全满切片，短帧靠 IDLE 定界 —— 三者覆盖一切节奏 */
```

## 26.6 参数调试技巧
| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 收到旧数据 | 打印首字节对比源码 | Invalidate / 上 noncacheable 区 | 数据随源更新 |
| 传输差 1 字节 | 读 NDTR 反推 | 已传 = 总量 − NDTR（循环模式配合取模） | 长度精确 |
| 多路互相拖慢 | 示波器看音频流抖动 | 按 PL 位分级：音频最高 | 无周期性毛刺 |
| M2M 不如预期 | DWT 计时 | 开双字突发+FIFO 打包 | 带宽接近上限 |

## 26.7 实测数据表：搬运方式带宽对比（SRAM→SRAM，1024B/次）
| 方式 | 实测带宽 | CPU 占用 |
|------|----------|----------|
| memcpy 循环(-O2) | ~180MB/s | 100% |
| DMA M2M 字宽 FIFO 直连 | ~110MB/s | ~0% |
| DMA 双字突发 FIFO 使能 | ~150MB/s | ~0% |

结论：M2M 上 DMA 并不比 CPU 快，它的价值在**解放 CPU**；外设流(DAC/ADC/SPI)才是 DMA 主场。

## 26.8 排故速查表
| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| DMA 收到的数据全零 | 缓冲在 CCM（DMA 盲区，见 ch06） | map 查缓冲地址；挪到主 SRAM |
| M7 上收到旧数据 | D-Cache 未失效 | Invalidate 后复测；上 MPU noncacheable 区 |
| 传输长度差 1 字节 | NDTR 是「剩余数量」语义理解错 | 已传 = 总量 − NDTR（循环模式取模） |
| 多路 DMA 相互拖慢 | 全部挤在同一控制器高优先级 | 按实时性分配 PL 位；音频流给最高 |
| 偶发总线错误 HardFault | 缓冲未对齐突发宽度/越界 | aligned(32)；MSIZE 与 PSIZE 匹配；边界单测 |

## 26.9 部署注意事项
1. NDTR 单位随 PSIZE 变化：PSIZE=HALF_WORD 时按半字计数，按字节算会收双倍数据。
2. FIFO 隐藏收益：外设 8bit + 内存 32bit 时打包把 AHB 事务数降 4 倍，带宽紧张先查这里。
3. H7 用 MDMA 专管 M2M（走 AXI 矩阵不占 DMA1/2）；DMAMUX 让请求路由自由化。
4. 链表/描述符模式实现分散收集：三段不连续发送数据串成一条链一次发完。
5. 双缓冲 DBM 零切换延迟但只有两块；手动乒乓可扩展 N 块——音频两块够，视频帧链用后者。

> [!example]- 🧪 动手实验 L26-1：亲手翻一次 Cache 车（50 分钟）
> **步骤**：① H7/F7 工程（或 F407 关 Cache 对照）：ADC-DMA 循环采正弦到缓冲；② 显示缓冲波形——正常；③ 开 D-Cache 重启观察显示「冻结在旧数据」；④ 读取前加 InvalidateDCache_by_Addr 复现恢复；⑤ 改放 noncacheable MPU 区再删屏障代码验证等价。**验收**：三种形态截图+你写的「何时选哪种」决策卡。

## 26.10 进阶话题
- **M7 平台三查口诀**：① 缓冲 32B 对齐了吗 ② noncacheable 区还是 Clean/Invalidate ③ 切换点补屏障了吗。
- **症状对照**：显示「冻结旧数据」=Cache 未失效；偶发半帧损坏=对齐越界污染邻块（联动 ch15 内存排查）。
- **官方笔记三连**：AN4027（F7/H7 Cache 一致性）、AN4838、AN4655（DMA 使用指引）；ARM M7 TRM 注意维护指令操作数必须行对齐。

> [!warning]- ❓ FAQ
> **Q1：为什么 Invalidate 不能用于「CPU 也写过的共享缓冲」？** 会把未回写的脏行直接丢弃，CPU 侧修改凭空消失——只用于纯 DMA 接收缓冲。
> **Q2：H7 移植老 F4 代码要注意什么？** DMAMUX 映射错了也可能跑一半才暴露，逐路核对请求源映射。

> [!question] 📝 思考题
> 1. 推导循环模式下任意时刻已写入字节数的表达式（考虑正在跨界的半字节）。
> 2. 为什么 Invalidate 不能用于「CPU 也写过的共享缓冲」？给出事故场景推演。
> 3. 对比 M7 的 MPU noncacheable 方案与 Linux dma_alloc_coherent 的底层机制异同。

---
🏷️ #domain/mcu #topic/dma | 🔗 [[ch25-定时器全家桶]] ← **本章** → [[ch27-ADC-DAC与模拟前端]] | 📚 [[P3-MOC]]
