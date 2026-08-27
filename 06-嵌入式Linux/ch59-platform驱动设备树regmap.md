---
title: "第59章 Platform驱动与设备树：of API、regmap 与资源获取"
part: "[[P6-MOC]]"
chapter: 59
tags:
  - domain/linux
  - topic/platform
  - topic/regmap
difficulty: 3
est_minutes: 30
prerequisites:
  - "[[ch58-字符设备驱动hello-drv到并发安全]]"
related:
  - "[[ch40-内核适配与设备树dts语法-pinctrl-overlay]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第59章 Platform驱动与设备树：of API、regmap 与资源获取

> [!info] 导航
> ⏱ 30min | ★★★☆☆ | 前置 [[ch58-字符设备驱动hello-drv到并发安全]] | → [[ch60-子系统驱动GPIO-input-IIO-RTC-WDT]]

## 🎯 学习目标
- [ ] 默写 platform 驱动骨架五件套：probe/remove/of_match_table/pm_ops/module_platform_driver
- [ ] 说清从 dts 节点 compatible 匹配到 probe 执行的完整调用链
- [ ] 用 regmap 统一 MMIO/I2C/SPI 访问，并解释 devm_* 与 -EPROBE_DEFER 内部机制

## 59.1 platform 总线匹配流程：从 dts 节点到 probe
现代驱动的标准形态：platform_driver + dts 匹配 + 资源框架化获取，彻底告别硬编码物理地址。

1. 内核解析 dtb，每个含 `compatible` 的节点生成 platform_device 并挂上 platform 总线；
2. 驱动经 `module_platform_driver()` 注册后，driver core 用其 `of_match_table` 逐项比对设备节点 compatible 字符串；
3. 匹配成功回调 `.probe(pdev)`，此时 `pdev->dev.of_node` 就是那个 dts 子节点；
4. probe 内把 reg、interrupts、clocks、reset 属性逐一转换成可操作资源；
5. 返回 0 绑定完成；返回 `-EPROBE_DEFER(-517)` 则挂回 deferred_probe_list 尾部，supplier 注册后由触发器重扫重试——`cat /sys/kernel/debug/devices_deferred` 看「谁在等谁」。

## 59.2 关键代码：驱动骨架模板（背下来）

```c
static const struct of_device_id my_of_ids[] = {
    { .compatible = "myco,myip-1.0" },
    { /* sentinel */ }
};
MODULE_DEVICE_TABLE(of, my_of_ids);
static int my_probe(struct platform_device *pdev)
{
    struct device *dev = &pdev->dev;
    struct my_priv *priv = devm_kzalloc(dev, sizeof(*priv), GFP_KERNEL);
    priv->base = devm_platform_ioremap_resource(pdev, 0); /* reg=<...> 映射 */
    if (IS_ERR(priv->base)) return PTR_ERR(priv->base);
    priv->irq = platform_get_irq(pdev, 0);                /* interrupts 属性 */
    devm_request_irq(dev, priv->irq, my_isr, 0, "myip", priv);
    priv->clk = devm_clk_get_enabled(dev, NULL);          /* clocks 属性 */
    priv->rst = devm_reset_control_get_exclusive(dev, NULL);
    platform_set_drvdata(pdev, priv);
    return 0;   /* 失败路径 devm_* 自动逆序释放 —— goto cleanup 全淘汰 */
}
static struct platform_driver my_drv = {
    .probe  = my_probe, .remove = my_remove,
    .driver = { .name = "myip", .of_match_table = my_of_ids, .pm = &my_pm_ops }, };
module_platform_driver(my_drv);     /* 一行宏完成 init/exit 注册 */
```

## 59.3 of_ 系列 API 速查

| 需求 | API |
|------|-----|
| 读整数/数组 | `of_property_read_u32(np,"my-speed",&v)` 及 `_u32_array` |
| 读字符串 | `of_property_read_string(np,"label",&s)` |
| GPIO 描述符 | `devm_gpiod_get(dev,"reset",GPIOD_OUT_LOW)` 对应 dts reset-gpios |
| 中断号（推荐） | `platform_get_irq` 或 gpiod_to_irq |

## 59.4 regmap 抽象层：一套代码三种总线

```c
struct regmap_config cfg = {
    .reg_bits = 16, .val_bits = 8,     /* I2C 例：16 位地址 8 位数据 */
    .cache_type = REGCACHE_RBTREE,     /* 自动缓存，省总线往返 */
    .max_register = 0xFF,
};
priv->regmap = devm_regmap_init_i2c(client, &cfg);  /* 或 init_mmio/init_spi */
regmap_write(priv->regmap, REG_CTRL, 0x55);
```

- 同一份寄存器逻辑三种总线只换 init——芯片厂标配；内部机制：MMIO 快速路径用自旋锁（spinlock）保护并发，I2C/SPI 慢速总线经 mutex 串行化，上层统一 `regmap_read/write/update_bits`；
- `REGCACHE_RBTREE` 红黑树缓存：读先查缓存、未命中才触总线，周期轮询场景收益巨大；
- 附赠 debugfs `/sys/kernel/debug/regmap/*/registers` 一键 dump 全部寄存器——现场排障的免费午餐；寄存器含易变状态位时须声明 volatile 区间，否则读到旧值。

## 59.5 devm_* 资源管理、EPROBE_DEFER、模块参数与设备属性

```text
devm_* 本质：资源节点挂到 struct device 的 devres 链表，
probe 失败或 remove 时按【逆序】自动释放 —— 手写 goto cleanup 全淘汰。
EPROBE_DEFER：devm_clk_get 失败且原因=供应商未注册 → 返回 -517，
device 挂回 deferred_probe_list 尾部；supplier 注册完成 → 重扫全列表重试。
```

模块参数 `module_param(name, int, 0644)` 自动生成 `/sys/module/mydrv/parameters/name` 运行时开关（本章实验用它控制 defer 次数）；`DEVICE_ATTR_RO(label)` + sysfs group 给设备挂只读属性，用户态直接 `cat`，是 [[ch58-字符设备驱动hello-drv到并发安全]] ioctl 方案的轻量替代。

## 59.6 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| probe 反复不执行 | `dmesg \| grep deferred` | 补齐 supplier 或修 compatible 字符串 | deferred 列表清空且 probe 打印出现 |
| 寄存器读全零 | clk_summary | 先 get_enabled/deassert reset 再访问 | 与 datasheet 复位默认值一致 |
| regmap 读到旧值 | debugfs registers 与硬件对拍 | 配 volatile 区间或换 cache_type | 易变位读数实时刷新 |

## 59.7 实测数据表：读一次温度的总耗时（I2C@400kHz）

| 路径 | 耗时 | 备注 |
|------|------|------|
| i2cdetect 手工两事务 | ~0.9ms | 含用户态开销 |
| 裸 i2c_transfer（驱动内） | ~0.45ms | 两次总线事务物理极限 |
| regmap + 缓存命中 | ~0.05ms | 不触总线——周期轮询场景收益巨大 |

## 59.8 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| probe 没被调用 | compatible 不匹配或 supplier 未 ready（-EPROBE_DEFER） | `dmesg \| grep deferred`；核对 of_match 表字符串逐字符 |
| ioremap 后读全零 | 时钟未开或复位未释放 | clk_summary 确认使能；先 get_enabled 再访问 |
| irq 触发但 handler 不进 | dts 中断类型 flags 错或被其他驱动抢占 | /proc/interrupts 计数；`cat /proc/irq/N/spurious` |

## 59.9 部署注意事项
1. compatible 命名遵循「厂商,型号」小写规范，vendor prefix 需文档绑定；
2. probe 热路径禁止长延时等待（如固件加载）——async probe 或工作队列延后；
3. reset 框架先 deassert 再访问寄存器，顺序反了读全零还以为硬件坏了；
4. 多兼容型号用 of_match 的 `.data` 指针携带差异参数，一份驱动吃多颗料；只读 rootfs 下确认 sysfs 调试入口仍可用。

> [!example]- 🧪 动手实验 L59-1：驱动生命周期全事件观测（50 分钟）
> **步骤**：① 写最小 platform 驱动，probe/remove 各打印；② 用模块参数控制在成功前故意返回 -EPROBE_DEFER 三次；③ 观察 devices_deferred 与最终 probe 时序；④ rmmod→insmod 循环验证 remove 清理完整性；⑤ 注入 probe 中途失败验证 devm 自动回收。**验收**：产出一张「事件时间轴」截图——deferred 重试次数与注入值一致，rmmod 后无残留资源警告。

## 59.10 进阶话题
- device links（fw_devlink）：把 supplier/consumer 依赖显式化，defer 重试更精准；
- probe 异步化缩短整机串行 probe 时间——开机提速利器（衔接 [[ch56-启动流程深度剖析systemd提速]]）；电源管理钩子 SET_SYSTEM_SLEEP_PM_OPS/SET_RUNTIME_PM_OPS 的 suspend 四步职责清单见内核文档 devres/device_link；
- 开源范本 drivers/hwmon/tmp102.c 是本节骨架的官方真身，值得逐行精读。

> [!warning]- ❓ FAQ
> **Q1：devm_request_irq 和裸 request_irq 能混用吗？** 能但别混——同一驱动内两种生命周期并存极易漏释放，统一 devm_* 最稳。
> **Q2：regmap 相比直接 i2c_transfer 快在哪？** 首次访问多一层抽象开销可忽略；缓存命中后完全不触总线，轮询场景快一个数量级。

> [!question] 📝 思考题
> 1. -EPROBE_DEFER 机制如何解决「I2C 控制器还没 probe 完传感器就来」的问题？
> 2. 把 ch58 的 hello_drv 改造成 platform 版本，从 dts 读一个 label 属性并打印。
> 3. 设计 regcache 在「寄存器含易变状态位」场景下的失效策略。

---
🏷️ #domain/linux #topic/platform #topic/regmap | 🔗 [[ch58-字符设备驱动hello-drv到并发安全]] ← **本章** → [[ch60-子系统驱动GPIO-input-IIO-RTC-WDT]] | 📚 [[P6-MOC]]
