---
title: "TC27 密文被离线破解：CTR 模式 nonce 重用了"
tags:
  - troubleshooting
  - security/crypto
severity: high
frequency: occasional
source: "[[chfj-A10轻量加密编码XTEA-AES-HMAC-RLE]]"
date: 2025-01-15
---
# TC27 AES-CTR nonce 不回退设计

## 现象
加密的固件包/遥测被推导出明文或被定向篡改；事后审计发现同一密钥下出现重复 nonce——两段密文异或即得两段明文异或，已知其一全泄其二。

## 环境与适用范围
适用 AES-CTR/ChaCha20 流密码场景（OTA 包加密、日志加密、遥测上报）。裸 CTR 无认证，还可被 bit-flipping 定向篡改明文。

## 取证过程
1. 提取设备全部 nonce 序列排序查重——出现重复即实锤密钥流重放。
2. 审计 nonce 来源：RTC？RAM 计数器？掉电重启后是否回退或清零？
3. 复现攻击：取两条同 nonce 密文 C1⊕C2，与已知明文对照验证 two-time pad。
4. 检查完整性：翻转密文某比特并重放，观察解密端是否照单全收（裸 CTR 无 MAC）。
5. 评估存储介质：计数器存放区是否具备掉电保持与原子更新能力。

## 根因
流密码密钥流 = E(key, nonce‖ctr)。(key,nonce) 重复 ⇒ 密钥流重复 ⇒ C1⊕C2=P1⊕P2。嵌入式常见诱因：RTC 掉电回拨、计数器存 RAM 重启归零、双分区各自计数撞车。

## 修复方案
```c
/* 双保险：64bit 单调计数器(NVM 双页乒乓) + 32bit 安装纪元 */
bool next_nonce(uint8_t nonce[12])
{
    uint64_t ctr = nvm.counter + 1;
    if (ctr <= nvm.max_used)   return false;      /* 检测回退：拒答 */
    if (!nvm_commit_pair(&ctr)) return false;     /* 原子落盘防撕裂 */
    write_le64(nonce, ctr);
    write_le32(nonce + 8, nvm.install_epoch);     /* RTC 仅作下限参考 */
    return true;
}
/* 更优：改用 AES-GCM / ChaCha20-Poly1305(AEAD)，
   同时解决机密性与防篡改 */
```

## 预防措施
- 方案评审必答题：nonce 唯一性在掉电/重启/双分区下如何保证
- 计数器双页乒乓 + 页尾 CRC，新页校验通过再翻指针
- 禁止裸 CTR，一律 AEAD；nonce 空间按密钥隔离
- 密钥轮换时同步重置计数器（唯一性约束是 key‖nonce 二元组）
- 固件内置 nonce 单调自检，异常拒绝出数并告警

## 关联
- 源章节：[[chfj-A10轻量加密编码XTEA-AES-HMAC-RLE]]
- 相关章节：[[chsb-S2密钥管理与安全元件ATECC608]] [[ch89-P3-MCUboot双分区OTA安全升级系统]]
