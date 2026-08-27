---
title: "第88章 P2 · ESP32-S3 桌面信息站 / WiFi 工具箱"
part: "[[P9-MOC]]"
chapter: 88
tags:
  - domain/mcu
  - topic/wifi
  - topic/ble
difficulty: 2
est_minutes: 35
prerequisites:
  - "[[ch32-ESP32外设与WiFi-BLE上手]]"
related:
  - "[[ch31-ESP-IDF入门]]"
  - "[[ch81-WiFi协议栈实战wpa_supplicant-hostapd]]"
  - "[[ch82-BLE开发GATT设计BlueZ-DFU]]"
  - "[[ch29-低功耗设计]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第88章 P2 · ESP32-S3 桌面信息站 / WiFi 工具箱

> [!info] 导航
> ⏱ 35min | ★★☆☆☆ | 前置 [[ch87-P1-STM32环境监测终端]] | → [[ch89-P3-MCUboot双分区OTA安全升级系统]]

## 🎯 学习目标
- [ ] 打造「开机即用」桌面信息终端：天气/时钟/B站粉丝/服务器监控多页面切换（ESP-IDF + LVGL9）
- [ ] 掌握零配置体验设计：BLE 传凭证 + AP 门户（Captive Portal）双通道配网
- [ ] 实现 WiFi 工具箱页：扫描/信道占用/ping/sniffer 抓包开关
- [ ] 学习 WLED/ESPHome 的架构思想并做轻量化复刻

## 88.1 功能矩阵与架构

| 模块 | 功能 | 技术点 |
|------|------|--------|
| 显示引擎 | 多页面管理+动画切换 | lv_tileview + 页面生命周期钩子 |
| 数据层 | 天气API/NTP时间/自定义HTTP源 | esp_http_client + cJSON + 定时刷新队列 |
| 配网向导 | BLE 收凭证→转 STA；失败回退 SoftAP 门户 | NimBLE GATT(ch82) + httpd captive portal |
| WiFi 工具箱页 | 扫描列表/信道占用图/ping 工具/sniffer 开关 | esp_wifi_scan + sniffer 混杂模式(ch81.4) |
| 电源管理 | 光感自动亮度+夜间深睡时段 | ledc 背光渐变 + esp_sleep 定时唤醒 |

数据流：页面框架只消费消息队列——网络任务拉取数据 → cJSON 解析 → 队列推给 gui_task；服务器监控类数据源可扩展走 MQTT 订阅（协议本体见 [[ch80a-MQTT-CoAP云协议本体与实现]]）。sniffer 工具页同时是 [[ch86-综合案例无线共存干扰排障全流程]] 的取证前端。

## 88.2 关键实现代码：Captive Portal 配网门户

```c
/* SoftAP 模式启动 HTTP 服务，劫持 DNS 让手机自动弹窗 */
httpd_uri_t root = { .uri = "/",     .method = HTTP_GET,
                     .handler = root_get };
httpd_uri_t save = { .uri = "/save", .method = HTTP_POST,
                     .handler = save_post };
httpd_start(&server, &cfg);
httpd_register_uri_handler(server, &root);
httpd_register_uri_handler(server, &save);

/* dnsmasq 等价物：esp_dns 对所有域名查询都回答本机 IP —— 手机自动弹门户 */
/* save_post 处理链：解析 ssid/pass → nvs 写入 → esp_wifi_set_config(STA)
   → 切 STA 连接；10s 内未连成功则回滚 AP 并在门户页提示 */
```

配网状态机：`首次开机 → BLE GATT 等凭证（优先）→ 收到凭证切 STA → 成功存 NVS / 超时回退 AP 门户 → 用户网页提交 → 再试 STA`。断电重启后直接从 NVS 秒连，不再进向导。

## 88.3 BOM 与资源占用

| 物料 | 规格 | 说明 |
|------|------|------|
| 主控 | ESP32-S3 开发板（≥8MB Flash） | 双核 Xtensa LX7 + WiFi/BLE |
| 屏幕 | 2.4" ST7789 SPI（可选触摸） | LVGL9 渲染 |
| 光感 | BH1750 | 自动亮度输入 |
| 扬声器（可选） | PWM 无源喇叭 | 彩蛋语音开关 |

资源水位（典型值）：LVGL 内存池 ~48KB / WiFi+BLE 协议栈合计 ~120KB heap / 页面控件树按需创建销毁——以 heap_caps 监控 7×24 无增长为硬指标。

## 88.4 里程碑与验收门

| 门 | 里程碑 | 出口准则 |
|----|--------|----------|
| M1 | 配网双通道打通 | iOS/Android 各 5 次配网成功率 ≥95% |
| M2 | 页面框架+数据层 | 断电重启 NVS 凭证秒连；天气/NTP 正常刷新 |
| M3 | WiFi 工具箱页 | 扫描/信道占用/ping 可用，sniffer 开关生效 |
| M4 | 电源管理+老化 | 夜间深睡生效；7×24 运行无看门狗复位、内存无增长 |

## 88.5 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 手机不弹配网门户 | tcpdump 抓 SoftAP 上 DNS 查询 | esp_dns 劫持是否应答本机 IP | 连上 SSID 后 3s 内弹窗 |
| heap 缓慢下降 | heap_caps_monitor 按调用点聚类 | cJSON_Delete 配对释放/页面销毁钩子 | 72h 水位零增长 |
| sniffer 抓不到包 | Wireshark 看混杂模式信道锁定 | esp_wifi_set_promiscuous 与信道绑定 | 能解密看到本环境 Beacon |
| 弱信号频繁断流 | RSSI 读数日志 | 触发降级策略阈值 | -80dBm 时 UI 友好提示 |

## 88.6 实测数据表（验收锚点）

| 场景 | 指标 | 判据 |
|------|------|------|
| 配网全流程 ×10（双平台各 5） | 成功率 | ≥95% |
| 断电重启恢复 | 凭证恢复耗时 | NVS 秒连 |
| 弱信号场景 | 降级触发 | -80dBm 触发且 UI 提示友好 |
| 7×24 连续运行 | 内存/复位 | heap 无增长、零看门狗复位 |

## 88.7 体验打磨清单（产品感来自细节）

1. **首开引导**：首次开机自动进入配网向导而非黑屏等待——第一印象 10 秒定生死；
2. **断网优雅降级**：天气拉不到时显示「离线模式+本地时钟」，而不是报错弹窗；
3. **亮度自适应曲线**：光敏值→PWM 做伽马校正映射，避免低光跳变；
4. **OTA 静默升级**：夜间窗口+失败回滚提示，用户零感知（接口预留 [[ch89-P3-MCUboot双分区OTA安全升级系统]]）；
5. **彩蛋与人格化**：开机动画/语音播报开关——社交传播的种子。

## 88.8 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| BLE 写入凭证后 STA 连不上 | 凭证含特殊字符未转义/密码错 | 日志打印长度而非明文；门户页回显错误码 |
| 深睡后唤醒 WiFi 重连慢 | 未保存 PHY 校准数据/全量重初始化 | 启用 WiFi 快速连接缓存 |
| 页面切换掉帧 | tileview 全页面常驻内存 | 生命周期钩子里懒创建/延迟销毁控件 |
| NTP 时间跳变 | 时区/DST 未配置或 SNTP 在 WiFi 就绪前启动 | 先等 got_ip 事件再启动 SNTP |

## 88.9 开源对照与差距分析

| 项目 | 借鉴点 | 差异化空间 |
|------|--------|-----------|
| WLED (github.com/Aircoookie/WLED) | Web 配置界面组织、preset 系统、OTA 流程 | 面向灯带；复用其「模块化页面注册」思想 |
| ESPHome | YAML 声明式设备定义与组件抽象 | 无需编译器的运行时配置加载器是进阶方向 |
| 立创广场 ESP32-S3 摆件类项目 | 结构设计与屏幕选型经验帖 | 网络诊断工具箱是稀缺差异化卖点 |
| Marauder（学习用途） | sniffer/deauth 界面化 UX 思路 | 仅借鉴交互；用途限定合法测试环境 |

> [!example]- 🧪 动手实验 L88-1：配网全流程压测（40 分钟）
> **步骤**：① 恢复出厂清空 NVS；② iOS 与 Android 各执行 5 次「BLE 配网→故意输错密码→回退 AP 门户→正确配网」全流程并计时；③ 配网成功后断电重启验证秒连；④ 把手机置于 -80dBm 弱信号处观察降级提示。
> **验收**：10 次全流程成功率 ≥95%；每次重启后 ≤5s 恢复联网刷新；弱信号下出现友好降级 UI 而非崩溃或黑屏。

## 88.10 进阶话题

- **从玩具到产品的分水岭**：可制造性（外壳装配效率）、可维修性（模块化）、可升级性（OTA）三性评估表；
- **功耗的最后 20%**：深睡期间 GPIO 漏电扫描法（[[ch29-低功耗设计]]）+外设电源树重构——续航翻倍常在硬件不在软件；
- **社区运营初体验**：GitHub Trending 发布时机（周二上午、避开大厂发布会）与 README 封面图的重要性；WLED 用 GitHub Actions 自动出 release 包的流程值得全文抄读。

> [!warning]- ❓ FAQ
> **Q1：为什么 BLE 配网体验优于 SmartConfig？** SmartConfig 让设备混杂模式嗅探手机 UDP 广播、把凭证编码在包长/地址字段里，射频层面天然怕干扰与信道漂移；BLE 是标准 GATT 连接式传输，有确认重传，成功率与安全性都高一档。
> **Q2：sniffer 功能的合规边界？** 仅用于自有/授权网络诊断教学场景，工具页默认关闭并在文档声明合法使用范围。

> [!question] 📝 思考题
> 1. 设计「插件式页面」框架：新页面以组件形式注册、零侵入接入现有 tileview 与消息队列。
> 2. 估算各页面平均功耗并制定深睡策略，把插电待机做到月级电费可忽略。

---
🏷️ #domain/mcu #topic/wifi #topic/ble | 🔗 [[ch87-P1-STM32环境监测终端]] ← **本章** → [[ch89-P3-MCUboot双分区OTA安全升级系统]] | 📚 [[P9-MOC]]
