---
title: "第S1章 安全架构与Secure Boot实战"
part: "[[P10-MOC]]"
chapter: "S1"
tags:
  - domain/security
  - topic/secureboot
difficulty: 4
est_minutes: 40
prerequisites:
  - "[[ch92-P6-OpenWrt定制路由器全志H3]]"
related:
  - "[[ch89-P3-MCUboot双分区OTA安全升级系统]]"
  - "[[ch38-SoC启动链深度剖析]]"
  - "[[ch63-网络编程与TLS从socket到安全上云]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第S1章 安全架构与Secure Boot实战

> [!info] 导航
> ⏱ 40min | ★★★★☆ | 前置 [[ch92-P6-OpenWrt定制路由器全志H3]] | → [[chsb-S2密钥管理与安全元件ATECC608]]

## 🎯 学习目标
- [ ] 能用 STRIDE 方法为产品画出物理/网络/供应链三类攻击面的威胁模型
- [ ] 说清 ROM→SPL→U-Boot→Kernel 逐级验签信任链的断链原理
- [ ] 完成 MCUboot 镜像签名，并验证「改 1bit 即拒启」
- [ ] 掌握 i.MX HAB 四步签名流程概览与 eFuse 烧写风控 SOP

## S1.1 威胁建模入门（先想清楚防谁）
安全设计第一步不是加锁而是画图。攻击者视角下设备只有三类攻击面：**摸得到的（物理）、连得上的（网络）、买得到的（供应链）**。简版方法用 STRIDE 六元法逐接口过一遍：Spoofing 仿冒 / Tampering 篡改 / Repudiation 抵赖 / Information Disclosure 信息泄露 / DoS 拒绝服务 / Elevation of Privilege 提权。落到工程就是下面这张速查表。

| 攻击面 | 典型手法 | 防御锚点 |
|--------|----------|----------|
| 物理接触 | SWD 读固件、Fault 注入提权、拆片读 Flash | RDP+JTAG 锁、Flash 加密、主动屏蔽罩、传感器检测 |
| 网络远程 | OTA 劫持、协议漏洞利用、凭证重放 | 签名 OTA（见 [[ch89-P3-MCUboot双分区OTA安全升级系统]]）、TLS 双向认证（[[ch63-网络编程与TLS从socket到安全上云]]）、最小权限服务 |
| 供应链 | 构建机投毒、第三方库后门、代工厂泄密 | 可复现构建+签名验发、SBOM 审计、密钥不出 HSM |

## S1.2 硬件信任根与逐级验签信任链
硬件信任根（Root of Trust, RoT）= 芯片内**不可软件篡改的第一段代码（BootROM）+ 不可改写的公钥哈希（eFuse/OTP）**。信任链原则：每一级固件先验签再放行下一级——

1. **BootROM**（出厂固化）：用 eFuse 中 SRK 公钥哈希验 SPL；
2. **SPL**：初始化 DRAM 后验 U-Boot proper；
3. **U-Boot**：用 FIT 镜像内嵌公钥验 Kernel+DTB；
4. **Kernel/App**：dm-verity 或 MCUboot 二次校验业务镜像。

任何一级被替换都会在下一级的验签处断链，攻击面被压缩为「只能执行已验证代码」。启动链细节参见 [[ch38-SoC启动链深度剖析]]。

## S1.3 关键代码：路线 A · MCUboot 签名全链（推荐起步）
```bash
# ① 密钥生成(离线机！)
imgtool keygen -k root-ec-p256.pem -t ecdsa-p256
# ② 镜像签名(版本+依赖声明)
imgtool sign --key root-ec-p256.pem --header-size 0x200 \
  --align 4 --version 1.2.3 --header "MYPRODUCT" \
  --dependencies "(0, 1.2.2)" app.bin signed-app.bin
# ③ 设备端：bootloader 内置公钥哈希比对 → 哈希一致才验签 → 通过才跳转
# ④ 升级链复用 ch89：签名覆盖到 slot 校验全程
# 验证手段：改镜像 1bit → 设备拒绝启动并在日志给出 BAD SIGNATURE
```

要点：私钥只存在于离线签名机；`--version` 必须单调递增；`--dependencies` 声明对其他镜像版本的依赖，防止「新 App 配旧 Boot」的组合漏洞。

## S1.4 路线 B · i.MX HAB 四步签名流程概览
```text
① SRK Table：4 把公钥哈希烧入 eFuse(不可逆！先在评估板演练全流程)
② CSF 文件：描述「验证哪些区段」的签名脚本 → CST 工具生成签名块
③ 关闭 open config：BT_FUSE_SEL 等保险丝置位后 ROM 强制验签
④ 分级策略：快速启动需求下只验 SPL/U-Boot，内核由 U-Boot 继续验(FIT)
⑤ 救砖预案：保留 Serial Download 模式可用性 vs 安全性的产品决策
—— 任何一步出错都可能永久变砖：先写 SOP 再动保险丝。
```

## S1.5 eFuse/OTP 烧写风险控制
1. eFuse/OTP 是一次性可编程（One-Time Programmable），**烧错不可回收**——任何保险丝操作前先在评估板完整演练全流程；
2. SRK Table 烧入前双人复核：哈希来源、字节序、槽位顺序逐项核对；
3. 关闭 open config 前，「Serial Download 救砖模式保留与否」必须成文为产品决策而非工程师现场拍板；
4. SOP 三要素缺一不可：步骤、判据、回退预案。

## S1.6 参数调试技巧
| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 合法镜像被拒启 BAD SIGNATURE | 读 bootloader 串口日志定位失败阶段 | 核对 header-size/align 与分区表定义一致 | 同一镜像在参考板通过 |
| 新版本也被拒绝 | dump image header 查 version/dependencies | imgtool 版本号递增、依赖声明满足 | 版本单调递增策略生效 |
| 开启验签后启动明显变慢 | GPIO 翻转打点各阶段耗时 | 只验 SPL/U-Boot，内核交 U-Boot FIT 验 | 启动增量 ≤100ms（典型值） |

## S1.7 实测数据表：各防护层的成本账
| 措施 | Flash/RAM 成本 | 性能影响 | 挡住什么 |
|------|----------------|----------|----------|
| MCUboot 签名校验 | +16KB code | 启动 +80ms | 恶意固件植入 |
| Flash 读保护 RDP2 | 0 | JTAG 永失（权衡！） | 现场读码克隆 |
| TLS mTLS | +40KB/25KB RAM | 握手 ~70ms(EC) | 伪造设备接入 |
| MPU 五区域 | 0(配置) | <1% | 越权访问/栈溢出提权 |

## S1.8 运行时防护三板斧
1. **内存防护**：MPU 划栈哨兵/外设特权区/代码只读（模板见 [[ch21-Cortex-M架构精讲]]）；A 核用 SELinux 域；
2. **通信防护**：所有对外接口输入过「长度+类型+CRC/签名」三门；日志脱敏；
3. **可观测性**：异常重启计数、fault 日志上云——被攻击时的可见性就是响应速度。

## S1.9 排故速查表
| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 烧完 SRK 后永久变砖 | SRK 哈希与实际签名私钥族不匹配 | Serial Download 回读 fuse 值与 CST 生成物比对；无救砖通道只能返厂换片 |
| open config 未关导致验签被绕过 | BT_FUSE_SEL/SEC_CONFIG 未熔丝 | 读 fuse map 状态位；按 SOP 补烧并重放全部攻击用例回归 |
| Fault 注入跳过验签分支 | 敏感条件判断单点依赖 | 敏感分支双读比较；高端方案用双核锁步/电压传感器 |
| OTA 包被中间人替换仍刷入成功 | 仅本地校验，下载通道未验签 | 复核下载器是否先校验 manifest 签名再落盘 |

## S1.10 部署注意事项
1. 签名私钥只在离线机/HSM 出现，CI 构建仅持公钥做验发；
2. 量产前把「JTAG 锁死 vs 售后可维修性」写成显式决策记录；
3. 对外接口输入一律过三门校验，日志脱敏防信息泄露；
4. 异常重启计数与 fault 日志接监控上云；
5. 固件升级体系与 [[ch30-Bootloader-IAP-OTA固件升级体系]] 统一规划，避免两套引导并存打架。

> [!example]- 🧪 动手实验 LS1-1：红队视角攻破自己的旧固件（90 分钟）
> **步骤**：① 取一个未加防护的项目版本；② 尝试 JTAG dump 全 Flash、串口 shell 提权、伪造 OTA 包替换三条路径；③ 记录每条攻击路径的成功点；④ 逐项部署本章对策后重放全部攻击验证拦截；⑤ 输出攻防矩阵报告。
> **验收**：所有历史攻击路径均被拦截且报告留档——这份攻防矩阵就是你安全能力的最佳名片。

## S1.11 进阶话题
- **Fault Injection 的现实威胁**：电压毛刺让条件判断翻转——高端用双核锁步/传感器，中端至少做敏感分支双读比较；
- **Side-channel 入门意识**：功耗曲线泄露 AES 轮密钥——对称运算优先用带掩码的硬件加速器；
- **漏洞响应流程（SVPP）**：披露渠道/CVSS 定级/补丁 SLA——产品化安全的最后一环是流程不是代码。

> [!warning]- ❓ FAQ
> **Q1：MCU 产品选 MCUboot 还是芯片厂商安全启动？** 有 ROM 级验证的 SoC（如 i.MX HAB）走厂商路线；裸 MCU 从 MCUboot 起步，工具通用且可与 ch89 的 OTA 体系无缝衔接。
> **Q2：RDP2 之后还能返修吗？** JTAG 永久失效即失去调试返修能力，是否留返修通道是产品决策——量产前必须在 SOP 里写清。

> [!question] 📝 思考题
> 1. 为你当前的产品画「三类攻击面 × STRIDE」矩阵，标出未设防项并排优先级。
> 2. 若 SRK 私钥丢失，已出货设备的 OTA 体系如何自救？推演一遍。

---
🏷️ #安全 #SecureBoot #eFuse #MCUboot #威胁建模 | 🔗 [[ch92-P6-OpenWrt定制路由器全志H3]] ← **本章** → [[chsb-S2密钥管理与安全元件ATECC608]] | 📚 [[P10-MOC]]
