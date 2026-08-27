---
title: "第89章 P3 · MCUboot 双分区 OTA 安全升级系统"
part: "[[P9-MOC]]"
chapter: 89
tags:
  - domain/mcu
  - topic/bootloader
  - topic/security
difficulty: 4
est_minutes: 45
prerequisites:
  - "[[ch30-Bootloader-IAP-OTA固件升级体系]]"
related:
  - "[[ch72-A-B-OTA升级与Recovery体系]]"
  - "[[ch74a-自研二进制协议设计规范]]"
  - "[[chsa-S1安全架构与SecureBoot实战]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第89章 P3 · MCUboot 双分区 OTA 安全升级系统

> [!info] 导航
> ⏱ 45min | ★★★★☆ | 前置 [[ch88-P2-ESP32S3桌面信息站WiFi工具箱]] | → [[ch90-P4-LoRa温湿度采集网关ChirpStack后端]]

## 🎯 学习目标
- [ ] 交付支持 ECDSA 签名验证、自动回滚、断电安全的完整 OTA 底座（F407 + MCUboot）
- [ ] 打通「云端打包→设备下载→验证升级」端到端链路
- [ ] 用掉电注入 ×50 与篡改攻击测试证明链路安全，沉淀可复用 OTA 中间件

## 89.1 架构总览：Flash 布局与升级全流程

```text
Flash 布局(F407 1MB)：
 [boot 48K][slot0 432K][slot1 432K][scratch 64K][param 16K]
核心流程：
 App 运行中收固件 → 校验包头 → 写 slot1 → param 标 TEST
 → 重启 → MCUboot 验签(ECDSA-P256)+哈希 → swap 交换两 slot
 → 新固件自检 OK 后 imgtool confirm → 否则 N 次重启内自动 revert
密钥管理： 私钥离线 HSM 保管；设备烧录公钥哈希防替换
```

## 89.2 关键实现代码

```bash
# 云端打包：签名 + 版本依赖声明（低于 1.2.3 的设备才允许升级到本镜像）
imgtool sign --key key.pem \
    --header-size 0x20000 --align 4 --version 1.2.4 \
    --dependencies "(0, 1.2.3)" \
    --pad-header app.bin signed-app.bin
```

```c
/* 新固件首启自检通过后主动 confirm；不 confirm 则 MCUboot 计 reboot loop，
   超阈值自动 revert 回 slot0 —— 坏固件业务中断 <60s */
int main(void)
{
    if (self_test())                     /* 外设/存储/业务基线自检 */
        boot_write_img_confirmed();      /* 确认新镜像，取消 revert */
    else
        NVIC_SystemReset();              /* 自检失败复位触发回滚 */
    app_run();
}   /* 下载通道：分块+CRC+断点续传（帧格式见 ch74a） */
```

## 89.3 关键挑战与解法

| 挑战 | 解法要点 |
|------|----------|
| swap 中断电一致性 | swap 算法在 param 区写状态机日志、每步幂等——移植时严格保留 trailer 结构 |
| F407 扇区大擦写慢 | 下载阶段边收边写 slot1（扇区对齐缓冲），重启后才校验，用户无感 |
| 传输通道可靠性 | 分块+CRC+断点续传（Ymodem 或 [[ch30-Bootloader-IAP-OTA固件升级体系]] 自研协议二选一） |
| 多版本依赖管理 | imgtool dependencies 字段 + 设备端版本比较逻辑 |

## 89.4 测试矩阵与里程碑验收门（安全关键）

| 门 | 注入/验证项 | 通过判据 |
|----|-------------|----------|
| M1 | 正常升级 ×20 | 成功率 100% |
| M2 | 篡改镜像 1bit / 版本降级攻击 | 验签拒绝不污染 slot0；被 dependencies 拒绝 |
| M3 | 每个擦写间隙掉电注入 ×50 | 全部正确恢复或续传 |
| M4 | 坏固件（启动即死循环） | revert 自动回滚，业务中断 <60s |

## 89.5 实测数据表：升级链路性能账（256KB 镜像，ESP32-S3 WiFi）

| 阶段 | 耗时 | 占比 |
|------|------|------|
| 下载（TCP 247MTU） | 8.2s | 71% |
| 写入 Flash（边收边写） | 1.9s | 16% |
| SHA256+ECDSA 校验 | 0.9s | 8% |
| 切换重启到新系统 | 0.6s | 5% |

用户感知 = 下载+重启 ≈ 9s——达到「无感升级」体验线（<15s）。信任链向首次上电延伸即 Secure Boot，见 [[chsa-S1安全架构与SecureBoot实战]]。

## 89.6 安全审计视角的自检清单

1. **密钥生命周期**：生成（离线 HSM）→分发（U 盘专人）→使用（设备内不可导出）→轮换（版本化公钥双活）→吊销（黑名单固件）；
2. **降级攻击面**：版本单调计数器存 OTP；镜像 dependencies 链完整校验；
3. **调试后门治理**：量产关闭 JTAG（RDP Level 2 权衡）、移除测试命令、日志脱敏；
4. **供应链完整性**：构建机加固+产物哈希签名+发布通道 HTTPS 固定证书。

## 89.7 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 验签总是失败 | 打印 header/tlv 解析 | header-size/align 与分区表不一致 | imgtool 参数与布局对齐 |
| 反复 revert 不停机 | 读 param 区状态机日志 | 自检过严或 confirm 未执行 | confirm 后不再回滚 |
| 掉电后 slot 数据错乱 | 比对 trailer 结构 | 是否改动 param/trailer | 幂等恢复一致状态 |
| 断点续传失败 | 抓分块序号与 CRC | 断点粒度与扇区对齐缓冲 | 从断点继续零重复 |

## 89.8 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| MCUboot 不识别新镜像 | 魔数/哈希 TLV 缺失 | hexdump slot1 头部比对 imgtool 输出 |
| revert 后旧版本也异常 | swap 被强断电未走完状态机 | 检查 param 区状态是否每步落盘 |
| 下载速率上不去 | 每块同步等 ACK | 流水线发送+窗口确认（[[ch74a-自研二进制协议设计规范]]） |
| 公钥轮换后老设备拒升 | 公钥未双活过渡 | 先发带新公钥的过渡版本再切签名钥 |

> [!example]- 🧪 动手实验 L89-1：把你的 OTA 系统做成「红蓝对抗」靶场（90 分钟）
> **步骤**：① 红队任务：篡改镜像 1 字节 / 重放旧包 / 中间人替换下载源 / 伪造高版本号，各尝试攻破；② 记录每次攻击被哪一层拦截（或得手）；③ 对得手项补防御并回归测试；④ 输出攻防对照表。
> **验收**：四类攻击全部被拦截且攻防对照表完整——这张表就是安全能力的证明材料。

## 89.9 开源对照

| 项目 | 对照收获 |
|------|----------|
| MCUboot 官方文档与 Zephyr 集成示例 | 工业标准实现；swap move 算法论文级注释可精读 |
| STM32 X-CUBE-SBSFU | ST 官方安全启动方案，对比设计取舍 |
| RAUC（Linux 侧） | 同思想在 Linux A/B 的实现，跨域印证 [[ch72-A-B-OTA升级与Recovery体系]] |

## 89.10 进阶话题

- **A/B vs 单 slot 备份压缩成本模型**：双 slot 用空间换安全；单 slot+压缩换空间但窗口期风险高——按 Flash 富余度决策；
- **灰度发布机制**：云端按设备指纹百分比放量+失败率熔断回滚——OTA 平台侧必修能力。

> [!warning]- ❓ FAQ
> **Q1：为什么重启后才做整体校验？** F407 扇区大擦写慢，把 SHA256+ECDSA 放到 bootloader 阶段（实测仅占 8%）换来下载期用户无感。
> **Q2：RDP Level 2 权衡是什么？** 关 JTAG 后现场排障只能靠日志——量产防读取与开发便利不可兼得，按产品阶段切换。

> [!question] 📝 思考题
> 1. 推演 scratch 区不足时的 swap-without-scratch 策略开销。
> 2. 若 Flash 只有单 slot 空间，「备份+压缩」变通方案及风险？
> 3. 把本系统适配 ESP32-S3 的 ota_0/ota_1 分区表需要动哪些层？

---
🏷️ #domain/mcu #topic/bootloader #topic/security | 🔗 [[ch88-P2-ESP32S3桌面信息站WiFi工具箱]] ← **本章** → [[ch90-P4-LoRa温湿度采集网关ChirpStack后端]] | 📚 [[P9-MOC]]
