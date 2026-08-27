---
title: "第82章 蓝牙 BLE 开发：GATT 设计、BlueZ 与 OTA DFU"
part: "[[P8-MOC]]"
chapter: 82
tags:
  - domain/protocol
  - topic/ble
difficulty: 4
est_minutes: 40
prerequisites:
  - "[[ch81-WiFi协议栈实战wpa_supplicant-hostapd]]"
related:
  - "[[ch32-ESP32外设与WiFi-BLE上手]]"
  - "[[ch89-P3-MCUboot双分区OTA安全升级系统]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第82章 蓝牙 BLE 开发：GATT 设计、BlueZ 与 OTA DFU

> [!info] 导航
> ⏱ 40min | ★★★★☆ | 前置 [[ch81-WiFi协议栈实战wpa_supplicant-hostapd]] | → [[ch83-LoRaWAN组网LoRaMac-node-ChirpStack]]

## 🎯 学习目标
- [ ] 用 GATT 服务/特征值/描述符建模业务数据并算清 MTU 吞吐账，完成 BlueZ D-Bus 扫描/连接/订阅编程
- [ ] 实施 Nordic DFU(SMP) 与自定义 GATT DFU 两套升级方案
- [ ] 说清连接参数(CI/latency)对功耗与延迟的影响，入门 BLE Mesh

## 82.1 GAP 角色与广播参数

GAP(Generic Access Profile) 定义四角色：Central(中心，扫描并发起连接)/Peripheral(外设，可连接广播)/Broadcaster(仅广播)/Observer(仅观察)。手机 App 通常做 Central，穿戴与传感设备做 Peripheral。

- **间隔**(典型值) 20ms~10.24s：快发现用 20~100ms，配对稳定后放宽到 1s 以上省电；
- **类型** ADV_IND(可连接+可扫描，通用)/ADV_NONCONN_IND(纯信标)/ADV_SCAN_IND(信标+可扫描回复)；高版本还有扩展广播；
- **载荷** 主通道 31B + ScanRsp 31B——设备名放 ScanRsp，给主载荷腾位置。

## 82.2 GATT 数据建模方法论与 MTU 吞吐账

原则：**一个「可独立订阅的数据流」= 一个 Characteristic**。
```text
Service 环境传感 FFE0
 ├ Char FFE1 Temp      Read|Notify    (int16 x0.01°C)
 ├ Char FFE2 Humidity  Read|Notify
 └ Char FFE3 Ctrl      Write|WriteNR  (命令字节+参数)
Descriptor：CCCD(0x2902) 自动生成——Notify 开关由客户端写它控制
```
MTU 吞吐账本：ATT 默认 MTU23→有效载荷仅 20B；协商到 247 后每个 conn interval(15ms) 可发多个包；DLE+2M PHY 理论 ~1.4Mbps，iOS/Android 实际约 100~700KB/s。高吞吐设计三招：减少每包开销+批量特征+客户端 ACK 窗口管理。

## 82.3 连接参数更新（Connection Interval 协商）

| 参数组合 | 平均电流(从机侧) | 吞吐能力 | 延迟 |
|----------|------------------|----------|------|
| CI=7.5ms, slave_latency=0 | ~1.2mA | 最高 | 最低 |
| CI=100ms, latency=4 | ~80µA | 中 | ≤500ms |
| CI=1s, latency=9 | ~25µA | 低 | 秒级 ★电池设备常态 |

策略：数据传输期请求快参数，空闲期请求慢参数——双档切换是穿戴产品的标配状态机；supervision timeout 要与从机睡眠匹配，否则出现「连接 30 分钟后假断连」。

## 82.4 BlueZ D-Bus 编程（Linux 中心设备）

- `org.freedesktop.DBus.ObjectManager.GetManagedObjects` 枚举全部 Device1 对象；
- `Adapter1.SetDiscoveryFilter(uuids=[SERVICE_UUID])` 按 UUID 过滤扫描——精准且省电；
- 连接与读写订阅走 `Device1.Connect` 与 `GattCharacteristic1.ReadValue/WriteValue/StartNotify`；
- C 语言用 gdbus/sd-bus 注册 PropertiesChanged 回调(事件驱动范式)；API 文档就在 BlueZ 源码 doc/ 目录(gatt-api)。

## 82.5 OTA DFU 双流派
| 方案 | 机制 | 适用 |
|------|------|------|
| Nordic DFU(SMP/mcuboot manager) | 包签名验证+分片传输+回滚——mcuboot 的蓝牙传输版 | nRF52/Zephyr 生态 ★成熟 |
| 自定义 GATT DFU | 数据口+控制口自研协议(ch30 思想移植) | ESP-IDF 等非 Nordic 平台 |

```text
 控制口 [CMD_START][total_len,crc] → 回 [ACK,chunk_size]
        [CMD_DATA][seq,data...]   → 每 N 包回一个 CRC 校验点
        [CMD_END] → 设备校验整体 CRC → 写标志位重启 bootloader
 可靠性三件套：seq 序号去重 / 滑动窗口流控 / 断点续传(已收长度存 NVS)
 安全两件套：镜像签名(ECDSA) + 版本单调递增防降级攻击
```

## 82.6 BLE Mesh 概念入门
Mesh≠BLE 连接：广播中继泛洪(flood)，没有连接概念。核心对象：
- **Provisioning**：新设备入网(OOB 认证→下发 NetKey/AppKey/单播地址)；
- **Model**：Generic OnOff(开关)/Light Lightness(亮度)/Scene(场景)；
- **Relay/TTL**：中继深度平衡功耗与延迟(TTL=2~3 常用)；百灯级可达，千灯级要规划 subnet 分割(典型值)。

Mesh 适合「本地闭环」；跨互联网仍需网关做 Mesh↔MQTT 翻译。横向对比：**Matter over Thread(Apple+Google+Amazon 共推)是智能家居终局方向**；BLE Mesh 在纯 BLE 生态(信标/穿戴)仍有优势。

## 82.7 关键代码：GATT 服务声明(NimBLE)

```c
static const ble_gatt_svc_def svcs[] = {
 { .type = BLE_GATT_SVC_TYPE_PRIMARY, .uuid = &svc_env_uuid,
   .characteristics = (ble_gatt_chr_def[]){
     { .uuid=&chr_temp_uuid, .access_cb=temp_cb, .val_handle=&temp_val_h,
       .flags=BLE_GATT_CHR_F_READ|BLE_GATT_CHR_F_NOTIFY },
     { .uuid=&chr_ctrl_uuid, .access_cb=ctrl_cb,
       .flags=BLE_GATT_CHR_F_WRITE|BLE_GATT_CHR_F_WRITE_NO_RSP },
  { 0 } } }, { 0 }};
/* temp_cb 三态：READ 回当前值 / WRITE 解析命令；变化时 ble_gatts_notify_custom(temp_val_h,...) 推送 */
```
## 82.8 参数调试技巧
| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| Notify 高频丢失 | nRF Sniffer 看流控 | 降频率/增大 MTU/开 2M PHY | 丢包归零 |
| 吞吐不达标 | bleak 计时脚本量化 | 按 MTU→DLE+2M PHY→每 CI 多包顺序调 | ≥标称值 80% |
| 空闲功耗超标 | 电流表看均值 | 空闲期协商大 CI+latency | 进入 µA 档 |

## 82.9 实测数据表：MTU 与吞吐实测（ESP32-S3 ↔ iPhone）
| MTU/PHY | 应用层吞吐 | P99 包延迟 |
|---------|------------|------------|
| 23B / 1M PHY | ~5KB/s | ~30ms |
| 247B / 1M | ~38KB/s | ~25ms |
| 247B / 2M PHY+DLE | ~95KB/s | ~18ms |
| +每 CI 多包(CI=15ms) | ~140KB/s | - |
| OTA 200KB 固件总耗时 | 40s(默认参数) | 8s(优化后)——差距全在参数 |

## 82.10 排故速查表
| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| iOS 能连 Android 连不上 | GATT 表缺 GAP/GATT 必备服务声明 | nRF Connect 对照两端服务树；补齐 0x1800/0x1801 |
| 连接 30 分钟后断 | supervision timeout 与从机睡眠冲突 | 参数更新请求协商；slave latency 权衡 |
| Bonding 后重连被拒 | 密钥分发不全/IRK 轮换(RPA)未处理 | 检查 SMP 密钥分发流程；启用地址解析模块 |
| DFU 中途失败无法再入 DFU | bootloader 标志区被破坏 | 双标志区设计(ch30)；恢复出厂组合键兜底 |

## 82.11 部署注意事项
1. GATT 缓存的坑(Android 最激进缓存服务表)——改 GATT 表必须同时换 Service UUID 或设备地址；iOS 写 CCCD 后必须等订阅确认再开推，否则前几包静默丢；
2. 大数据分块流传输模式：控制特征写 START(total_len,crc)→数据特征按 conn interval 尽量多发([seq:2B][len:1B][payload≤MTU-3])→客户端周期写 CREDIT 流控→CRC 校验收尾；断点续传记 last_seq 于 NVS；
3. HCI UART 主机/控制器分离：H4=裸流，H5=带滑动窗口重传的可靠协议(串口误码高的产品选 H5)；`btattach -B /dev/ttyS1 -S 921600 -P h4` 后 BlueZ 自动接管；波特率切换流程：上电低速→HCI_Set_Baudrate→高速。

> [!example]- 🧪 动手实验 L82-1：自定义 GATT+手机 App 全链联调（90 分钟）
> **步骤**：① 按 82.7 建「温度+控制」服务；② nRF Connect 完成读写/订阅全操作截图；③ 写 Python bleak 脚本自动订阅并画温度曲线；④ 实施 MTU 协商与 2M PHY 切换量化吞吐提升；⑤ 注入连接中断验证重连与 CCCD 状态保持。
> **验收**：自动化测试脚本一套+四组吞吐对比数据完整。

## 82.12 进阶话题
- Bonding 密钥管理面：LTK/IRK 存储与删除策略、「解绑」换绑流程设计；
- AoA/AoD 测向：CTE 天线阵列室内定位——蓝海但天线与算法门槛高；
- 工具：nRF Sniffer + Wireshark 插件(空口取证标配)。

> [!warning]- ❓ FAQ
> **Q1：为什么改了 GATT 表部分老手机看不到新服务？** 客户端缓存了服务表(Android 最激进)——同时更换 Service UUID 或设备地址可强制刷新。
> **Q2：Nordic SMP 与自定义 DFU 怎么选？** nRF52/Zephyr 生态直接用 SMP(mcuboot manager) 成熟可靠；ESP-IDF 等平台走自定义 GATT 双口方案，Bootloader 思想复用 ch30。

> [!question] 📝 思考题
> 1. 推导 MTU=247、CI=15ms、2M PHY 下的理论上限吞吐。
> 2. 为你的设备设计完整 Bonding+RPA 隐私方案并画状态机。
> 3. 对比 BLE Mesh 与 Thread 在百节点照明场景的组网成本。

---
🏷️ #domain/protocol #topic/ble | 🔗 [[ch81-WiFi协议栈实战wpa_supplicant-hostapd]] ← **本章** → [[ch83-LoRaWAN组网LoRaMac-node-ChirpStack]] | 📚 [[P8-MOC]]
