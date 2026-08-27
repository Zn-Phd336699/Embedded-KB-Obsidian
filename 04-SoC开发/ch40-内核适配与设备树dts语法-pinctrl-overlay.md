---
title: "第40章 内核适配与设备树dts语法-pinctrl-overlay"
part: "[[P4-MOC]]"
chapter: 40
tags:
  - domain/soc
  - domain/linux
  - topic/device-tree
difficulty: 4
est_minutes: 45
prerequisites:
  - "[[ch39-U-Boot移植与网络开发模式]]"
related:
  - "[[ch59-platform驱动设备树regmap]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第40章 内核适配与设备树dts语法-pinctrl-overlay

> [!info] 导航
> ⏱ 45min | ★★★★☆ | 前置 [[ch39-U-Boot移植与网络开发模式]] | → [[ch41-Buildroot定制rootfs全流程]]

## 🎯 学习目标
- [ ] 掌握节点/属性/phandle 引用语法与 compatible 匹配机制
- [ ] 编写 pinctrl 节点完成引脚复用配置并解读 pad ctrl 十六进制值
- [ ] 用 dtbo overlay 实现「不改基线」扩展，并用 devices_deferred/clk_summary/pinctrl-handles 定位 probe 失败

## 40.1 设备树核心语法速成
```dts
/dts-v1/;
/ {
    compatible = "fsl,imx6ull-14x14-evk", "fsl,imx6ull"; /* 逐级匹配驱动 */
    chosen { stdout-path = &uart1; bootargs = "console=ttymxc0,115200"; };
    soc {
        uart1: serial@2020000 {
            compatible = "fsl,imx6ul-uart", "fsl,imx6q-uart";
            reg = <0x02020000 0x4000>;      /* 寄存器基址+长度 */
            interrupts = <GIC_SPI 26 IRQ_TYPE_LEVEL_HIGH>;
            clocks = <&clks IMX6UL_CLK_UART1_IPG>;
            status = "okay";                /* disabled=不上电不探测 */
        };
    };
};
/* &uart1 是 phandle 引用：别处可追加属性而不重写节点；运行态取证 dtc -I fs /proc/device-tree；匹配流程：of_match_table 的 compatible 精确比对 → 调 probe() */
```

## 40.2 pinctrl：引脚复用的标准姿势
```dts
&iomuxc {
    pinctrl_uart1: uart1grp {
        fsl,pins = <
            MX6UL_PAD_UART1_TX_DATA__UART1_DCE_TX  0x1b0b1  /* 功能+电气(pad ctrl)，RX 同理 */
        >;
    };
};
&uart1 { pinctrl-names = "default"; pinctrl-0 = <&pinctrl_uart1>; status = "okay"; };
/* pad ctrl 位域 HYS|PUS(上下拉)|PUE|PKE|速度|驱动强度|SRE：0x1b0b1=上拉22K+中速+R0/6，抄参考设计起步示波器微调 */
```

## 40.3 Overlay（dtbo）工作流
```dts
/* base.dts 保持厂商原样，板级差异全走 overlay —— 升级内核零冲突 */
/dts-v1/; /plugin/; #include <dt-bindings/gpio/gpio.h>
&{/soc/i2c1@21a0000} {
    status = "okay";
    oled@3c { compatible = "solomon,ssd1306fb-i2c"; reg = <0x3c>; reset-gpios = <&gpio4 9 GPIO_ACTIVE_LOW>; };
};
```
```bash
dtc -@ -I dts -O dtb -o my-board.dtbo my-overlay.dts   # -@生成符号表必须！
# 应用三式 ① U-Boot:  fdt addr ${fdt_addr} ; fdt apply ${loadaddr}
# ② 运行态:  dtoverlay /lib/firmware/my-board.dtbo (configfs API)
# ③ Armbian: armbianEnv.txt 里 overlays=my-board 自动链
```

## 40.4 原理深挖：从 dts 到 probe 的完整调用链
| 阶段 | 内核动作 | 你能在哪看到 |
|------|----------|--------------|
| dtb 解析 | unflatten 生成 device_node 树 | /sys/firmware/devicetree/ |
| 总线匹配 | of_platform_populate 为 memory-mapped 节点建 platform_device | /sys/bus/platform/devices/ |
| 驱动注册 | platform_driver_register 触发 bus 遍历 | dmesg 的 of: 日志(initcall_debug) |
| match 成功 | 调 probe；资源按 devm 生命周期管理 | ls -l .../devices/*/driver |
| -EPROBE_DEFER | 依赖未就绪→重新排队，supplier ready 后重试 | /sys/kernel/debug/devices_deferred ★金矿 |

debugfs 工具箱：时钟实况 `clk/clk_summary`、引脚实况 `pinctrl/pinctrl-handles`、中断映射对照 `/proc/interrupts`。regmap 红利：挂上 regmap 的设备自动获得 registers dump——自研 IP 也建议包一层 regmap_mmio（platform/regmap 全景见 [[ch59-platform驱动设备树regmap]]）。
## 40.5 关键代码：SoC 端 LED 平台驱动全栈（dts→驱动→用户态）
```dts
leds {
    compatible = "gpio-leds";
    status_led { gpios = <&gpio1 3 GPIO_ACTIVE_HIGH>; default-state = "on"; linux,default-trigger = "heartbeat"; };
};
```
```c
/* myled.c —— 自研寄存器级 LED 控制器(示例 IP)的 platform 驱动 */
static int myled_probe(struct platform_device *pdev)
{
    struct myled *m = devm_kzalloc(&pdev->dev, sizeof(*m), GFP_KERNEL);
    m->base = devm_platform_ioremap_resource(pdev, 0);
    if (IS_ERR(m->base)) return PTR_ERR(m->base);
    if (!of_property_read_bool(pdev->dev.of_node, "myled,invert"))
        m->flags |= MYLED_ACTIVE_HIGH;      /* 可选属性读取 */
    dev_set_drvdata(&pdev->dev, m);
    return led_classdev_register(&pdev->dev, &m->cdev); /* 挂标准 LED 子系统 */
}
static const struct of_device_id myled_ids[] = { { .compatible = "myco,myled-1.0" }, {} };
module_platform_driver(...); MODULE_LICENSE("GPL"); /* 用户态即刻可用： echo heartbeat > /sys/class/leds/status_led/trigger */
```

## 40.6 实测数据表：probe 失败错误码速诊表
| 返回值 | 含义 | 第一排查动作 |
|--------|------|--------------|
| -517 EPROBE_DEFER | 依赖资源未就绪 | cat devices_deferred 看等谁 |
| -19 ENODEV | 没找到期望资源 | dts reg/interrupts 属性核对；EBUSY 则查同地址被谁先占 |
| -2 ENOENT | 时钟/引脚名不匹配 | binding 文档逐字对 clock-names |
| (无输出) | 根本没匹配 | compatible 字符串逐字符 diff(空格/大小写) |

## 40.7 排故速查表
| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 驱动 probe 未执行 | compatible 不匹配/status=disabled/依赖时钟缺失 | initcall_debug；of_device_is_available 手动检查 |
| overlay apply 失败 | 没加 -@ 符号表/引用路径不存在 | fdt 工具核对 __symbols__ 节点存在性 |
| 引脚功能不对/中断号错 | 组未挂到设备/两组抢占/GIC SPI 基数 32 偏移 | pinctrl-pins 看 mux 实值；/proc/interrupts 显示 linux irq=dts 硬件号+32 |

## 40.8 部署注意事项
1. base.dts 保持厂商原样、板级差异全走 overlay——内核升级零合并冲突；构建脚本强制校验基线含 `__symbols__`（dtc -@）；
2. pinctrl 与 sleep 状态：`pinctrl-1 = <&sleep_grp>` 配合 pm_ops 自动切脚态——休眠漏电问题的系统性解法；
3. review dts 先 review binding（Documentation/devicetree/bindings/ 下 yaml 即接口契约），能挡掉一半低级错误。

> [!example]- 🧪 动手实验 L40-1：overlay 点灯全链路（45 分钟）
> **步骤**：① 写 dtbo 使一个空闲 GPIO 成为 gpio-leds 节点；② U-Boot fdt apply 或运行态 configfs 应用；③ /sys/class/leds 出现新灯并 trigger 心跳；④ 故意写错 compatible 重演「静默不匹配」，用 devices_deferred+dmesg 定位。
> **验收**：从编译 dtbo 到心跳灯亮全程 ≤10 分钟——这是 BSP 工程师的日常速度基线。

## 40.9 进阶话题
- Binding 即契约：先读 yaml 再写节点；overlays 符号陷阱——引用不存在 phandle 时 dtc -@ 编译期就报错，符号校验应进 CI；
- 扩展阅读：内核文档 usage-model.rst；《Linux Device Drivers》4th draft；drivers/leds/leds-gpio.c 是 myled 的真身原型（200 行读完）；fdtdump/fdtget 解剖 dtb 二进制。

> [!warning]- ❓ FAQ
> **Q1：status="disabled" 的节点会怎样？** 不上电、不创建设备、不探测——排障第一步确认它不是 disabled。
> **Q2：为什么 /proc/interrupts 的中断号和 dts 对不上？** dts 写 GIC_SPI 硬件号，Linux irq 从基数 32 起算，固定差 32。

> [!question] 📝 思考题
> 1. 把 ch35 的 LCD 时序参数改写成 panel 节点完整属性。
> 2. 设计「同一内核镜像 + 三种外设套件」的 overlay 矩阵管理方案。
> 3. 解释为什么设备树要区分 memory-mapped 的 reg 与虚拟概念如 gpio 编号。

---
🏷️ #domain/soc #domain/linux #topic/device-tree | 🔗 [[ch39-U-Boot移植与网络开发模式]] ← **本章** → [[ch41-Buildroot定制rootfs全流程]] | 📚 [[P4-MOC]]
