---
title: "A10 轻量加密与数据编码：XTEA / AES-CTR / HMAC / RLE"
part: "[[P11-MOC]]"
chapter: "A10"
tags:
  - domain/algorithms
  - topic/crypto
difficulty: 4
est_minutes: 40
prerequisites:
  - "[[chfi-A9信号处理FFT-Goertzel-NTC-SOC融合]]"
related:
  - "[[chsa-S1安全架构与SecureBoot实战]]"
  - "[[chsb-S2密钥管理与安全元件ATECC608]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# A10 轻量加密与数据编码：XTEA / AES-CTR / HMAC / RLE

> [!info] 导航
> ⏱ 40min | ★★★★☆ | 前置 [[chfi-A9信号处理FFT-Goertzel-NTC-SOC融合]] | → [[chfk-A11机器人导航定位建图路径规划]]

## 🎯 学习目标
- [ ] 按资源档位在 XTEA 自研与 AES-CTR/mbedTLS 裁剪间正确选型
- [ ] 设计 nonce 单调不回退方案(计数器+RTC 下限双保险)并用断电实验验证
- [ ] 用标准 HMAC 做认证避开长度扩展攻击；用 RLE/Delta+Varint 瘦身遥测 ≥50%

## A10.1 对称加密两条路线

| 路线 | 代表 | 体积/RAM | 安全等级 | 适用 |
|------|------|----------|----------|------|
| 轻量分组 | XTEA(64bit 块,32 轮) | <1KB code/几十 B RAM | 学术级(非认证标准) | 防顺手读取的低敏数据 ★勿用于支付类 |
| **AES-CTR(mbedTLS 裁剪)** | AES-128 计数模式流加密 | ~8KB/~1KB | 工业标准 | **默认推荐 ★** |

## A10.2 关键代码：XTEA 参考实现（教学/低敏场景）

```c
#define XTEA_ROUNDS 32
void xtea_enc(uint32_t v[2], const uint32_t k[4]){
    uint32_t v0=v[0],v1=v[1],sum=0;
    const uint32_t delta=0x9E3779B9;
    for(int i=0;i<XTEA_ROUNDS;i++){
        v0+=(((v1<<4)^(v1>>5))+v1)^(sum+k[sum&3]); sum+=delta;
        v1+=(((v0<<4)^(v0>>5))+v0)^(sum+k[(sum>>11)&3]);
    }
    v[0]=v0; v[1]=v1;
} /* 解密镜像逆序即可。块仅 64bit——大文件请走 AES-CTR */
```

## A10.3 AES-CTR 流密码本质与三条纪律

本质：用 AES 把「Nonce‖Counter」变成高质量密钥流再与明文 XOR——分组密码当随机数发生器用，与一次性密码本同构；解密=同一过程对称，加解密共用一套代码。调用：`mbedtls_aes_setkey_enc(&a,key,128)` 后 `mbedtls_aes_crypt_ctr(&a,len,&off,nonce_iv,stream,xor_in,out)` 两行搞定。**安全性完全依赖 nonce 绝不重复**，三条纪律：
1. IV/Nonce 绝不复用！同 key 下重用 nonce=密码学自杀——组合 `device_id(4B)‖boot_counter(4B)‖seq(8B)` 保证唯一；
2. CTR 只保密不认证 → 叠加截断 HMAC(A10.5)，或直接换 AES-GCM；
3. 密钥来自 [[chsb-S2密钥管理与安全元件ATECC608]] 注入路径而非代码常量。

## A10.4 Nonce 不回退设计：单调计数器+RTC 下限双保险

问题：boot_counter 存 Flash 断电回退→重启后 nonce 重复=灾难性密钥流重放。三级方案：

- 方案 A：计数器存 eFuse/OTP 区单调递增(硬件保证不回退)；方案 B：双页交替写+页内序号取大者——掉电任意时刻至少一页有效且更大；
- **方案 C ★推荐组合**：RTC 备份域保存运行值+上电时与 Flash 持久值取 max 再回写——两层保险；验证实验：升级中随机断电 100 次，每次重启后首帧 nonce 严格递增。

## A10.5 HMAC 认证边界与长度扩展攻击

朴素方案 `MD5(payload‖key)` 的死穴：SHA/MD5 类哈希的内部状态可被「接续」——攻击者拿到旧签名后无需知道 key 就能为恶意后缀造出合法签名。HMAC 的双层结构切断了这条路径：`HMAC=H((K⊕opad)‖H((K⊕ipad)‖msg))`——内外两次完整哈希，外层从内层摘要重新开始，状态无法接续。嵌入式一行调用 `mbedtls_md_hmac(md_info,key,key_len,msg,len,mac,32)`，截断 32~64bit 附于帧尾即可(高频小帧限速)。使用纪律：同一把 key 既加密又认证是误用——派生分离 `k_enc=HKDF(master,"enc")`、`k_mac=("mac")`；抗重放要求 HMAC 覆盖内容必含 seq/timestamp(ch74a 序号联动)，否则截获帧可无限重放。

## A10.6 组合帧格式定义与三道闸门（可直接抄进协议文档）

| 字段 | 大小(B) | 说明 |
|------|---------|------|
| HEADER 魔数+ver | 4 | ch74a 帧头规范,ver 留算法 agility |
| SEQ+TIMESTAMP | 2+4 | HMAC 覆盖内容的一部分(抗重放) |
| PAYLOAD(AES-CTR 密文) | n | Nonce 复用帧头 SEQ 派生避免额外字段 |
| MAC(HMAC-SHA256 截断) | 8~16 | 覆盖 HEADER..PAYLOAD 全部 ★置于 CTR 层之外 |
| CRC16 | 2 | 链路层快速检错,先于 MAC 过滤坏帧省 CPU |

处理顺序：收到先 CRC(便宜)→再 HMAC(贵)→最后才解密——三道闸门由廉到贵依次过滤。

## A10.7 安全启动摘要链设计

机密性与完整性各司其职：AES-CTR 加密固件包(保密)+ECDSA 签名(真实性与来源)，逐级构成信任链([[chsa-S1安全架构与SecureBoot实战]])：ROM Boot─验签─▶ BL(公钥/根哈希存 OTP 区) ─验签+摘要─▶ APP(双分区槽见 [[ch89-P3-MCUboot双分区OTA安全升级系统]]) ─▶ 运行期对关键镜像区周期性 HMAC 自检(S2 密钥)；任何一级校验失败→进入安全失败态，绝不跳转。原则：发布验证用非对称(ECDSA 可公开分发)，运行期完整性用对称(HMAC 快)；摘要链上每一环只信上一环给出的度量值。

## A10.8 无损编码三板斧与 Varint（遥测瘦身）

| 编码 | 机制 | 典型收益 | 场景 |
|------|------|----------|------|
| RLE 游程 | [值,重复数] 对 | 开关量日志 ×5~50 | IO 历史/状态记录 |
| Delta+Varint | 存差分,小数值变短字节 | 缓慢变化量 ×1.5~3 | 温度序列/GPS 轨迹 ★ |
| 位域打包 | 字段压到 bit 级(ch03 思想) | 固定 ×1.5~2 | 协议帧精打细算 |

**手算 Varint(300)**：300=100101100₂→低 7 位 0101100 有剩余高位→输出 0xAC；剩余高 2 位 10→输出 0x02。结果 `[0xAC,0x02]` 仅 2 字节(定长 uint32 要 4 字节)。温度 Δ×100 序列多落 ±63 内→单字节——LoRa 载荷 12B→4B 的真实案例(ch83 占空比预算救星)。编码规则：每字节低 7 位有效、最高位为续传标志(`while(v>=0x80){out[n++]=(v&0x7F)|0x80;v>>=7;} out[n++]=v;`)。RLE 前提是长游程，随机数据反而膨胀。

## A10.9 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 密文周期性重复出现 | 抓两帧同位置对比 | nonce 生成/持久化方案 | 同 key 下绝不重复 |
| 加密吞吐不足 | 收发打点计时 | 换 CRYP 硬件加速 | 余量≥3× 峰值带宽 |
| 压缩率不达标 | 压前压后字节数统计 | RLE 换 Delta+Varint | 遥测帧 ↓≥50%(目标) |

## A10.10 实测数据表：三种加密路线的资源与延迟（F407@168MHz）

| 方案 | Flash/RAM | 吞吐 | 备注 |
|------|-----------|------|------|
| XTEA 软件 | 0.9KB/48B | ~2MB/s | 教学与低敏场景 |
| AES-CTR mbedTLS(裁剪) | 7.8KB/1.2KB | ~1.1MB/s(软算) | +HMAC 后 ~0.7MB/s |
| AES 硬件加速(M4/M33 CRYP) | 驱动更薄 | **数十 MB/s** | 有硬件必用 ★ |

## A10.11 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 重启后首帧解密失败 | nonce 断电回退重复 | 落地 A10.4 双保险并复测断电 |
| 攻击者伪造合法后缀签名 | 用了拼接式 MD5(payload‖key) | 换标准 HMAC 结构 |
| 重放旧帧业务照收 | MAC 未覆盖 seq/timestamp | 认证范围纳入序号与时间戳 |
| grep 发现硬编码密钥 | 违反 S2 注入路径 | 移除字面量改运行时注入 |

## A10.12 部署注意事项

1. **密钥隔离审计**：grep 确认无硬编码密钥字面量；master key 只存在于 S2 体系注入路径；
2. **RAM 明文驻留最小化**：密钥用完立即清零、禁入全局缓冲与日志——存储禁区纳入代码评审清单；
3. **失败模式测试**：HMAC 校验失败必须静默丢弃并计数，绝不能进入业务解析器(fuzz 联动 S3 台架)；
4. **性能余量与演进**：吞吐留 3 倍余量、突发排队丢新保旧；帧 ver 预留算法 agility(AES-GCM/PQC 不破坏老设备解析)。

> [!example]- 🧪 动手实验 LA10-1：给 LoRa 载荷做一次「瘦身+护甲」（90 分钟）
> **步骤**：① 把 24B 遥测帧 Delta+Varint 压缩到 <12B 并写 Unity 回归；② 叠加 AES-CTR+截断 HMAC 形成完整安全帧；③ 统计压缩率与加解密耗时；④ 注入篡改一比特验证 MAC 拦截。
> **验收**：载荷 ↓≥50%、防篡改实测通过、总开销在占空比预算内([[ch83-LoRaWAN组网LoRaMac-node-ChirpStack]])。

## A10.13 进阶话题

- **随机源纪律**：nonce/密钥生成的熵来自硬件 TRNG+启动池搅拌——rand() 是娱乐工具不是密码学工具；
- **固件更新包双层**：AES-CTR 加密+ECDSA 签名(ch89/S1)——机密性与完整性各司其职；
- **真压缩时机**：RLE/Varint 是零成本第一层；需要更高压缩比再引入 tinf/miniz。

> [!warning]- ❓ FAQ
> **Q1：CTR 为什么只需要加密方向？**
> 计数器经 AES 正向生成密钥流再与明文 XOR；解密=密文⊕同一密钥流——分组密码当随机数发生器用。
> **Q2：MAC 为什么放在解密之外而不是之内？**
> 先认证避免对伪造密文执行解密逻辑；CRC→HMAC→解密由廉到贵依次过滤省 CPU。

> [!question] 📝 思考题
> 1. 手算 Varint(127) 与 Varint(16384) 的字节序列。
> 2. 画出 HMAC 双层结构，解释它如何阻断长度扩展攻击。
> 3. 推演 boot_counter 断电回退→密钥流重放的攻击链，并给出你的双保险设计。

---
🏷️ #domain/algorithms #topic/crypto #topic/hmac #topic/varint | 🔗 [[chfi-A9信号处理FFT-Goertzel-NTC-SOC融合]] ← **本章** → [[chfk-A11机器人导航定位建图路径规划]] | 📚 [[P11-MOC]]
