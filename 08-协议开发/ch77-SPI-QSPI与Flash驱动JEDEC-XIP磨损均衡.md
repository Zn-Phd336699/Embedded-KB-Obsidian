---
title: "第77章 SPI/QSPI 与 Flash 驱动：JEDEC、XIP 与磨损均衡"
part: "[[P8-MOC]]"
chapter: 77
tags:
  - domain/protocol
  - topic/spi
difficulty: 4
est_minutes: 40
prerequisites:
  - "[[ch76-I2C协议与排障时钟拉伸总线锁死多主机]]"
related:
  - "[[ch26-DMA与Cache一致性]]"
  - "[[ch30-Bootloader-IAP-OTA固件升级体系]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第77章 SPI/QSPI 与 Flash 驱动：JEDEC、XIP 与磨损均衡

> [!info] 导航
> ⏱ 40min | ★★★★☆ | 前置 [[ch76-I2C协议与排障时钟拉伸总线锁死多主机]] | → [[ch78-CAN-CANFD实战SocketCAN-DBC工作流]]

## 🎯 学习目标
- [ ] 给定器件手册判读四种 CPOL/CPHA 模式，说清 Mode0/Mode3 的空闲电平与采样沿
- [ ] 手写 NOR Flash 命令层：JEDEC ID、页编程跨页拆分、BUSY 轮询
- [ ] 按 STM32 QUADSPI 六步完成 XIP 配置并解释 Dummy Cycles 失配后果
- [ ] 用「10 万次擦写 × 写放大」模型计算指定业务的 Flash 寿命预算

## 77.1 SPI 四模式时序判别（CPOL/CPHA）
CPOL（Clock Polarity，时钟极性）定 SCK 空闲电平，CPHA（Clock Phase，相位）定采样沿：

| 模式 | CPOL/CPHA | 空闲电平 | 采样沿 | 常见器件 |
|------|-----------|----------|--------|----------|
| Mode 0 ★最常见 | 0 / 0 | 低 | 第 1 个沿（上升） | 多数传感器/ADC |
| Mode 3 | 1 / 1 | 高 | 第 2 个沿（下降） | Flash/屏 |
**模式配错的症状指纹**：数据整体左/右移一位（MSB 对齐到错误沿），解码出「规律性乱码」；首字节正确后续全错 = CS 极性或首位采样沿错位。判定方法：逻辑分析仪按两种模式各解一次（见 [[ch19-逻辑分析仪与sigrok]]），输出语义合理者即为正确模式。

## 77.2 QSPI 四线提速与 XIP 原地执行
提速三级跳：单线 SPI（命令+数据走 MOSI）→ Dual 2 线 → Quad 4 线 → XIP（内存映射执行：代码直接在 Flash 上跑，省拷贝）。W25Q128 四线 @50MHz 实测 ≈25MB/s。**Dummy Cycles 必须匹配器件手册对应频率档——读太快没等够 = 全 0xFF**。STM32 QUADSPI/OCTOSPI 六步配置：

| 步骤 | 操作 | 易错点 |
|------|------|--------|
| ① 时钟与引脚 | 内核时钟=f(AHB)/预分频；6 引脚 AF10 | 预分频过高是首因性失败 |
| ② Flash 参数 | 容量对数/CS 高电平周期/时钟模式 3 或 4 | FlashSize 位宽填错 = 读回全 FF |
| ③ 命令配置 | CCR 组：指令/地址/交替字节/dummy 数/数据模式 | Dummy Cycles 必须查手册频率档表 |
| ④ 使能 QPI | 先置状态寄存器 QE 位 → SET_QUAD 命令切四线 | 顺序反了卡死在单线 |
| ⑤ 内存映射 | 直接读 0x90000000 别名区 | DMA 访问走 AHB 且注意只读属性 |
| ⑥ 擦写保护 | XIP 运行中擦同 bank = 取指停摆 | 双 bank 器件可交叉读写 |
## 77.3 NOR Flash 命令集与驱动分层

```c
#define CMD_JEDEC_ID       0x9F /* 返回 EF4018: 厂商 EF + 容量 18=16MB */
#define CMD_WREN           0x06 /* 写使能——每次擦写前必须！ */
#define CMD_RDSR           0x05 /* 读状态 BUSY 位轮询；4KB 扇区擦除命令为 0x20 */
#define CMD_PAGE_PROGRAM   0x02 /* 页=256B，跨页自动回卷是坑！ */
void flash_write_buf(uint32_t addr, const uint8_t *buf, uint32_t len)
{
    while (len) {
        uint32_t off = addr & 0xFF;
        uint32_t chunk = MIN(256 - off, len);      /* 不跨页拆分 ★必做 */
        flash_wren();
        flash_cmd_addr_data(CMD_PAGE_PROGRAM, addr, buf, chunk);
        wait_busy();                               /* tPP ≈ 0.4~3ms */
        addr += chunk; buf += chunk; len -= chunk;
    }
}
/* 铁律：NOR 只能 1→0 写，整块擦成 FF 才能重写；4KB 扇区擦除 tSE≈45~400ms——高频小数据别直接打 Flash */
```

分层封装三件套（换控制器/换器件/换文件系统只动一层）：① 总线抽象 `xfer()`（HAL_SPI_*）；② 命令层 `flash_read_jedec()`、`flash_wait_ready()`（轮询 SR 的 BUSY 位）；③ 文件系统适配——littlefs block device ops 的 read/prog/erase/sync 四函数指针。

## 77.4 SPI 从机纪律与菊花链

```c
/* SPI 从机三纪律：① 永远被动——预填 DR 的时机=片选下降沿中断(NSS EXTI)，晚了丢首字节
   ② NSS 硬管理(SSM=0 硬件 NSS 或 GPIO+EXTI)，绝不能悬空 ③ 从机 FIFO/双缓冲(H7)防背靠背突发 */
/* 菊花链(daisy-chain)：移位寄存器级联，一主多从仅 3+1 线；适用 LED 驱动(WS2811 类)/ADC 链(ADS131M04 级联)/FPGA 配置；
   所有从机 SIMO→SONI 直连成环，CS 共用，总移位长度=Σ各器件位数；限制：不能随机访问单个器件——整链一起换数据 */
```
## 77.5 NOR vs NAND 选型与文件系统落地

| 维度 | NOR（W25Q 类） | NAND（SPI NAND 等） |
|------|----------------|---------------------|
| 容量甜区 | 1~32MB | 128MB~GB 级 |
| XIP 执行 | ✅ 天然支持 | ❌ 需加载到 RAM |
| 坏块管理 | 无需（出厂无坏块） | 必须 ECC+坏块表+磨损均衡 |
| 随机读 | 快（µs 级） | 慢（需页读 µs~百µs） |
| 典型用途 | Bootloader/参数/字体库 | 大容量存储/录像缓存 |
文件系统三选一：**Littlefs**（MCU 首选★：掉电一致性设计、磨损均衡内建、RAM 占用小）；FatFs 兼容 U 盘/PC 读卡场景但自身不防掉电损坏（需 FTL 层或只读使用）；JFFS2/UBIFS 为 Linux MTD 原生方案（NAND 大容量首选 UBIFS）。

频繁写入的小参数（计数器/校准值）**永远不要直写 Flash 主文件系统**，方案排序：① 片内 EEPROM 仿真区（独立扇区+双副本轮换）② FRAM 铁电存储（近无限次写）③ Littlefs 独立分区。

## 77.6 磨损均衡（Wear Leveling）与寿命预算计算
磨损均衡把擦写摊到所有块上避免「日志总打同一扇区」——Littlefs 内建动态均衡，裸奔方案需自建映射表+块计数统计。**写放大警告：改 1 字节 = 读出+擦除+回写整个 4KB 扇区——寿命预算必须按扇区算！** 公式：`可用天数 ≈ 单扇区擦写次数 ÷ 日均对该扇区擦写次数`。例：NOR 扇区 10 万次擦写 × 每天 100 次 ≈ 3 年——算清楚再选型；每天 500 条事件日志则需轮换分区或 FRAM。

## 77.7 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 读回全 0xFF/全 00 | LA 抓 CLK 与 IO0~IO3 波形 | QPI/SPI 模式残留、dummy 数、CS 极性 | 单线慢速读 JEDEC ID=EF4018 先通再提速 |
| 解码出规律性乱码 | LA 按两种模式各解一次 | CPOL/CPHA | 某一模式解码语义合理 |
| 写入尾部丢失 | 回读比对写前后 CRC | 页边界拆分逻辑（addr & 0xFF） | 任意地址任意长度写入校验通过 |
## 77.8 实测数据表：W25Q128 关键时序（与手册对账）

| 操作 | 手册典型/最大 | 实测(50MHz QSPI) |
|------|---------------|------------------|
| 页编程 256B | 0.4ms / 3ms | ~0.6ms |
| 4KB 扇区擦除 | 45ms / 400ms | ~60ms |
| 快速读吞吐(QSPI) | - | ~22MB/s 实效 |
## 77.9 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 读到全 0xFF 或全 00 | QPI/SPI 模式残留/dummy 错/片选极性反 | 先单线慢速读 JEDEC 验证基础通路，逐级提速 |
| 偶发写入失败 | 跨页未拆分/WREN 被 SR 保护位挡住 | 审查分页逻辑；读 SR 核对保护位(SRP/WPEN) |
| 掉电后文件系统挂载失败 | FatFs 无掉电保护直接断电 | 迁 Littlefs；或加电容安全关机流程 |
| XIP 运行中卡死 | 执行中擦除同 bank 取指停摆 | 核对 RWW 特性；擦写放 RAM 函数 |
| 寿命提前耗尽 | 日志高频直写同扇区 | 接入磨损均衡层；统计写放大系数整改 |
## 77.10 部署注意事项
1. 上电先发 RESET_ENABLE+RESET（或连续拉高 CS 同步）清除 QPI/SPI 模式残留——量产「首台不识别」多源于此；
2. 高频小参数禁止直写主文件系统，走 EEPROM 仿真/FRAM/Littlefs 独立分区三选一；
3. XIP 场景把擦写代码放 RAM 函数，双 bank 器件交叉读写，避免取指停摆；
4. 设备指纹/公钥哈希放 W25Q 独立 OTP 扇区并上锁，当免费保险箱用。

> [!example]- 🧪 动手实验 L77-1：从裸命令到 Littlefs 落地（80 分钟）
> **步骤**：① 裸命令读写 JEDEC ID 与一个扇区，LA 抓波形核对模式；② 封装 77.3 三件套；③ 挂载 littlefs 格式化并跑断电测试（写中拔电 20 次）；④ 校验挂载后文件完整性；⑤ 统计各块擦写次数分布。
> **验收**：断电零损坏 + 一张「各块擦写次数」直方图。

## 77.11 进阶话题
- **XIP 与 OTA 冲突**：运行中擦自身镜像所在 bank 会取指停摆，升级流程要切 bank 或搬运执行（联动 [[ch30-Bootloader-IAP-OTA固件升级体系]]）；
- **OTP/安全区**：W25Q 有独立 OTP 扇区与锁位，放设备指纹/公钥哈希的免费保险箱；
- **NAND 引入的分水岭**：参数区之外还需 >64MB 日志/媒体时才引入 SPI NAND——坏块管理与 ECC 的复杂度要值回票价。

> [!warning]- ❓ FAQ
> **Q1：Quad@80MHz 理论带宽为何实测只有约六成？** 命令/地址/交替字节阶段仍走单线、dummy 等待周期与 CS 间隙都计入时间——带宽按有效载荷核算。
> **Q2：FatFs 能用在会掉电的产品里吗？** 本身不防掉电损坏，需 FTL 层或只读使用；要求掉电一致直接选 Littlefs。

> [!question] 📝 思考题
> 1. 推导 QSPI Quad@80MHz 理论带宽，并解释为何实测只有约 60%。
> 2. 为「每天记录 500 条事件日志」设计存储方案并计算寿命。
> 3. 阅读 littlefs 的 metadata pair 结构，解释其掉电一致性原理。

---
🏷️ #domain/protocol #topic/spi #topic/flash | 🔗 [[ch76-I2C协议与排障时钟拉伸总线锁死多主机]] ← **本章** → [[ch78-CAN-CANFD实战SocketCAN-DBC工作流]] | 📚 [[P8-MOC]]
