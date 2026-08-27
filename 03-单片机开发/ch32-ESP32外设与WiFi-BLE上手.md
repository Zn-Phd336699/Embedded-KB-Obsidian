---
title: "第32章 ESP32 外设速成与 WiFi/BLE 上手"
part: "[[P3-MOC]]"
chapter: 32
tags:
  - domain/mcu
  - topic/wifi
  - topic/ble
difficulty: 3
est_minutes: 35
prerequisites:
  - "[[ch31-ESP-IDF入门]]"
related:
  - "[[ch29-低功耗设计]]"
  - "[[ch82-BLE开发GATT设计BlueZ-DFU]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第32章 ESP32 外设速成与 WiFi/BLE 上手

> [!info] 导航
> ⏱ 35min | ★★★☆☆ | 前置 [[ch31-ESP-IDF入门]] | → [[ch33-综合实战环境监测终端]]

## 🎯 学习目标
- [ ] 把 GPIO/ADC/I2C/PWM 的 STM32 经验平移到 ESP-IDF 对应 API，各举一例
- [ ] 按「四步初始化」完成 WiFi STA 连接，实现指数退避断线自愈闭环
- [ ] 说清 GAP/GATT 分层，跑通 NimBLE FFE0/FFE1 最小 GATT Server 并完成主机栈选型

## 32.1 外设 API 对照表（STM32 经验平移）

ESP32-S3 外设 API 风格与 STM32 HAL 大同小异，真正的增量是 WiFi/BLE 两座协议栈大山。先平移存量经验：

| 功能 | STM32 HAL | ESP-IDF |
|------|-----------|---------|
| GPIO | HAL_GPIO_WritePin | `gpio_set_level(gpio_num_t, level)` |
| PWM | TIM PWM | ledc 通道组（16 路独立分辨率） |
| ADC | HAL_ADC | adc_oneshot / adc_continuous(DMA) |
| I2C | HAL_I2C | i2c_master 新驱动(R5.x)：句柄式 `i2c_master_dev_handle_t` |
| SPI | HAL_SPI | `spi_device_queue_trans` 异步事务队列 |
| 定时器 | TIM | esp_timer（µs 精度软定时）或 gptimer（硬件） |
| UART | HAL_UART | `uart_driver_install` + 事件队列（IDLE 检测内置！） |

**特有能力速记**：Touch 电容触摸通道；RMT 精确波形发生器（WS2812 灯带标配）；I2S 数字音频；ULP 协处理器深睡下采样（[[ch29-低功耗设计]] 同构思路）；USB OTG 可做 CDC 虚拟串口免驱动。

## 32.2 WiFi STA 四步初始化与断线自愈

初始化四件套**顺序不能乱**，后续全部逻辑挂在事件回调上：

```c
nvs_flash_init();                    // ① NVS：存 RF 校准数据
esp_netif_init(); esp_event_loop_create_default();  // ② 网络栈+默认事件环
esp_wifi_init(&cfg);                 // ③ WiFi 驱动
esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &cb, NULL);  // ④ 订阅事件

esp_wifi_set_mode(WIFI_MODE_STA); esp_wifi_start();  // 发起连接
// WIFI_EVENT_STA_START        -> 发起 connect
// WIFI_EVENT_STA_DISCONNECTED -> 指数退避重连：1s,2s,4s..上限60s
// IP_EVENT_STA_GOT_IP         -> 启动业务；RSSI<-75dBm -> 提示信号弱/换信道
```

自愈三原则：**退避有上限**（防 AP 宕机打爆日志）、**连上即清零计数**、**业务严格等 GOT_IP 再启动**。

## 32.3 BLE GATT 最小心智模型

| GAP 层 | 职责 | S3 关键参数 |
|--------|------|-------------|
| 广播 Advertising | 让手机发现我 | 31 字节载荷；间隔影响功耗与发现速度 |
| 连接 Connection | 建立后广播自动停 | conn interval 7.5ms~4s；MTU 默认 23 可协商到 517 |
| GATT 层 | Service > Characteristic > Descriptor 树 | 读/写/Notify 三种交互原语 |

最小服务模型：注册 GATT 服务表 `0x180A` 设备信息 + 自定义服务 `FFE0`；特征 `FFE1` 属性 `READ\|WRITE\|NOTIFY`。手机写 FFE1 → 回调收命令；设备侧数据变化 → notify 主动推送。

### NimBLE vs Bluedroid（menuconfig 一键切换主机栈）

| 维度 | NimBLE | Bluedroid |
|------|--------|-----------|
| 协议范围 | 仅 BLE | Classic BT + BLE 全家桶 |
| RAM 占用 | 省 RAM 首选（典型省数十 KB 级） | 占用高 |
| 适用场景 | 单 MCU IoT 外设 | 需要 SPP/A2DP 等 Classic 功能 |

调试神器：**nRF Connect** APP 扫描/读写/订阅全可视化；**Wireshark** 配 HCI 日志（nimble hci dump）逐包分析——协议深水区见 [[ch82-BLE开发GATT设计BlueZ-DFU]]。

## 32.4 功耗与共存参数

- **Modem sleep**：STA 空闲关 RF，~70mA→~3mA（DTIM 唤醒监听 Beacon）；**Deep sleep**：~10µA，RTC 定时/EXTI 唤醒后等效复位（[[ch29-低功耗设计]] 同构）；
- **BLE 广播间隔**决定平均功耗：1s 广播比 20ms 省约 50 倍；
- **WiFi/BLE 共存**（典型值）：二者共享同一射频前端，软件共存仲裁（coexist）默认开启；双活时吞吐典型下降 20%~50%，建议 BLE conn interval 与 DTIM 周期错峰取值；系统性共存排障见 [[ch86-综合案例无线共存干扰排障全流程]]。

## 32.5 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 连接耗时长 | 事件时间戳打点 | 扫描时间预算/指定目标信道 | START→CONNECTED < 3s（典型值） |
| 自愈风暴刷屏 | 统计 DISCONNECTED 频率 | 退避上限/计数清零时机 | 退避序列 1→2→4→…封顶 60s |
| Notify 丢包 | Wireshark HCI dump | MTU 协商值/conn interval | MTU≥247 且无发送队列溢出 |
| 双射频互相拖慢 | iperf 与 BLE 吞吐对拍 | 共存参数/conn interval | 各自吞吐降幅 <50%（典型值） |

## 32.6 实测数据表

| 场景 | 指标A | 指标B |
|------|-------|-------|
| STA Modem sleep | 关闭：~70mA | 使能：~3mA（DTIM 唤醒） |
| Deep sleep | ~10µA | RTC 定时/EXTI 唤醒，醒来等效复位 |
| HTTPS(TLS) 握手峰值堆 | ~40KB | 要求最大连续堆块 >40KB |
| BLE 广播间隔 1s vs 20ms | 平均功耗省约 50 倍 | 发现延迟换功耗 |

## 32.7 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| WiFi 连接偶发失败 | 信道拥塞/路由器兼容性/PSK 错误 | esp_wifi_scan 打印 AP 列表与 RSSI；固定信道测试；看 AUTH 阶段失败码 |
| 运行中随机重启 | 任务栈不足/看门狗未喂/中断里调阻塞 API | monitor 看 backtrace 符号化定位；uxTaskGetStackHighWaterMark 巡检 |
| BLE 手机搜不到 | 广播未启/名字超长截断/PHY 不匹配 | nRF Connect 看原始广播包；检查 adv start 返回码 |
| HTTPS 握手内存不足 | TLS 需要 ~40KB 峰值堆 | heap_caps_get_free_run 查最大连续块；降证书链验证深度 |
| ADC 读数噪声大 | WiFi 工作时电源纹波耦合进模拟域 | 采样与发包错峰；多次中值滤波；硬件 LDO 隔离模拟域 |

## 32.8 部署注意事项

1. 出厂烧录保留 NVS 分区的 RF 校准数据，量产前跑一次全量初始化验证；
2. WiFi SSID/PSK 不入源码，经配网通道写入 NVS；
3. 部署前出 esp_wifi_scan 信道占用报告，固定干净信道并留档；中断上下文禁止阻塞 API，逻辑收敛到「事件回调 + 任务队列」；
4. 常驻 heap 巡检任务记录最小剩余堆水位，跌破阈值即告警上报。

> [!example]- 🧪 动手实验 L32-1：断线自愈退避曲线观测（20 分钟）
> **步骤**：烧录 STA 自愈示例 → 打开 idf.py monitor → 让路由器断电 90s 后上电 → 记录每次 DISCONNECTED 与下一次 connect 的时间差。
> **验收**：日志呈现 1s→2s→4s→8s…指数退避且不超过 60s；AP 恢复后在当前退避周期内自动重连，最终打印 GOT_IP 并启动 SNTP。

## 32.9 进阶话题

- 推导 Modem-sleep 下 DTIM=3、Beacon=100ms 的平均监听占空比（监听间隔拉长为 300ms 一次）；
- 为 BLE OTA 设计分块传输协议：MTU 利用率、滑动窗口、CRC、断点续传字段（衔接 [[ch82-BLE开发GATT设计BlueZ-DFU]]）；
- 把 [[ch28-串口工程化IDLE-DMA-RS485]] 的 IDLE+DMA 思想映射到 uart_driver 事件队列机制；PRO/APP 双核绑核实践见 [[ch50a-FreeRTOS-SMP双核调度实战ESP32]]。

> [!warning]- ❓ FAQ
> **Q1：新项目选 NimBLE 还是 Bluedroid？** 只做 BLE 选 NimBLE——省 RAM、API 轻；仅当需要经典蓝牙（SPP/A2DP）才用 Bluedroid。
> **Q2：密码正确为何连不上？** 先看 AUTH 阶段失败码区分 PSK 错误与信号问题；再查 RSSI 是否低于 -75dBm；最后固定信道排除路由器兼容性。

> [!question] 📝 思考题
> 1. 推导 Modem-sleep 下 DTIM=3、Beacon=100ms 的平均监听占空比。
> 2. 为 BLE OTA 设计分块传输协议：给出 MTU、窗口、CRC、断点续传字段的完整定义。
> 3. RSSI 长期 -78dBm 时，从连接质量与功耗两个角度分别给出应对策略。

---
🏷️ #domain/mcu #topic/wifi #topic/ble | 🔗 [[ch31-ESP-IDF入门]] ← **本章** → [[ch33-综合实战环境监测终端]] | 📚 [[P3-MOC]]
