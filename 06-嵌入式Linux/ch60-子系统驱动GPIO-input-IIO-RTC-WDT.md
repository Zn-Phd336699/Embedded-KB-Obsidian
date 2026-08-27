---
title: "第60章 子系统驱动实战：GPIO / Input / IIO / RTC / Watchdog"
part: "[[P6-MOC]]"
chapter: 60
tags:
  - domain/linux
  - topic/gpio
  - topic/iio
difficulty: 3
est_minutes: 35
prerequisites:
  - "[[ch59-platform驱动设备树regmap]]"
related:
  - "[[ch29-低功耗设计]]"
  - "[[ch66-综合实战USB摄像头流采集服务]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第60章 子系统驱动实战：GPIO / Input / IIO / RTC / Watchdog

> [!info] 导航
> ⏱ 35min | ★★★☆☆ | 前置 [[ch59-platform驱动设备树regmap]] | → [[ch61-中断下半部threaded-irq-workqueue]]

## 🎯 学习目标
- [ ] 用 gpiod 工具族与描述符 API 操作 GPIO，说出 sysfs GPIO 被废弃的理由
- [ ] 描述 input 子系统三层结构并用 gpio-keys 接入按键
- [ ] 经 sysfs 与 IIO 缓冲读取 ADC，讲清 trigger/buffer 协作
- [ ] 实现 RTC alarm 与 watchdog 喂狗的标准交互协议

## 60.1 GPIO 字符设备新世界（gpiod）
不要重复造轮子——90% 的外设已有子系统。老 sysfs（/sys/class/gpio）已废弃！新姿势：

```bash
gpiodetect                        # 列出控制器芯片
gpioinfo gpiochip0                # 看每根线占用者 —— 排障第一步
gpioset --mode=signal gpiochip0 5=1   # signal 模式 Ctrl-C 退出时释放干净
gpiomon --num-events=3 --rising-edge gpiochip0 7   # 监听边沿事件
```

```dts
led-red { gpios = <&gpio4 9 GPIO_ACTIVE_LOW>; };  /* ACTIVE_LOW 自动取反! */
```

驱动侧描述符风格：`devm_gpiod_get(dev,"reset",GPIOD_OUT_LOW)` 拿 gpiod 描述符后 set_value/get_value；极性由 dts ACTIVE 标志自动处理，代码不再写死高低电平；占用关系在 gpioinfo 一目了然——这是 sysfs 时代做不到的。

## 60.2 Input 子系统：按键的三层流水线

```dts
gpio-keys {
    compatible = "gpio-keys";
    key-up { label="KEY_UP"; gpios=<&gpio2 3 GPIO_ACTIVE_LOW>;
             linux,code=<KEY_UP>; debounce-interval=<20>; };
    key-ok { ... linux,code=<KEY_ENTER>; };
};
```

```text
三层结构：
  驱动层(input_report_*) → input_core(input_register_device)
  → handler 层(evdev/mousedev) → /dev/input/eventN → 用户态
事件结构 input_event{ time, type(EV_KEY), code(KEY_UP), value(按下/松开/重复) }
调试： evtest /dev/input/event0 交互式看事件流 —— 按键排障第一站
```

- 自写驱动侧上报三件套：`input_report_key()` → `input_sync()` → `input_register_device()`；
- 上报纪律：状态变化才报 + 每次 `input_sync()` 提交一帧完整状态；多点触摸用 input_mt_slot/mt_report_slot_state 协议，slot 复用省 event 量；
- 调试三件套：evtest / hexdump / libinput debug-events。

## 60.3 IIO：ADC/DAC/传感器统一框架

```text
用户态统一接口（无论底层是 SoC ADC 还是 I2C 温度芯片）：
cat /sys/bus/iio/devices/iio:device0/in_voltage0_raw      # 单次读取
cat .../in_voltage_scale          # raw*scale=真实值(mV)
iio_attr -c                       # 枚举通道
触发采集： in_voltage0_en=1 ; buffer/enable=1 ; 读 /dev/iio:device0 批量
跨驱动引用： iio_channel_get() —— 温度补偿联动等场景
```

trigger/buffer 分工：trigger（定时器或外部中断）决定采样节奏，buffer（kfifo）攒批、用户态整块搬运——多通道同步采样的时间戳一致性远好于应用层单点轮询。

## 60.4 RTC 与 Watchdog 标准交互协议

| 子系统 | 用户态入口 | 驱动要点 |
|--------|-----------|----------|
| RTC | /dev/rtcN + hwclock/date；alarm 走 ioctl RTC_WKALM_SET | 实现 read_time/set_alarm；wakealarm 可定时开机（联动 [[ch29-低功耗设计]]） |
| Watchdog | /dev/watchdog：open 即启动；write 喂狗；ioctl WDIOC_GETTIMEOUT | nowayout 编译选项防意外关闭；心跳交给 systemd WatchdogSec 托管（[[ch56-启动流程深度剖析systemd提速]]） |

## 60.5 LED 与 backlight：零代码功能库

```text
leds-gpio: dts 定义 led-red/green → /sys/class/leds/red/{brightness,trigger}
trigger 彩蛋： echo heartbeat > trigger 心跳灯；mmc0 活动灯；timer 闪烁——业务逻辑一行不用写！
backlight: pwm-backlight 节点配亮度表 → /sys/class/backlight/
           —— Qt/LVGL 直接调亮度接口，跨平台一致
```

## 60.6 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 按键偶发连击 | evtest 数事件间隔 | 增大 debounce-interval（20ms 起步） | 抖动窗口内只出一对按下/松开 |
| ADC 读数漂移 | 万用表对拍 raw*scale | 校准 scale 或查参考电压 | 误差进入手册标称范围 |
| LED 不亮 | gpioinfo 看 consumer | 解除 pinctrl 复用冲突 | requested 且 brightness 生效 |

## 60.7 实测数据表：按键链路各环节延迟（按下→应用收到事件）

| 环节 | 典型耗时 |
|------|----------|
| 硬件去抖（dts debounce-interval） | 20ms（可配） |
| gpio-keys ISR→input 核心 | <50µs |
| evdev 字符设备唤醒 epoll | ~30µs |
| Qt/LVGL 应用处理一帧 | 8~16ms（帧界）——体感优化排序：去抖参数 > 应用帧率 > 内核链路 |

## 60.8 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| gpiod 线显示 used | 被 pinctrl 默认复用或其他驱动持有 | gpioinfo 看 consumer 名；pinctrl 状态核对 |
| 按键无响应 | debounce 太长/code 冲突/wakeup 未使能 | evtest 实测原始事件；检查 dts code 数值 |
| IIO 读数恒为满量程 | 参考电压/分压配置错或通道映射错 | scale 与 raw 分开验证；万用表对拍 |
| watchdog 复位循环 | 喂狗服务没起或 nowayout 下旧服务退出断粮 | systemctl status watchdog；journal 追喂狗周期 |

## 60.9 部署注意事项
1. 新设计一律 gpiod 字符设备接口，存量 sysfs GPIO 代码停止移植；
2. watchdog：开发版关 nowayout 便调试，量产版 cmdline 强制开——同内核不同参数；
3. IIO 缓冲消费端用双缓冲/足够大的 kfifo，防高频采样丢块；LED 指示优先用现成 trigger（heartbeat/mmc0/timer）；
4. 按键做唤醒源时同步查 pinctrl 睡眠态与 wakeup-source 标志。

> [!example]- 🧪 动手实验 L60-1：从 dts 到应用的按键全链（55 分钟）
> **步骤**：① dts 加 gpio-keys 两键（不同 code/debounce）；② 重启后 evtest 验证事件流；③ 写 epoll 小程序统计按键次数；④ 调 debounce 参数观察连击抑制效果；⑤ 加 wakeup-source 测 Stop 唤醒（联动 [[ch29-低功耗设计]]）。**验收**：全链打通且输出「debounce 参数影响对照表」，连击误报归零。

## 60.10 进阶话题
- IIO 触发缓冲工业用法：定时器触发多通道同步采样进 kfifo（思想同源 [[ch66-综合实战USB摄像头流采集服务]] 的 V4L2 缓冲队列）；
- 自写 leds trigger：把网络流量映射到呼吸灯频率——约 20 行代码的功能彩蛋；
- drivers/input/keyboard/gpio_keys.c 仅约 600 行，读透它等于读懂一个子系统；接口文档见 Documentation/ABI/testing/sysfs-class-*。

> [!warning]- ❓ FAQ
> **Q1：内核社区为什么废弃 sysfs GPIO？** 权限模型粗糙、无边沿事件通知能力、占用关系不可见——gpiod 字符设备三者齐备且极性由 dts 统一管理。
> **Q2：IIO 的 raw 和 scale 为什么分开暴露？** raw 是整数原始码适合进缓冲高速搬运；scale 由驱动按参考电压校准提供——分离保证精度与接口通用性。

> [!question] 📝 思考题
> 1. 列举至少三个内核废弃 sysfs GPIO 的技术理由。
> 2. 用 leds trigger 设计「网络活动+告警叠加」的双状态指示方案。
> 3. 给自制传感器写 IIO 驱动：列出需要实现的 ops 清单。

---
🏷️ #domain/linux #topic/gpio #topic/input #topic/iio | 🔗 [[ch59-platform驱动设备树regmap]] ← **本章** → [[ch61-中断下半部threaded-irq-workqueue]] | 📚 [[P6-MOC]]
