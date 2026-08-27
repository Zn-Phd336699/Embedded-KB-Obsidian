---
title: "第79章 USB 协议与驱动：枚举、描述符、HID/CDC 类与 Gadget"
part: "[[P8-MOC]]"
chapter: 79
tags:
  - domain/protocol
  - topic/usb
difficulty: 4
est_minutes: 40
prerequisites:
  - "[[ch78-CAN-CANFD实战SocketCAN-DBC工作流]]"
related:
  - "[[ch66-综合实战USB摄像头流采集服务]]"
  - "[[ch17-Wireshark-tcpdump抓包分析]]"
  - "[[chsd-S4-量产工程产测工装与老化]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第79章 USB 协议与驱动：枚举、描述符、HID/CDC 类与 Gadget

> [!info] 导航
> ⏱ 40min | ★★★★☆ | 前置 [[ch78-CAN-CANFD实战SocketCAN-DBC工作流]] | → [[ch80-以太网与lwIP协议栈源码导读]]

## 🎯 学习目标
- [ ] 复述插线后的枚举八步曲并指出每步的排障锚点
- [ ] 画出设备/配置/接口/端点/字符串描述符树，保证 wTotalLength 自洽
- [ ] 按业务特征为四种传输类型正确选型并给出 Bulk 吞吐优化路径
- [ ] 分别用裸机 CDC/HID 与 Linux configfs Gadget 实现 USB 从设备

## 79.1 USB 拓扑与枚举八步曲
物理拓扑为主机—集线器—设备的分层星型，SET_ADDRESS 分配唯一地址 1~127。插入设备后的完整流程：

| 步骤 | 动作 | 排障关注 |
|------|------|----------|
| 1 检测 | D+/D- 上拉识别全速/高速 chirp | 1.5kΩ 上拉位置正确性 |
| 2 复位 | 主机 SE0 复位，设备地址回到 0 | - |
| 3 GET_DESCRIPTOR(Device) | 先试探 8B 拿 bMaxPacketSize | bcdUSB/bMaxPacketSize 正确性 |
| 4 SET_ADDRESS | 分配唯一地址(1~127) | - |
| 5~6 读全套描述符树 | Config/Interface/Endpoint/字符串 | 长度字段自洽——手写最常错处 |
| 7 加载驱动 | 按 Class 或 VID/PID 匹配 | WinUSB/Zadig 免驱方案考量 |
| 8 SET_CONFIGURATION | bConfigurationValue 激活上电 | bMaxPower 与实际耗电匹配 |

排障锚点：黄色感叹码 = 描述符错/驱动缺；枚举中断在第 4 步附近 = 描述符长度字段不自洽。**手写描述符九成事故出在「wTotalLength 与实际返回不一致」**——抓包核对即可定位（Wireshark USBPcap / Linux usbmon，方法论同 [[ch17-Wireshark-tcpdump抓包分析]]）。

## 79.2 描述符族层级与 CDC-ACM 虚拟串口
层级：Device → Config → Interface → Endpoint，另有字符串索引族。CDC-ACM 虚拟串口的复合描述符骨架：

```text
Device(class=0xEF, IAD 支持)
 └ Config
    ├ Interface0: Communication(Class=02) — EP81 IN 通知端点
    │   └ 功能描述符: Header/CallMgmt/ACM/Union(标注主从接口号)
    └ Interface1: Data(Class=0A) — EP02 OUT bulk + EP82 IN bulk
```

固件核心状态机：SET_LINE_CODING（波特率协商）/ SEND_ENCAPSULATED 命令响应 / bulk 双缓冲收发；STM32 CubeUSB 已生成模板，重点读懂 usbd_cdc_if.c 的回调映射。

## 79.3 四种传输类型选型账本

| 类型 | HS 单事务能力 | 保证性 | 典型用途 |
|------|---------------|--------|----------|
| Control | 枚举专用 | - | 配置/状态 |
| Bulk ★吞吐王 | 512B/包，理论 53MB/s | 无时限但重传保真 | 存储/大文件 |
| Interrupt | ≤1024B 微帧轮询 | 有界延迟 | HID/键盘/通知 |
| Isochronous ★实时王 | 固定带宽预留 | 不重传(容错由上层) | 音频/摄像头 |
UVC 摄像头选 isoc 还是 bulk？高分辨率走 bulk（MJPEG）更抗丢包，是近年主流。

## 79.4 关键代码：Gadget/libusb/HID 三路线

```bash
# configfs 搭 ACM+HID 复合 Gadget（板子当 USB 从设备）
cd /sys/kernel/config/usb_gadget && mkdir g1 && cd g1
echo 0x1d6b > idVendor && echo 0x0104 > idProduct
mkdir functions/acm.usb0 functions/hid.usb1
mkdir configs/c.1 && ln -s functions/acm.usb0 configs/c.1/f1
ls /sys/class/udc > UDC        # 绑定控制器，瞬间枚举生效!
# dmesg 即见 ttyACM0；mass_storage function 可模拟 U 盘——产线拷贝神器
```

```c
libusb_open_device_with_vid_pid(ctx, VID, PID, &h);   /* 前提 libusb_init */
if (libusb_kernel_driver_active(h, 0)) libusb_detach_kernel_driver(h, 0);
libusb_claim_interface(h, 0);
libusb_control_transfer(h, 0x40, REQ, val, idx, buf, len, 1000);
libusb_bulk_transfer(h, ep_in, buf, 512, &n, 1000);   /* 异步流用 submit_transfer+回调 */
/* HID 更简单： hidapi 的 hid_open/enumerate/read —— 跨平台免驱动 */
```
自定义 HID 报告描述符最小集（64B 传感器数据）：Usage_Page(Vendor 0xFF00) → Usage(0x01) → Collection(Application){ Report_ID(1), Report_Count(64), Report_Size(8), Input(Data,Var,Abs) }。主机端 hidapi 直接收 64B——Windows 免驱、Linux 有 hid-generic、macOS 原生，三端通吃；固件一行 USBD_HID_SendReport 即发送。bInterval 决定主机轮询周期（1~255ms），实时性上限由它锁死。

## 79.5 WinUSB 免驱两条路线
① 描述符内置：Device 固件返回 Microsoft OS 2.0 Descriptor（BOS 里声明）→ 枚举时系统自动绑定 WinUSB——零文件分发体验最佳（需 Win8.1+）；② INF 路线：用 Zadig/InfWizard 生成 .inf 指定 VID/PID → 接口 GUID。验证：`pnputil /enum-devices` 出现 WinUSB、`libusb_claim_interface` 成功即通。坑位：MS OS 2.0 的字符串索引与 BOS 链接顺序错了会**静默不生效**——抓枚举包核对。

## 79.6 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| Bulk 吞吐上不去 | 变更 URB 深度对比吞吐 | 队列深度 → 单块大小 → ZLP/短包边界 | 逼近 42MB/s 量级 |
| 枚举黄叹码 10/43 | USBPcap 抓枚举比对 | 描述符字段/驱动绑定 | lsusb -v 输出自洽 |
| 高速协商降为全速 | 示波器看 reset 后 chirp 波形 | 晶振精度/D+ 时序 | 稳定协商 HS |
| Suspend 后唤不醒 | 查 bmAttributes bit5 | 远程唤醒使能 | 主机能收到唤醒信号 |
## 79.7 实测数据表：Bulk 传输吞吐（HS，不同 URB 形态）

| URB 大小/队列深度 | libusb 实测 | 瓶颈判读 |
|--------------------|-------------|----------|
| 16KB×1 深度 | ~18MB/s | 每 URB 往返开销主导 |
| 64KB×4 深度 | ~38MB/s | 接近实用上限 |
| 256KB×8 | ~42MB/s | 协议开销+内存拷贝主导 |
优化次序：先加队列深度 → 再加大单块 → 最后核对 ZLP/短包边界处理正确性。
## 79.8 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 设备管理器黄色感叹码 10/43 | 描述符错误或驱动不匹配 | USBPcap 抓枚举比对；lsusb -v 输出审查 |
| 高速协商降为全速 | D+ chirp 时序/晶振精度不足 | 示波器看 reset 后 chirp；换晶振验证 |
| 大流量传输偶发 CRC 错误 | 线缆质量/EMI 干扰 | 换短线带屏蔽；逻辑分析仪看眼图裕量 |
| Gadget 枚举成功但功能不通 | function 未链接进 config/缺 UDC 写入 | configfs 目录树复查；lsusb 确认接口数 |
| Suspend 后无法唤醒 | 远程唤醒未使能(bmAttributes bit5) | 描述符检查；主机端电源管理设置 |

## 79.9 部署注意事项
1. 手写描述符必做 wTotalLength 与各级长度自洽审查，抓包回归留档；
2. Gadget 复合设备每个 function 必须链接进 configs 并正确写 UDC 文件；
3. 产品做 Host 时启用白名单类驱动策略，防 BadUSB 键盘伪装攻击面；
4. DRP 双角色设备处理 Try.SNK 策略：「插充电器当 Sink、插电脑当 Device」；VBUS 方向切换必须等 PD SafeVBus 事件——硬切烧口子的经典事故；
5. PCB 军规：差分 90Ω ±5mil 等长、D+/D- 参考平面完整不跨分割、共模扼流圈+ESD 管(TVS ≤0.5pF)靠近连接器。

> [!example]- 🧪 动手实验 L79-1：Gadget 复合设备三合一（90 分钟）
> **步骤**：① configfs 建 ACM+HID+MassStorage 复合 gadget；② 插 PC 验证三功能同时枚举(dmesg/lsusb)；③ HID 上报真实 ADC 数据并被 python-hidapi 读到；④ mass_storage 暴露一个 FAT 镜像可读写；⑤ USBPcap/Wireshark 抓枚举全程标注八步曲。
> **验收**：一台板子同时是「串口+手柄+U盘」，且抓包图完整标注八步。

## 79.10 进阶话题
- **Type-C/PD 三层栈**：CC 检测角色（DFP/UFP/DRP，PD 控制器如 FUSB302/STUSB4500 或 STM32 UCPD）→ BMC 编码 PD 协议 Source Capabilities↔Request；固件可读 RDO 判「对方给了多少瓦」动态调整业务；
- **UVC 描述符高频错误**：VC 单元拓扑 unit ID 冲突或未连成图→识别但无流；VS Format/Frame 的 bFrameIntervalType 与离散表数量不一致；isoc 带宽声明超实际→分配失败黑屏（联动 [[ch66-综合实战USB摄像头流采集服务]]）；
- **USB3 SuperSpeed 差异**：全双工光纤式差分对、链路级电源管理——但嵌入式 MCU 场景仍以 HS 为主流；眼图验收按 HS 模板（T Eye≥350mV×UI），改版前后波形留档对比。

> [!warning]- ❓ FAQ
> **Q1：为什么设备枚举成功却没有任何接口？** 多为类特定/功能描述符缺失或 Union 未标主从接口号，主机无法绑定类驱动。
> **Q2：libusb 打不开设备怎么办？** Linux 下先 detach 内核驱动再 claim_interface；Windows 下确认设备已绑 WinUSB（Zadig 或 MS OS 2.0 描述符）。

> [!question] 📝 思考题
> 1. 推导控制传输三阶段(Setup/Data/Status)在 EP0 上的令牌序列。
> 2. 设计一个「免驱自定义采集卡」：WinUSB 描述符+libusb 主机端框架。
> 3. 对比 Gadget configfs 与内核 g_multi 老式模块方案的灵活性差异。

---
🏷️ #domain/protocol #topic/usb | 🔗 [[ch78-CAN-CANFD实战SocketCAN-DBC工作流]] ← **本章** → [[ch80-以太网与lwIP协议栈源码导读]] | 📚 [[P8-MOC]]
