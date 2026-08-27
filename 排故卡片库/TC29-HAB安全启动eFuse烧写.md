---
title: "TC29 eFuse 烧错一次，整批板子永久变砖"
tags:
  - troubleshooting
  - security/secure-boot
severity: high
frequency: rare
source: "[[ch35-i-MX6U-ALPHA平台详解]]"
date: 2025-01-15
---
# TC29 HAB 安全启动 eFuse 烧写 SOP

## 现象
目标：i.MX 平台烧 SRK hash 启用 HAB 并关闭 open mode。风险动作不可逆——hash 算错、证书链配错或顺序颠倒，芯片将只认错误签名，任何镜像无法启动且无法返工。

## 环境与适用范围
适用 i.MX6/6UL/6ULL 系列 HABv4，工具链 CST(Code Signing Tool) + srktool + U-Boot(fuse/hab_status 命令)。无 OTP 的 MCU 不涉及。

## 取证过程（烧前风险核查）
1. 核对 SRK table：4 张 X.509 证书生成 table 后 `srktool -h 4 -t table.bin -e srk.efuse -d sha256` 得 32 字节 hash，双人复核。
2. Open 模式预验证：完全不碰 fuse，直接启动 CST 签名镜像；U-Boot `hab_status` 必须显示 No HAB Events——证明签名链正确。
3. 演练失败路径：故意用错误密钥签名镜像，确认 open 模式仅告警不阻断（此时板子仍可救）。
4. 烧写顺序铁律：先烧 SRK hash 8 个 word → 断电重启 → 复验签名镜像零事件、伪镜像被拦（SRK 已生效但仍 open）→ 最后一步才关 SEC_CONFIG。
5. 记录归档：serial 与 SRK hash 对应台账，私钥离线 HSM 保管，hash 三份异地备份。

## 根因
OTP 物理不可逆：SEC_CONFIG 关闭后 ROM 只信 SRK 匹配的签名镜像；SRK hash 本身烧错的板子无任何可启动镜像，等于报废。唯一防线是把不可逆动作放在一切验证之后。

## 修复方案
```text
U-Boot 烧写 SOP（bank/word 以所选型号 fusemap 与 AN4581 为准）
  # 第一步：烧 SRK hash（8 个 word，逐一 fuse read 回读核对）
  => fuse prog 0 6 0xAAAAAAAA    # SRK_HASH[0]
  => ...                         # SRK_HASH[1..7]
  # 第二步：断电重启，签名镜像 hab_status => No HAB Events
  # 第三步(最后且唯一不可逆步骤)：
  => fuse prog 1 3 0x02000000    # SEC_CONFIG[1]=1, ROM 进入 closed
  # 第四步：再断电重启，确认仅正确签名镜像可启动
红线：SEC_CONFIG 烧写必须独立工位人工确认，绝不并入批量脚本
```

## 预防措施
- 先 open 全流程验证、后永久烧写，中间隔一次断电重启
- SRK 私钥 HSM 离线保管；hash 三备份异地存放
- 产线脚本禁止一键连烧：SEC_CONFIG 独立工位 + 双人复核
- 每批次首件全流程验证后再放量
- 常备未锁定开发板作对照与事故演练

## 关联
- 源章节：[[ch35-i-MX6U-ALPHA平台详解]]
- 相关章节：[[chsa-S1安全架构与SecureBoot实战]] [[ch38-SoC启动链深度剖析]] [[chsd-S4-量产工程产测工装与老化]]
