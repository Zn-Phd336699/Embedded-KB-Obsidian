---
title: "第76章 I2C 协议与排障：时钟拉伸、总线锁死与多主机"
part: "[[P8-MOC]]"
chapter: 76
tags:
  - domain/protocol
  - topic/i2c
difficulty: 4
est_minutes: 45
prerequisites:
  - "[[ch75-UART-RS485与Modbus-RTU实战libmodbus]]"
related:
  - "[[ch19-逻辑分析仪与sigrok]]"
  - "[[ch26-DMA与Cache一致性]]"
  - "[[ch77-SPI-QSPI与Flash驱动JEDEC-XIP磨损均衡]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第76章 I2C 协议与排障：时钟拉伸、总线锁死与多主机

> [!info] 导航
> ⏱ 45min | ★★★★☆ | 前置 [[ch75-UART-RS485与Modbus-RTU实战libmodbus]] | → [[ch77-SPI-QSPI与Flash驱动JEDEC-XIP磨损均衡]]

## 🎯 学习目标
- [ ] 精读 START/ACK/NACK/时钟拉伸的电气与协议含义
- [ ] 背下总线卡死九步解锁法并落地恢复子程序
- [ ] 会按总线电容计算上拉电阻并用工具链实操排障

## 76.1 协议核心机制精读
| 机制 | 细节 | 工程含义 |
|------|------|----------|
| START/STOP | SCL 高电平期间 SDA 变化=唯一合法控制时刻 | 其他时刻 SDA 变化=数据错乱(干扰指纹) |
| 数据有效窗口 | 数据在 SCL 低电平变化、高电平必须稳定 | 抓波形判错的第一依据 |
| ACK/NACK | 第 9 个时钟从机拉低=ACK | NACK 含义：地址不存在/寄存器满/主机读末字节发 NACK 终止 |
| 时钟拉伸 Clock Stretching | 从机拉住 SCL 低不放迫使主机等待 | 部分主机硬件不支持→读错位！EEPROM 写周期常见 |
| 重复 START Sr | 不释放总线直接重新起始 | 原子读(写地址+读数据)必需，防多主插队 |
| 地址 | 7 位+读写位；10 位罕见 | i2cdetect 显示原始表：0x3C 的 OLED 显示为 0x78 |

## 76.2 总线锁死机理与九步解锁 SOP
现象：SDA 被某从机钳在低位，主机无法产生 START。根因：从机在读数据中途被主机复位，还欠 N 个 bit 没吐完。

```text
① 主机先关 I2C 外设，引脚切 GPIO
② SCL 手动输出 9 个时钟脉冲（让从机吐完当前字节）
③ 若 SDA 已释放 → 完成；未释放再发一个 STOP 条件
④ 仍不行：断电重启该器件电源（设计上预留 PMOS 开关 ★）
⑤ 都不行：断整板电 —— 说明硬件缺电源开关，记入整改
预防设计三原则：
· 所有 I2C 器件纳入可控电源域或带 RESET 引脚；驱动初始化前先跑解锁序列
· 上拉电阻按总线电容计算(2.2k~4.7k@3.3V 常规)，别贪强上拉烧灌电流
```

## 76.3 总线恢复子系统关键代码（可直接抄）
```c
/* 在任何 I2C 外设初始化前调用；GPIO 编号按板级配置 */
int i2c_bus_recover(int scl_gpio, int sda_gpio)
{
    gpio_request_as_output(scl_gpio); gpio_set(scl_gpio, 1);
    gpio_request_as_input(sda_gpio);
    if (gpio_get(sda_gpio)) return 0;           /* 总线健康，直接返回 */
    for (int i = 0; i < 9; i++) {               /* 最多放出一个字节(9bit) */
        gpio_set(scl_gpio, 0); udelay(5);
        gpio_set(scl_gpio, 1); udelay(5);
        if (gpio_get(sda_gpio)) break;          /* SDA 已释放 */
    }
    /* 手工发一个 STOP：SCL 低时拉低 SDA → 拉高 SCL → 拉高 SDA */
    gpio_dir_out(sda_gpio); gpio_set(sda_gpio, 0); udelay(5);
    gpio_set(scl_gpio, 1);   udelay(5);
    gpio_set(sda_gpio, 1);   udelay(5);
    return gpio_get(sda_gpio) ? 0 : -EBUSY;
}
/* 配套硬件要求见九步法预防三原则——软件救不了没电源开关的设计 */
```

## 76.4 Linux 工具链与高速长线扩展
```bash
i2cdetect -y -r 1                # 扫描总线1(-r 读探针更安全)；UU=驱动占用
i2cget -y 1 0x48 0x00 w          # 读温度传感器寄存器(word)
i2cset -y 1 0x48 0x01 0x60       # 写配置寄存器
i2ctransfer -y 1 w2@0x48 0x00 r2 # 组合事务：写2再读2(Sr 原子操作!)
```
- **用户态**：/dev/i2c-1 + ioctl(I2C_SLAVE/I2C_RDWR)，封装成 ch08 的 sensor_itf 抽象。
- **提速/延长**：FM 400kHz 复核上升沿<300ns(ch18 闭环)、1MHz 以上用有源缓冲 P82B96；I2C 是板级总线，超 30cm 用 P82B715 缓冲或转 RS485/CAN。
- **多主**：协议支持仲裁(SDA 丢失检测)，但工程上强烈建议单主制+复用器 TCA9548A 分域——两台 MCU 抢同一条 I2C，九成该重新划分职责。

## 76.5 案例：BMS 电池包星型拓扑翻车与重生
```text
背景：12 串电池包，BQ40Z80(主)+12 片监控芯片挂同一条 I2C，线长 30cm 星型。
症状：满充瞬间整条总线锁死概率 5%。
取证(ch19)：锁死帧=某监控芯片在广播写中被打断(BMS 主控复位)。
根因叠加：① 30cm 星型走线 Cb≈600pF 远超 400pF 上限→边沿劣化抗扰差
         ② 无从机电源管理→复位窗口必锁
重生方案：拓扑改菊花链+每片前加 P82B715 缓冲(分段电容)；主控复位前跑九步解锁；
         监控芯片供电加 PMOS 可控；上位轮询加 ack-polling 与 CRC(SMBus PEC)。
结果：连续 500 次满充循环零锁死。「I2C 出问题先画拓扑图量电容」排在换代码前面。
```

## 76.6 参数调试技巧
| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 边沿爬升慢 | 示波器测上升时间 tr(ch18) | 减小 Rp 或降速/减电容 | tr<300ns@FM 标准 |
| 从机拉长时钟致读错 | 分析仪看非主机产生的 SCL 低脉冲 | 换支持 stretch 的控制器或降速 | 连续读写零错位 |
| EEPROM 写后读旧值 | 写后轮询 ACK(忙时 NACK) | ack-polling 再读 | tWC(~5ms) 后读到新值 |

## 76.7 实测数据表：上拉电阻 × 总线电容边沿实测（3.3V 系统）
| Rp\Cb | 50pF(板内) | 200pF(带线缆) | 400pF(长线) |
|-------|------------|----------------|--------------|
| 10kΩ | 1.1µs ✗FM | 4.4µs ✗ | — |
| 4.7kΩ | 0.5µs ✓ | 2.1µs ✗FM/✓SM | — |
| 2.2kΩ | 0.24µs ✓ | 0.95µs ✓ | 1.9µs ✗ |
| 1kΩ | 0.11µs ✓ | 0.44µs ✓ | 0.9µs 边缘 |

✓ = <300ns(FM 标准)；灌电流校验下限：Rp ≥ VDD / VOL 最大灌电流(3mA) ≈ 1.1kΩ。

## 76.8 排故速查表
| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 扫描不到任何地址 | 上拉缺失/供电未上/SDA-SCL 接反 | 万用表量空闲电平应为 VDD；示波器看有无启动尝试 |
| 偶发读数错位半个字节 | 主机不支持 clock stretching 遇慢从机 | 分析仪看 SCL 非主机低脉冲；换控制器或降速 |
| 多传感器同址冲突 | 地址硬编码相同 | 查 datasheet ADDR 引脚分档；或 TCA9548A 分通道隔离 |
| 总线整体卡死 | 从机中途被复位欠 bit 未吐完 | 九步解锁 SOP(76.2)；查电源管理设计 |

## 76.9 部署注意事项
1. 所有 I2C 器件纳入可控电源域(PMOS 开关)或引出 RESET 引脚——这是解锁的最后底牌。
2. 驱动初始化前固定跑一遍 bus_recover()，做成平台标配子程序；上拉按 76.7 表选型并留灌电流校验。
3. I2C 非热插拔总线：带电插拔从机的浪涌会钳死总线——从机侧 TVS+串联 100Ω，主机侧每次事务前做健康探测。

> [!example]- 🧪 动手实验 L76-1：把卡死的总线亲手救活两次（50 分钟）
> **步骤**：① 在从机读中途用看门狗复位主机制造卡死；② 万用表确认 SDA 被钳位；③ 跑 76.3 恢复函数验证 SDA 回高；④ 第二次制造后改走「PMOS 断电」路径对比耗时；⑤ 把两种方案的时间与成本写进设计评审记录。**验收**：两种救法都成功且你能说清各自的适用边界。

## 76.10 进阶话题
- **从机模式与 DMA 三大坑**(STM32)：①时钟拉伸默认开启，上位机不支持就读错位(H7 可配 NO_STRETCH)；②ADDR 中断内必须预装载首字节响应，等 TXE 来不及→主机读全 FF；③DMA 循环接收时 STOP 前残留长度用 NDTR 推导(ch26 同款技巧)。
- **SMBus/PMBus**：I2C 的工业/电源子集，报文尾附加 CRC-8(poly 0x07) PEC 与超时规范，服务器电源/电池管理强制项；STM32 硬件 PEC 可自动追加。
- **热插拔与单测**：ARP 动态地址分配了解即可；内核 i2c-stub 模块虚拟从机做主机驱动单元测试(ch09 联动)。
- **I3C 前瞻**：向下兼容 I2C 器件、带内中断、12.5Mbps+——新设计选传感器开始关注双协议器件。

> [!warning]- ❓ FAQ
> **Q1：多主机仲裁协议既然支持，为什么工程上不建议用？** 协议支持≠应该用——复杂度应留在拓扑层(TCA9548A 分域)解决。
> **Q2：为什么写 EEPROM 后立刻读回的是旧值？** 内部写周期(tWC≈5ms)未完成期间访问被 NACK——标准做法是 ack polling 到应答再读。

> [!question] 📝 思考题
> 1. 推导上拉电阻取值范围公式（VOL 灌电流上限 vs 上升沿 RC 上限）。
> 2. 为含 12 个传感器的项目设计 I2C 地址分配表与冲突预案。
> 3. 用 i2ctransfer 实现「读温湿度芯片+CRC 校验」完整命令序列。

---
🏷️ #domain/protocol #topic/i2c | 🔗 [[ch75-UART-RS485与Modbus-RTU实战libmodbus]] ← **本章** → [[ch77-SPI-QSPI与Flash驱动JEDEC-XIP磨损均衡]] | 📚 [[P8-MOC]]
