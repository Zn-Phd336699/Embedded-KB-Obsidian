---
title: "TC19 运行数年后参数区读取出错、坏块激增"
tags:
  - troubleshooting
  - protocol/flash-wear
severity: high
frequency: occasional
source: "[[ch77-SPI-QSPI与Flash驱动JEDEC-XIP磨损均衡]]"
date: 2025-01-15
---
# TC19 Flash 擦写寿命预算

## 现象
设备运行 1~3 年后保存的参数频繁 CRC 出错甚至丢失、写入变慢、坏块连片；典型触发：参数每秒落盘到 SPI NOR 同一扇区的「省事」设计。

## 环境与适用范围
适用 SPI NOR（W25Q 系列，扇区典型 10 万次擦写）、SPI/RAW NAND（数千~十万次视颗粒）、EEPROM（百万级）。不适用 RAM/FRAM 等非损耗介质。

## 取证过程
1. 盘点写入点：应用日志或逻辑分析仪抓 SPI 波形，统计写入频率 × 每次字节数。
2. 确认落点：驱动映射表或 mtd_debug，确认是否固定扇区原地更新——每次修改即 1 次整块擦除。
3. 读 JEDEC ID（9Fh 指令）确认颗粒型号，查手册 Page/Sector Size 与 P/E Cycle 规格。
4. 扫健康度：遍历坏块标记与厂商状态寄存器，估算已消耗擦写次数及增长趋势。
5. 代入预算公式核算剩余年限，评估是否需要重构存储策略。

## 根因
改 32B 也要整块擦（4KB），擦写集中在少数块上。预算公式：寿命(年) = 块耐久 × 参与均衡块数 ÷ 日写入次数 ÷ 365。例：每秒写 1 次单扇区直写 → 100000÷86400 ≈ 1.2 天耗尽；摊到 8MB 全片 2048 个扇区 → 约 6.5 年。差距即磨损均衡的价值。

## 修复方案
```c
/* 策略一：RAM 缓存 + 脏标志延时落盘，削峰写入次数 */
void param_set(const void *val, size_t len)
{
    memcpy(g_cache, val, len);
    g_dirty = 1;
}
/* 定时器(如 1min)或关机钩子里才真正写 Flash */
void param_flush(void)
{
    if (!g_dirty) return;
    flash_write_verify(PARAM_ADDR, g_cache, PARAM_SIZE); /* 写前镜像+CRC */
    g_dirty = 0;
}
/* 策略二：环形追加日志，写满一块换下一块，天然磨损均衡 */
```

## 预防措施
- 设计期强制填「寿命预算表」：写频率 × 字节数 × 写放大 对比 块规格
- 高频小数据改用 EEPROM/FRAM 或带电容备份的 SRAM
- 全片磨损均衡；预留区记录累计擦写计数便于预警
- 掉电一致性：双页乒乓 + CRC，新页校验通过再翻指针
- 承诺寿命指标前预留 ≥20% 耐久余量

## 关联
- 源章节：[[ch77-SPI-QSPI与Flash驱动JEDEC-XIP磨损均衡]]
- 相关章节：[[ch29a-电源异常与掉电保护]] [[ch87-P1-STM32环境监测终端]]
