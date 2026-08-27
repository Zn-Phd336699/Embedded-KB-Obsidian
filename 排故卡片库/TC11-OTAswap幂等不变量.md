---
title: "OTA swap 中途断电，设备变砖无法启动"
tags:
  - troubleshooting
  - mcu/bootloader
severity: high
frequency: rare
source: "[[ch30-Bootloader-IAP-OTA固件升级体系]]"
date: 2025-01-15
---
# TC11 OTA swap 幂等不变量设计

## 现象
双分区 OTA 在交换/搬移镜像过程中掉电或复位后，设备再也起不来；触发条件：swap 长事务进行到任意中间状态时断电。

## 环境与适用范围
双分区（slot0/slot1）+ scratch 扇区的 MCUboot 类方案；自研 swap 逻辑同样适用。A/B 指针切换型（无数据搬移）风险较低但仍需持久化状态标志。

## 取证过程
1. 读 flash 元数据扇区：确认 magic 与 state 当前值（是否停在 RESUME/TESTING）。
2. 分别校验两个槽镜像头的 magic/版本/哈希，确定中断发生在哪一步。
3. 对照状态机表判断：重启后应由哪个分支接管（续传/回滚/正常启动）。
4. 用烧录夹台架在每个扇区边界注入断电，复现故障并验证恢复路径。

## 根因
swap 本质是「擦除-搬移-回填」多扇区长事务，flash 无法原子交换两块区域；若不先持久化进度状态就直接改写镜像数据，任意一点掉电都会留下两个半成品镜像的杂交体，哈希双双失效——Bootloader 找不到任何一个可启动映像，设备变砖。

## 修复方案
```c
/* 幂等不变量：先写状态，再做可重入动作；每步可安全重放 */
typedef struct {
    uint32_t magic;          /* IDLE / TESTING / RESUME 三态之一 */
    uint32_t progress_sec;   /* 已完成搬移的扇区游标 */
    uint32_t crc;
} swap_meta_t;

ota_err_t boot_swap_or_resume(void)
{
    swap_meta_t m = meta_load();
    switch (m.magic) {
    case MAGIC_RESUME:                    /* 掉电续传：从断点扇区重放 */
        return swap_from_sector(m.progress_sec);
    case MAGIC_TESTING:                   /* 试运行未确认 → 回滚旧版 */
        return image_hash_ok(SLOT0) ? OTA_OK : swap_revert();
    default:
        return image_hash_ok(SLOT0) ? OTA_OK : OTA_NO_IMAGE;
    }
}
/* swap_from_sector 内部：每搬完一扇区，先落盘 progress_sec 再动下一扇区 */
```

## 预防措施
- 断电注入测试覆盖每个扇区边界与每条状态转移边
- 元数据独立扇区 + 双副本 + CRC，写入前先擦后校验
- 永远保留回滚路径：TESTING 未确认即还原旧镜像
- magic 取值避开 0xFFFFFFFF/0x00000000，防擦除态混淆
- 优先采用 MCUboot 成熟实现，不自造 swap 协议

## 关联
- 源章节：[[ch30-Bootloader-IAP-OTA固件升级体系]]
- 相关章节：[[ch89-P3-MCUboot双分区OTA安全升级系统]]、[[chsa-S1安全架构与SecureBoot实战]]
