---
title: "Linux驱动开发实战"
date: 2025-09-09
category: "ZYNQ异构"
tags: ["ZYNQ", "Linux驱动", "设备树", "platform", "UART", "SPI", "I2C"]
description: "字符设备驱动、设备树进阶与platform驱动、UART/SPI/I2C/IIO外设驱动、Linux应用编程"
---

# Linux驱动开发实战

> 字符设备驱动、设备树进阶与platform驱动、UART/SPI/I2C/IIO外设驱动、Linux应用编程

## 目录

1. [[#字符设备驱动开发|字符设备驱动开发]]
2. [[#设备树进阶与 platform 驱动|设备树进阶与 platform 驱动]]
3. [[#常用外设驱动：UART / SPI / I2C / IIO|常用外设驱动：UART / SPI / I2C / IIO]]
4. [[#Linux 应用编程|Linux 应用编程]]

---

## 第17章 字符设备驱动开发
写一个真正的 Linux 内核模块，把第9章的 PL 寄存器安全地暴露给用户态 —— PLC 平台层的雏形。

**🎯 学习目标**
- 掌握字符驱动的完整框架：注册/file_operations/设备节点
- 理解内核空间与用户空间的数据交互边界
- 能独立完成「交叉编译模块→加载→应用访问」闭环

### 17.1 驱动在系统中的位置

| 类别 | 典型 | 接口形态 | 本课程涉及 

| 字符设备 | GPIO/UART/自定义IP | /dev/xxx 字节流 + ioctl | ★ 本章主角 

| 块设备 | eMMC/SD | 块缓存层 | 使用层面了解 

| 网络设备 | GEM 以太网 | socket 协议栈 | 使用层面了解 

驱动的价值：**把「物理事实」（寄存器地址、时序要求）封装在内核，给应用暴露统一抽象**。第28章我们会看到 UIO 这种「半自动」替代方案 —— 但先手写过一次，才知道 UIO 替你省了什么。

### 17.2 完整驱动源码 plc_led.c
```
// plc_led.c —— 控制第9章 led_ctrl IP 的字符驱动
#include <linux/module.h>
#include <linux/fs.h>
#include <linux/platform_device.h>
#include <linux/of.h>
#include <linux/io.h>
#include <linux/cdev.h>
#include <linux/uaccess.h>

#define DEV_NAME "plcled"
static dev_t          devid;
static struct cdev    cdev;
static struct class  *cls;
static void __iomem  *regs;            /* ioremap 后的虚拟地址 */

/* ---- file_operations：应用 open/read/write 的内核侧实现 ---- */
static ssize_t plc_write(struct file *f, const char __user *buf,
                         size_t len, loff_t *off)
{
    char kbuf[8] = {0};
    if (len > sizeof(kbuf) - 1) return -EINVAL;
    if (copy_from_user(kbuf, buf, len))       /* 用户指针不可直接解引用！ */
        return -EFAULT;

    /* 约定协议："0"=灭 "1"=流水 "2"=呼吸 */
    switch (kbuf[0]) {
    case '0': writel(0x0, regs + 0x00); break;
    case '1': writel(0x1, regs + 0x00); break;
    case '2': writel(0x3, regs + 0x00); break;
    default: return -EINVAL;
    }
    return len;
}

static ssize_t plc_read(struct file *f, char __user *buf,
                        size_t len, loff_t *off)
{
    char st = readl(regs + 0x08) & 0x1 ? 'R' : 'I';
    return simple_read_from_buffer(buf, len, off, &st, 1);
}

static int plc_open(struct inode *i, struct file *f) { return 0; }
static int plc_release(struct inode *i, struct file *f) { return 0; }

static const struct file_operations plc_fops = {
    .owner   = THIS_MODULE,
    .open    = plc_open,
    .release = plc_release,
    .read    = plc_read,
    .write   = plc_write,
};

/* ---- platform 探测：从设备树拿寄存器资源 ---- */
static int plc_probe(struct platform_device *pdev)
{
    struct resource *res;
    int ret;

    res = platform_get_resource(pdev, IORESOURCE_MEM, 0);
    if (!res) return -ENODEV;
    regs = devm_ioremap_resource(&pdev->dev, res);   /* 映射 0x43Cxxxxx */
    if (IS_ERR(regs)) return PTR_ERR(regs);

    /* 版本寄存器探测：硬件不在则明确失败 */
    if (readl(regs + 0x0C) != 0x20200901) {
        dev_err(&pdev->dev, "unexpected IP version\n");
        return -ENODEV;
    }

    ret = alloc_chrdev_region(&devid, 0, 1, DEV_NAME);
    cdev_init(&cdev, &plc_fops);
    cdev_add(&cdev, devid, 1);
    cls = class_create(THIS_MODULE, DEV_NAME);       /* 自动建节点 */
    device_create(cls, NULL, devid, NULL, DEV_NAME); /* → /dev/plcled */

    dev_info(&pdev->dev, "plc_led @ %pap ready\n", &res->start);
    return 0;
}

static int plc_remove(struct platform_device *pdev)
{
    device_destroy(cls, devid);
    class_destroy(cls);
    cdev_del(&cdev);
    unregister_chrdev_region(devid, 1);
    return 0;
}

static const struct of_device_id plc_of_match[] = {
    { .compatible = "demo,plc-io-v1" },     /* 与14章 DTS 节点呼应！ */
    { }
};
MODULE_DEVICE_TABLE(of, plc_of_match);

static struct platform_driver plc_driver = {
    .probe  = plc_probe,
    .remove = plc_remove,
    .driver = {
        .name = "plc-led",
        .of_match_table = plc_of_match,
    },
};
module_platform_driver(plc_driver);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("course");
MODULE_DESCRIPTION("PLC LED char driver");
```

### 17.3 交叉编译与加载
```
source ~/work/sdk/environment-setup-cortexa9t2hf-neon-xilinx-linux-gnueabi

# Makefile
cat > Makefile <<'EOF'
obj-m := plc_led.o
KDIR ?= ~/work/src/linux-xlnx        # 必须是板上同版本同配置的内核树
all:
	$(MAKE) ARCH=arm CROSS_COMPILE=arm-xilinx-linux-gnueabi- \
	        -C $(KDIR) M=$(PWD) modules
EOF
make && file plc_led.ko              # ARM ELF relocatable
scp plc_led.ko root@192.168.2.30:/usr/bin/

# 板上：
insmod /usr/bin/plc_led.ko && dmesg | tail -3
ls -l /dev/plcled                    # class_create 的成果
```

### 17.4 用户态验证程序
```
#include <stdio.h>
#include <fcntl.h>
#include <unistd.h>
int main(int argc, char **argv)
{
    int fd = open("/dev/plcled", O_RDWR);
    if (fd < 0) { perror("open"); return 1; }
    write(fd, argv[1], 1);            /* ./a.out 2 → 呼吸模式 */
    char st; read(fd, &st, 1);
    printf("status=%c\n", st);
    close(fd);
    return 0;
}
```

### 常见问题 FAQ（避坑指南）
Q1：insmod 报 Invalid module format / vermagic 不一致？模块的 vermagic 必须与运行内核完全匹配（版本号+抢占模型+SMP）。根因：用了不同 checkout 或不同 defconfig 的内核树编译。对策：modinfo plc_led.ko 对比板上 uname -a；确保 KDIR 正确且先 make 过该树。

Q2：Unknown symbol copy_from_user？漏 include `<linux/uaccess.h>`。内核符号按导出表解析，头文件即声明来源，别凭记忆猜函数签名 —— 全部以 `include/linux/*.h` 为准。

Q3：probe 没被调用？三级检查：① dts 节点的 compatible 与 of_match_table 是否逐字符一致；② 节点 status 是否 okay；③ 内核是否编入了 platform 总线（默认有）。用 `ls /sys/bus/platform/devices/ | grep 43c1` 确认设备已枚举。

Q4：为什么不能直接对 0x43C00000 解引用？内核开启 MMU 后一切地址皆虚拟。物理地址必须经 ioremap 映射，且用 readl/writel 访问（保证字节序与屏障语义）。直接野指针访问会触发 Oops —— 这正是第25章要练的分析对象。

**🧪 动手实验 L17-1：完善驱动 API**
为 plc_led 增加 `unlocked_ioctl`：命令字 `IOC_SET_SPEED`/`IOC_GET_VERSION`/`IOC_GET_KEYCNT`（后者需在 IP 里加按键计数逻辑，联动 L9-1）。编写对应测试程序并整理成 README —— 这个驱动将原样迁移进第28章的 PLC 平台层。

**📝 思考题**
- copy_to_user 为什么存在？如果驱动直接 memcpy 用户缓冲区会发生什么？
- 两个进程同时 write /dev/plcled，驱动需要加锁吗？什么时候必须加？（提示：读改写序列）
- 对比本章全定制驱动与第28章将用的 UIO 方案：开发效率/实时性/安全性各如何取舍？

### 17.5 深潜：miscdevice —— 十行注册一个设备节点
```
static struct miscdevice plc_misc = {
    .minor = MISC_DYNAMIC_MINOR,      /* 自动分配次设备号 */
    .name  = "plcled",                /* → /dev/plcled 自动出现 */
    .fops  = &plc_fops,               /* 复用第17.2的 file_operations */
    .mode  = 0666,
};
module_misc_device(plc_misc);         /* 一行完成注册+注销 */
/* 适用：单一节点、无需 class 分组的简单设备；多实例/分组仍用标准 cdev 流程 */
```

### 17.6 深潜：poll 完整实现（事件驱动应用的地基）
```
static DECLARE_WAIT_QUEUE_HEAD(plc_wq);
static bool data_ready;

static unsigned int plc_poll(struct file *f, poll_table *wait)
{
    unsigned int mask = 0;
    poll_wait(f, &plc_wq, wait);          /* 把本fd挂到wq（不阻塞！）*/
    if (data_ready) mask |= POLLIN | POLLRDNORM;
    if (!test_bit(0, &hw_present)) mask |= POLLERR;
    return mask;
}
/* ISR/工作线程置位后：data_ready = true; wake_up_interruptible(&plc_wq); */

/* 应用侧配套： */
struct pollfd p = { .fd = fd, .events = POLLIN };
int n = poll(&p, 1, 1000);
if (n > 0 && (p.revents & POLLIN)) read(fd, buf, sizeof buf);
```
⚠️ poll 三戒
① poll_wait 只挂队列不睡眠，真正睡在内核 poll 总入口；② 条件判定必须在 poll_wait **之后**再查一次（防唤醒丢失竞态）；③ 唤醒后必须消费数据并清标志，否则 epoll LT 模式将无限唤醒。

### 17.7 深潜：异步通知 SIGIO / fasync
```
static struct fasync_struct *plc_fa;
static int plc_fasync(int fd, struct file *f, int on)
{   return fasync_helper(fd, f, on, &plc_fa); }        /* 加入.fops->fasync */

/* 数据到达处（ISR安全）：kill_fasync(&plc_fa, SIGIO, POLL_IN); */

/* 应用侧三步：
   signal(SIGIO, handler);
   fcntl(fd, F_SETOWN, getpid());          /* 告知内核发给谁 */
   oflags = fcntl(fd, F_GETFL); fcntl(fd, F_SETFL, oflags | FASYNC); */
```
选型：poll/epoll 覆盖 95% 场景；SIGIO 适合「极低频关键事件 + 不想常驻线程」的老式程序。信号语义复杂（不可靠队列、全局处理函数），新代码优先 epoll。

### 17.8 深潜：错误码规范速查（返回值即文档）

| errno | 使用场景 | 反例警示 

| -EINVAL | 参数非法（越界地址/坏命令字） | 不要拿它表示"硬件忙" 

| -EAGAIN | 非阻塞下资源暂不可用（O_NDELAY 配套） | 阻塞模式下不该返回它 

| -ETIMEDOUT | 等待超时（poll等待/硬件应答超时） | - 

| -ENODEV/-ENXIO | 设备不存在/地址无对应设备 | probe 失败常用 ENODEV 

| -EBUSY | 独占资源被占（中断号/重复 open 策略） | 能用共享就别 BUSY 

| -EFAULT | copy_*_user 失败（坏指针） | 必须检查其返回值再转 EFAULT 

| -EIO | 底层 IO/硬件错误兜底 | 别用它掩盖具体原因，日志里写清楚 

[← 上一篇第16章 根文件系统与BusyBox](#ch16)
[下一篇 →第18章 设备树进阶与platform驱动](#ch18)

---

## 第18章 设备树进阶与 platform 驱动
从「能跑」到「专业」：资源管理、中断处理、sysfs 导出 —— 工业级驱动的三块拼图。

**🎯 学习目标**
- 吃透 platform 设备-总线-驱动匹配模型与 probe 时序
- 掌握 devm 资源族、中断申请、设备树自定义属性读取
- 会用 waitqueue/poll 实现「按键到来即唤醒应用」的异步模型

### 18.1 匹配模型一张图（文字版）
内核启动 → 解析 DTB，每个 `status="okay"` 且有 compatible 的节点生成 **platform_device** 挂到 platform 总线 → 驱动注册时声明 **of_match_table** → 字符串匹配成功即回调 `probe()`。所以：**DTS 写对 = 一半工作完成**。

💡 probe 失败的调试捷径
在 DTS 加 `pinctrl-name/debug`? 不如直接：dmesg 打开动态调试 `echo 'file plc*.c +p' > /sys/kernel/debug/dynamic_debug/control`；或在 probe 首行 dev_info 打印 res->start，确认资源解析正确再往下走。

### 18.2 设备树进阶：给硬件画像加细节
```
/* 扩展第14/15章的 plc_io 节点 */
plc_io@43c10000 {
    compatible = "demo,plc-io-v1";
    reg        = <0x43c10000 0x1000>;
    interrupt-parent = <&intc>;
    interrupts = <0 29 4>;              /* IRQ_F2P[0] */

    /* 自定义属性：驱动用 of_property_read_* 读取 */
    demo,di-channels   = <8>;           /* DI 通道数 */
    demo,do-channels   = <8>;           /* DO 通道数 */
    demo,scan-period-ms = <10>;         /* PL 内部滤波周期提示值 */

    clocks = <&clkc 15>;                 /* FCLK_CLK0 */
    clock-names = "axi_clk";
};
```

### 18.3 专业版 probe：devm 家族与错误回滚
```
static int plc_probe(struct platform_device *pdev)
{
    struct device *dev = &pdev->dev;
    struct resource *res;
    struct plc_priv *priv;
    int virq, ret, di_n = 8;

    priv = devm_kzalloc(dev, sizeof(*priv), GFP_KERNEL);
    if (!priv) return -ENOMEM;
    platform_set_drvdata(pdev, priv);

    /* 内存资源：devm 版本随 remove 自动释放，告别手工 iounmap */
    res  = platform_get_resource(pdev, IORESOURCE_MEM, 0);
    priv->base = devm_ioremap_resource(dev, res);
    if (IS_ERR(priv->base)) return PTR_ERR(priv->base);

    /* 时钟：FCLK 由 clock framework 管理 */
    priv->clk = devm_clk_get(dev, "axi_clk");
    if (IS_ERR(priv->clk)) return PTR_ERR(priv->clk);
    clk_prepare_enable(priv->clk);

    /* 自定义属性读取 */
    of_property_read_u32(dev->of_node, "demo,di-channels", &di_n);
    dev_info(dev, "DI channels = %d\n", di_n);

    /* 中断：platform_get_resource 或 of_irq_get 均可 */
    virq = platform_get_irq(pdev, 0);
    if (virq < 0) return virq;
    ret = devm_request_threaded_irq(dev, virq, NULL, plc_isr_thread,
                                    IRQF_ONESHOT, "plc-io", priv);
    if (ret) { clk_disable_unprepare(priv->clk); return ret; }

    init_waitqueue_head(&priv->wq);     /* 供 poll 使用 */
    return 0;                            /* devm 保证 remove 全自动回收 */
}
```

### 18.4 中断处理最佳实践

| 主题 | 要点 

| 上半部 vs 线程化 | 简单清标志用普通 request_irq；耗时处理（如解析数据）用 **threaded_irq**（handler=NULL, thread_fn 干活），享受可睡眠上下文 

| 触发标志 | 边沿型 PL 中断配 `IRQF_ONESHOT | IRQF_TRIGGER_RISING`，并在 IP 内保证「写 1 清除」 

| 中断风暴 | 若 ISR 里不清源标志，内核检测到高频重入会打印 *"irq N nobody cared"* 并禁用该中断 —— 排查第一嫌疑永远是「漏了 ack」 

| ISR 纪律 | 不 sleep、不 printk 大循环、不拿重量级锁；只做：读状态→清标志→置位/入队→wake_up 

```
static irqreturn_t plc_isr_thread(int irq, void *data)
{
    struct plc_priv *priv = data;
    u32 st = readl(priv->base + REG_STATUS);
    writel(st, priv->base + REG_ACK);       /* 写1清除，防风暴关键 */

    priv->events++;
    wake_up_interruptible(&priv->wq);       /* 唤醒阻塞在 poll/read 的应用 */
    return IRQ_HANDLED;
}

static unsigned int plc_poll(struct file *f, poll_table *pt)
{
    struct plc_priv *priv = ...;
    unsigned int mask = 0;
    poll_wait(f, &priv->wq, pt);
    if (priv->events != priv->events_seen) mask |= POLLIN | POLLRDNORM;
    return mask;
}
/* 应用侧：poll()/select() 监听 /dev/plcio，事件到达立即返回——
   这正是 PLC 运行时「输入变化即响应」的低延迟通道 */
```

### 18.5 sysfs 属性：给运维留窗口
```
static ssize_t scan_period_show(struct device *dev,
        struct device_attribute *attr, char *buf)
{   struct plc_priv *priv = dev_get_drvdata(dev);
    return sprintf(buf, "%u\n", priv->period_ms);
}
static ssize_t scan_period_store(struct device *dev,
        struct device_attribute *attr, const char *buf, size_t n)
{   struct plc_priv *priv = dev_get_drvdata(dev);
    kstrtouint(buf, 0, &priv->period_ms);          /* echo 20 > scan_period */
    writel(priv->period_ms, priv->base + REG_PERIOD);
    return n;
}
static DEVICE_ATTR_RW(scan_period);

/* probe 中：device_create_file(dev, &dev_attr_scan_period); */
# 板上使用：
cat /sys/devices/platform/.../plc_io@43c10000/scan_period
echo 20 >  .../scan_period
```

### 常见问题 FAQ（避坑指南）
Q1：request_irq 返回 -EBUSY？中断号被占。PL 中断默认独占，出现 EBUSY 多半是两个驱动都匹配到了同一节点，或上一模块没卸干净。lsmod 排查；确需共享才加 IRQF_SHARED 且 handler 必须判断是否属于自己的设备。

Q2：卸载模块后系统偶发崩溃？典型资源回收顺序问题：先注销 cdev/class 再释放寄存器映射；中断必须 free 后才能 unmap。全部改用 devm 族可让框架按依赖自动排序 —— 本章推荐做法的意义就在此。

Q3：of_property_read_u32 读不到值？属性名含逗号前缀（demo,di-channels），代码里要带全称；确认最终 DTB 已包含（dtc 反编译验证）；数值必须是 <...> 形式而非字符串。

**🧪 动手实验 L18-1：异步按键服务**
基于 18.3/18.4 骨架完成 plc_io 平台驱动：① 中断线程累计按键事件数并唤醒 poll；② 应用用 poll()+read() 打印每次事件的时间戳（clock_gettime）；③ 用示波器测量「按键按下→应用打印」延迟，记录数值 —— 它将成为第35章 PLC 输入响应测试的对照组。

**📝 思考题**
- 为什么 threaded_irq 能在 thread_fn 里调用可能睡眠的 API？它付出了什么代价？
- 设计「10 个 DI 通道任意变化都触发一次聚合中断」的 IP 硬件策略，避免每通道一根中断线。
- sysfs 与 ioctl 两种控制接口各适合什么场景？你的 PLC 项目会怎么选？

### 18.6 深潜：GPIO 新旧接口对照（gpiod 是未来）

| 操作 | legacy gpio_* | 描述符 gpiod_*(推荐) 

| 获取 `gpio_request(num,label)`| `devm_gpiod_get(dev,"enable",GPIOD_OUT_HIGH)`（DT属性名 xxx-gpios 自动匹配） 

| 方向/值 `gpio_direction_output(num,v)`| `gpiod_set_value_cansleep(desc,v)`（自动处理睡眠型控制器） 

| 中断 `gpio_to_irq(num)`| `gpiod_to_irq(desc)` 

| 优势 | - | 按名字取引脚(与板卡解耦)、活动极性由 DT 声明(GPIO_ACTIVE_LOW)驱动零改动、devm 自动释放 

### 18.7 深潜：regmap —— 总线无关的寄存器抽象
```
static const struct regmap_config plc_regmap = {
    .reg_bits = 32, .val_bits = 32, .reg_stride = 4,
    .max_register = 0x38,
    .cache_type = REGCACHE_RBTREE,          /* 读缓存+debugfs可见 */
};
priv->map = devm_regmap_init_mmio(dev, base, &plc_regmap);
regmap_write(priv->map, REG_CTRL, 1);
/* 价值：同一套业务代码可跑 MMIO/I2C/SPI 三种总线；
   /sys/kernel/debug/regmap/.../registers 直接 dump 全部寄存器快照 ★ */

```

### 18.8 深潜：pinctrl 与 ZYNQ 的关系

- pinctrl 子系统负责「引脚复用+电气组配置」。Zynq-7000 的 MIO 复用在 **FSBL/ps7_init 阶段已由 SLCR 写死**，内核 pinctrl-zynq 仅做少量补充 —— 所以你几乎不用写它；
- 需要它的场景：MPSoC(ZU+) 时代 MIO 配置移交设备树，pinctrl 变为主战场；以及 PL 侧 EMIO 引脚的电气参数经 PL 配置而非 pinctrl；
- 认知定位：读懂 `pinctrl-names/default/0` 属性在别的 SoC 驱动里的含义即可，Zynq7 项目不强制掌握。

### 18.9 深潜：devres 资源全家桶（错误回滚终结者）

| 类别 | devm 接口 | 非 devm 对应 

| 内存 | devm_kzalloc | kzalloc+kfree 

| IO映射 | devm_platform_ioremap_resource / devm_ioremap_resource | ioremap+iounmap 

| IRQ | devm_request_threaded_irq | request_irq+free_irq 

| 时钟 | devm_clk_get(_optional)+devm_clk_enable | clk_get/put+prepare/unprepare 

| GPIO | devm_gpiod_get_*  | gpiod_put 

| regmap | devm_regmap_init_mmio | regmap_exit 

纪律：**probe 中一律用 devm 版本**，remove 只处理「有顺序依赖的收尾」（如先停任务再 free IRQ）。混用时注意：devm 释放顺序晚于 remove，勿在 remove 后仍被回调。

### 18.10 深潜：写一份合格的 Binding 文档
自定义 IP 若要交付他人使用，配套 binding 是职业素养：

```
# Documentation/devicetree/bindings/plc/demo,plc-io-v1.yaml? (文本版示例)
demo,plc-io-v1 PLC IO engine
Required properties:
  - compatible : "demo,plc-io-v1"
  - reg        : AXI register window (size >= 0x1000)
  - interrupts : single SPI interrupt (level-high)
Optional:
  - demo,di-channels   : u32, default 8
  - demo,debounce-ms   : u32, default 10
Example:
  plc_io@43c10000 { compatible="demo,plc-io-v1"; reg=<0x43c10000 0x1000>;
                    interrupts=<0 29 4>; demo,di-channels=<8>; };
```

[← 上一篇第17章 字符设备驱动开发](#ch17)
[下一篇 →第19章 常用外设驱动](#ch19)

---

## 第19章 常用外设驱动：UART / SPI / I2C / IIO
站在子系统肩膀上：99% 的通用外设不需要自己写驱动，只需要「配好树 + 会用接口」。

**🎯 学习目标**
- 理解「子系统 core + 板级 driver」的内核分层设计
- 会用 spidev/i2c-dev 在用户态完成总线读写
- 掌握 IIO 子系统读取 XADC 模拟量 —— PLC 的 AI 通道就绪

### 19.1 分层思想：为什么不用自己写驱动

| 外设 | 内核已有组件 | 你要做的 | 用户态入口 

| UART0/1 | xuartps + tty 子系统 | DTS 打开 status 即可 | /dev/ttyPS0~1 + termios 

| SPI0/1 | spi-cadence + **spidev** | DTS 挂子设备节点 | /dev/spidevB.C + ioctl 

| I2C0/1 | i2c-cadence + i2c-dev | 同上 | /dev/i2c-N 或专用驱动绑定 

| XADC | **iio** + xadc 驱动 | DTS 节点使能 | /sys/bus/iio/devices/* 

| GEM 网卡 | macb + net 子系统 | PHY 地址/模式 | eth0 + socket 

💡 判断标准
遇到新外设先问一句：「上游有现成 compatible 吗？」（查 `Documentation/devicetree/bindings/`）。有 → 配树即可；无 → 才考虑自写驱动（第17/18章方法）。工业项目里自驱动的比例通常 <10%，且集中在 PL 自定义 IP。

### 19.2 SPI：以 spidev 访问外置 ADC 为例
```
/* system-user.dtsi */
&spi0 {
    status = "okay";
    adc@0 {
        compatible = "rohm,dh2228fv";   /* spidev 官方占位 compatible */
        reg = <0>;                       /* 片选0 */
        spi-max-frequency = <10000000>;  /* 10MHz */
    };
};
```
```
/* spidev 三步走：配置模式→收发→解析 */
#include <linux/spi/spidev.h>
#include <sys/ioctl.h>

int fd = open("/dev/spidev0.0", O_RDWR);
uint8_t mode = SPI_MODE_0, bits = 8;
uint32_t speed = 10000000;
ioctl(fd, SPI_IOC_WR_MODE,        &mode);
ioctl(fd, SPI_IOC_WR_BITS_PER_WORD, &bits);
ioctl(fd, SPI_IOC_WR_MAX_SPEED_HZ, &speed);

uint8_t tx[3] = {0x01, 0x80, 0x00}, rx[3];   /* 以MCP3204为例 */
struct spi_ioc_transfer t = {
    .tx_buf = (unsigned long)tx, .rx_buf = (unsigned long)rx,
    .len = 3, .speed_hz = speed, .bits_per_word = bits,
};
ioctl(fd, SPI_IOC_MESSAGE(1), &t);
int raw = ((rx[1] & 0x0F) << 8) | rx[2];
printf("adc=%d (%.3fV)\n", raw, raw * 3.3 / 4096);
```

### 19.3 I2C：i2c-tools 快速上手
```
# DTS 使能 i2c0 后：
i2cdetect -y 0                 # 扫描总线，列出在线从机地址
i2cget -y 0 0x50 0x00          # 读 EEPROM(AT24C02) 地址0
i2cset -y 0 0x50 0x00 0xAB     # 写一个字节
# 正式产品建议绑定具体驱动（at24/eeprom），而非裸 i2c-dev 操作
```

### 19.4 IIO 与 XADC：PLC 模拟量的正解 ★
ZYNQ 的 PS 内置双通道 12 位 XADC。Linux 通过 **IIO（Industrial I/O）子系统**统一暴露：

```
&xadc {                         /* dtsi 中已有节点，打开并声明使用通道 */
    status = "okay";
    xlnx,channels = <0x1 0x8>? /* 具体掩码按板卡 VAUX 接线填写，见 bindings */
};
```
```
cat /sys/bus/iio/devices/iio:device0/in_voltage0_raw      # 原始码值
cat .../in_voltage_scale                                   # 每 LSB 对应 mV
# 工程量换算：U(mV) = raw × scale
watch -n0.1 cat .../in_voltage0_raw                        # 实时观察电位器
```
📌 PLC 视角
IIO 提供了 buffer 模式（连续采样到 FIFO）与触发器机制。软 PLC 的 AI 更新率通常 ≤100Hz，直接轮询 raw 文件即可；若做高速录波再启用 buffer + hrtimer 触发 —— 第27章 PL 侧会给出更快的替代路径（PL 自采 AXI 上报）。

### 19.5 UART 应用编程要点（termios 最小集）
```
int fd = open("/dev/ttyPS1", O_RDWR | O_NOCTTY);
struct termios t;
tcgetattr(fd, &t);
cfmakeraw(&t);                                /* 8N1 原始模式 */
cfsetispeed(&t, B115200); cfsetospeed(&t, B115200);
t.c_cflag |= CLOCAL | CREAD;
t.c_cc[VMIN] = 0; t.c_cc[VTIME] = 10;         /* 1s 超时读 */
tcsetattr(fd, TCSANOW, &t);
write(fd, "AT\r\n", 4); read(fd, buf, sizeof(buf));
```

### 常见问题 FAQ（避坑指南）
Q1：spidev 加载时打印 "probe of ... rejected"？或没生成节点？新版内核限制任意 compatible 绑定 spidev。确认使用了官方白名单字符串（如 rohm,dh2228fv / linux,spidev 视版本而定），或修改驱动源码加自己的 compatible 后重编内核模块。

Q2：i2cdetect 全是 "--" 或 UU？"--"=无应答：查上拉电阻（板卡通常自带）与接线；"UU"=已被内核驱动占用属正常。另外注意 7 位地址 vs 8 位写地址的换算（工具用 7 位）。

Q3：in_voltage_raw 读出来恒定不变？XADC 输入范围 0~1V 且需确认通道确实接到 VP/VN 或 VAUX 引脚；分压电位器超量程会钳位在满码值。先用万用表验证引脚电压再怀疑软件。

**🧪 动手实验 L19-1：模拟量标定**
电位器接 XADC 通道：① 用万用表实测 5 个点位的电压，记录对应 raw×scale 读数；② 计算线性度误差与零偏；③ 写脚本把读数转换为 0~100% 工程量 —— 这套标定数据将用于第35章 PLC 的 AI 精度验收。

**📝 思考题**
- 同样是读 ADC，「IIO 子系统」比「自己写字符驱动」多了哪些能力？（缓冲、触发、单位、标准化命名……）
- spidev 全双工传输中，为什么即使只想读也必须发送等长字节？这是 SPI 协议的什么特性？
- 若 PLC 需要 8 路 16bit 1kSPS 同步采样，XADC 还够吗？给出你的硬件方案（提示：PL 外置多路同步 ADC + S_AXI_HP/DMA）。

### 19.6 深潜：PWM 子系统（sysfs 即用）
```
# DT: pwm@... { compatible="xlnx,axi-timer-2.0"? → 需 PWM 变体; 或用 axi-pwmgen 类IP }
echo 0 > /sys/class/pwm/pwmchip0/export
echo 1000000 > /sys/class/pwm/pwmchip0/pwm0/period     # ns
echo 300000 > /sys/class/pwm/pwmchip0/pwm0/duty_cycle  # 30%
echo 1 > /sys/class/pwm/pwmchip0/pwm0/enable
# 应用 API: pwm_get(dev,NULL)/pwm_config(p, duty_ns, period_ns)/pwm_enable
```

### 19.7 深潜：input 子系统（按键上报标准化）
```
static struct input_dev *idev;
idev = devm_input_allocate_device(dev);
idev->name = "plc-keys";
set_bit(EV_KEY, idev->evbit); set_bit(KEY_F1, idev->keybit);
input_register_device(idev);
/* 中断线程里： */
input_report_key(idev, KEY_F1, pressed); input_sync(idev);
/* 验证: evtest /dev/input/eventX —— 上层(Qt/SDL)零改动获得按键事件 */
```

### 19.8 深潜：watchdog 子系统（与34章联动）
```
# 标准接口：打开即启动喂狗倒计时
exec 3>/dev/watchdog          # 打开=激活
echo 30 > /sys/class/watchdog/watchdog0/timeout   # 若驱动支持可设
while :; do echo 1 >&3; sleep 10; done            # 周期喂
# nowayout(CONFIG_WATCHDOG_NOWAYOUT): 一旦启动无法关闭→断电才停（产品安全首选）
# 测试技巧：故意不喂，验证复位时间与 bootargs 里 watchdog 参数一致性
```

### 19.9 深潜：clk / regulator framework 概览

- **clk framework**：驱动用 `devm_clk_get(dev,"axi_clk") + clk_prepare_enable()` 获取时钟，频率来自 DT `clocks=<&clkc N>` —— 硬编码频率是移植杀手；调试入口 `/sys/kernel/debug/clk/clk_summary` 全树快照；
- **regulator framework**：电源轨抽象（enable/电压），Zynq 板多为固定常开轨，认知即可；MPSoC 复杂 PMIC 时必备。

### 19.10 深潜：IIO buffered 连续采集实战（XADC 流式）
```
/* 目标：脱离逐次读 sysfs，以 hrtimer 触发+内核缓冲连续采样 */
/* DT: 触发器 iio-hrtimer-dev? 用内置 hrtimer trigger:
   triggers { hrtimer0 { compatible = "iio,hrtimer-trigger"; freq=? }; } */

int fd = open("/dev/iio:device0", O_RDONLY);
/* 绑定触发器并使能扫描缓冲(sysfs操作)：
   echo /sys/bus/iio/devices/trigger0 > .../trigger/current_trigger
   echo 1 > .../scan_elements/in_voltage0_en ; echo 1 > buffer/enable */
char buf[64];
int n = read(fd, buf, sizeof buf);      /* 每次 read 返回一帧扫描样本 */
/* 解析按 scan_elements/en_in_voltage0_index 的位序拼装 */
/* 适用：kHz级录波。MHz级仍走 PL DMA(38章) —— 分工明确 */
```

[← 上一篇第18章 设备树进阶与platform驱动](#ch18)
[下一篇 →第20章 Linux应用编程](#ch20)

---

## 第20章 Linux 应用编程
第二篇收官：把系统调用、多线程、网络、时间四类 API 打包成「软 PLC 运行时」所需的全部编程能力。

**🎯 学习目标**
- 熟练运用文件 IO / pthread / socket 三大 API 族
- 掌握 clock_nanosleep 实现毫秒级精确周期任务
- 理解 mmap 直访寄存器的原理与适用边界

### 20.1 文件 IO：Linux 一切皆文件
```
#include <fcntl.h>   #include <unistd.h>   #include <errno.h>
#include <string.h>  #include <stdio.h>

int fd = open("/dev/plcio", O_RDWR);
if (fd < 0) {                       /* 错误处理标准姿势 */
    fprintf(stderr, "open failed: %s\n", strerror(errno));
    return -1;
}
ssize_t n = read(fd, buf, sizeof(buf));     /* n<0 错误；n==0 EOF */
write(fd, cmd, len);
close(fd);
```

### 20.2 多线程：运行时的骨架材料
```
#include <pthread.h>

/* 生产者-消费者：DI 中断事件 → 逻辑解算线程 */
typedef struct { int ch; int64_t ts_ns; } evt_t;
static evt_t      q[64]; static int qh = 0, qt = 0;
static pthread_mutex_t mtx = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t  has_evt = PTHREAD_COND_INITIALIZER;

void *logic_thread(void *arg)               /* 消费者 */
{
    for (;;) {
        pthread_mutex_lock(&mtx);
        while (qh == qt)                    /* 无事件则挂起等待 */
            pthread_cond_wait(&has_evt, &mtx);
        evt_t e = q[qt++ % 64];
        pthread_mutex_unlock(&mtx);
        handle_event(&e);                   /* 解算逻辑 */
    }
}

void push_event(int ch)                     /* 生产者(如中断监听线程) */
{
    pthread_mutex_lock(&mtx);
    q[qh++ % 64] = (evt_t){ch, now_ns()};
    pthread_cond_signal(&has_evt);
    pthread_mutex_unlock(&mtx);
}
/* main 中 pthread_create(&t, NULL, logic_thread, NULL); */
```

### 20.3 精确周期任务：PLC 扫描的心脏 ★
```
#include <time.h>

/* 关键：用绝对时间睡眠(TIMER_ABSTIME)，避免累计漂移 */
static void scan_loop_10ms(void (*task)(void))
{
    struct timespec next;
    clock_gettime(CLOCK_MONOTONIC, &next);
    for (;;) {
        task();                                   /* 读输入→解算→写输出 */

        next.tv_nsec += 10000000L;                /* +10ms */
        if (next.tv_nsec >= 1000000000L) {
            next.tv_nsec -= 1000000000L;
            next.tv_sec++;
        }
        do {
            int r = clock_nanosleep(CLOCK_MONOTONIC,
                                    TIMER_ABSTIME, &next, NULL);
            if (r == EINTR) continue;             /* 被信号打断重睡剩余 */
        } while (0);
    }
}
```

| 方案 | 典型抖动 | 说明 

| usleep 相对睡眠 | 毫秒级累计漂移 | ❌ 处理耗时被叠加进周期 

| clock_nanosleep ABSTIME | <100μs（默认内核） | ✅ 本课程采用；PREEMPT_RT 可再降一个量级 

| timer_create 信号/SIGEV_THREAD | 类似 | 适合回调型架构 

### 20.4 Socket：Modbus 与 Web 的地基
```
/* TCP 服务器最小骨架 —— 第32章 Modbus、33章 Web 都基于它扩展 */
int srv = socket(AF_INET, SOCK_STREAM, 0);
int yes = 1;
setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

struct sockaddr_in addr = { .sin_family = AF_INET,
    .sin_port = htons(502), .sin_addr.s_addr = INADDR_ANY };
bind(srv, (struct sockaddr *)&addr, sizeof(addr));
listen(srv, 4);

for (;;) {
    int cli = accept(srv, NULL, NULL);          /* 可 fork/pthread 处理 */
    handle_client(cli);                          /* 收发见第32章帧解析 */
    close(cli);
}
```

### 20.5 mmap：应用层直访寄存器（devmem 的原理）
```
#include <sys/mman.h>
int mfd = open("/dev/mem", O_RDWR | O_SYNC);
volatile uint32_t *regs = mmap(NULL, 4096, PROT_READ|PROT_WRITE,
                               MAP_SHARED, mfd, 0x43C10000);
uint32_t v = regs[1];                            /* 偏移 0x04 */
regs[0] = 1;                                     /* 偏移 0x00 */
munmap((void*)regs, 4096); close(mfd);
```
⚠️ mmap 调试用，产品慎用
/dev/mem 绕过了驱动的并发保护与权限管理。开发期快速验证寄存器行为很香（等价 devmem 命令），但正式架构请走驱动/UIO —— 第28章会给出完整对比。

### 常见问题 FAQ（避坑指南）
Q1：10ms 循环实测周期忽长忽短？抖动来源排查顺序：① 是否用了相对睡眠（漂移）；② printf/日志在循环内（串口阻塞可达百 ms！）；③ 内核调度干扰 —— 提升线程优先级 sched_setscheduler(SCHED_FIFO)；④ NFS/网络操作混入循环。工业级要求再上 PREEMPT_RT。

Q2：服务器重启后 bind 报 Address already in use？TCP TIME_WAIT 状态残留，SO_REUSEADDR 已在代码中解决；若仍报错检查是否有旧进程存活（ps/netstat -ltnp）。

Q3：子线程崩溃整个程序退出？POSIX 线程共享进程地址空间，任何线程段错误都终止进程。对策：关键线程入口包 pthread_cleanup 与信号处理；上线前用 -fsanitize=address 在主机侧预演内存错误。

**🧪 动手实验 L20-1：三线程迷你运行时**
实现 `mini_rt.c`：① 扫描线程 10ms 周期读 /dev/plcled 状态并维护计数；② 通信线程 TCP 9999 端口接收 "GET\r\n" 返回 JSON 计数；③ 监控线程每秒打印各线程 CPU 占用（getrusage）。测量 30 分钟内扫描周期最大/平均抖动并记录 —— 这就是你的第一个「运行时」原型。

### 第二篇通关自测

| 能力项 | 达标标准 

| 启动链路 | 能徒手写出 boot.bif 并解释五级火箭每一级的交接物 

| PetaLinux | NFS 开发模式下改一行代码到板上生效 ≤3 分钟 

| 驱动开发 | 能独立完成 DT 节点→platform 驱动→字符设备接口→用户测试 全链路 

| 外设复用 | spidev/i2c-tools/IIO 三板斧信手拈来 

| 应用编程 | 能写出带互斥队列的 10ms 周期多线程程序并量化其抖动 

**📝 思考题**
- 为什么扫描线程与通信线程之间必须用互斥队列而不是全局变量直接交换数据？（提示：可见性与撕裂读）
- CLOCK_MONOTONIC 与 CLOCK_REALTIME 的区别是什么？PLC 计时为何必须用前者？
- 如果要给扫描线程做看门狗（卡死自动重启进程），你会怎么设计？

### 20.6 深潜：epoll LT/ET 全对比与惊群

| 维度 | LT 水平触发(默认) | ET 边沿触发 

| 通知时机 | 只要可读/写就持续通知 | 状态**变化**仅通知一次 

| 编程要求 | 可分次读 | 必须循环 read 到 EAGAIN ★ 

| 适用 | 常规业务（推荐默认） | 高吞吐代理/追求少唤醒 

| 坑 | - | 漏读到残留→"假死"；非阻塞fd是前提 

```
/* ET 正确姿势 */
for (;;) {
    ssize_t n = read(fd, buf, sizeof buf);
    if (n > 0) { handle(buf, n); continue; }
    if (n == 0) { peer_closed(); break; }
    if (errno == EAGAIN || errno == EWOULDBLOCK) break;  /* 读完 */
    die("read");
}
/* accept 惊群：多进程/线程共享监听 fd 时新连接唤醒全部
   解法：EPOLLEXCLUSIVE 标记(4.5+) / SO_REUSEPORT 内核分流 / 单accept线程分发 */
```

### 20.7 深潜：eventfd / timerfd / signalfd 三剑客
把「信号、定时器、事件通知」全部变成 **普通文件描述符**，从而统一进 epoll —— 现代事件驱动架构的基石：

```
int efd = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);   /* 跨线程唤醒管道 */
uint64_t one = 1; write(efd,&one,8);                /* 通知方 */
epoll_ctl(ep, ADD, efd, ...);                       /* 监听方统一等待 */

int tfd = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK);
struct itimerspec its = { .it_value={1,0}, .it_interval={0,100*1000000L} };
timerfd_settime(tfd, 0, &its, NULL);               /* 100ms 周期 → 可poll的定时器 */

sigset_t mask; sigemptyset(&mask); sigaddset(&mask,SIGTERM);
sigprocmask(SIG_BLOCK,&mask,NULL);
int sfd = signalfd(-1,&mask,SFD_NONBLOCK);          /* 优雅退出也进 epoll 循环 */
```
💡 架构启示
PLC 运行时的通信线程用「epoll + (listen_fd + rpmsg? tcp连接们 + timerfd + signalfd)」即可实现零锁单线程高并发 —— 与第29章多线程模型互为补充：IO密集走单reactor，计算密集才开worker。

### 20.8 深潜：POSIX 共享内存 IPC 实战
```
/* 多进程共享 PLC 映像区（替代 pthread mutex 的跨进程版）*/
int fd = shm_open("/plc_image", O_CREAT|O_RDWR, 0666);
ftruncate(fd, sizeof(image_t));
image_t *img = mmap(NULL, sizeof(image_t), PROT_READ|PROT_WRITE,
                    MAP_SHARED, fd, 0);

pthread_mutexattr_t attr; pthread_mutexattr_init(&attr);
pthread_mutexattr_setpshared(&attr, PTHREAD_PROCESS_SHARED);   /* 关键！ */
pthread_mutex_init(&img->mtx, &attr);      /* 锁放共享区首部，各进程直接用 */
```

### 20.9 深潜：守护进程正确写法（double fork）
```
pid_t p = fork();  if (p > 0) exit(0);        /* 父退出→被init收养 */
setsid();                                     /* 新会话，脱离终端控制 */
signal(SIGHUP, SIG_IGN);
p = fork(); if (p > 0) exit(0);               /* 二次fork:永不获得tty */
umask(027); chdir("/");
int n = open("/dev/null", O_RDWR);
dup2(n,0); dup2(n,1); dup2(n,2);              /* 三标准流重定向，防意外阻塞 */
openlog("plc", LOG_PID, LOG_DAEMON);          /* 之后统一 syslog */
```

### 20.10 深潜：C11 原子操作与内存序速成（衔接37章屏障）

| 序 | 保证 | 典型用途 

| relaxed | 仅原子性，无顺序 | 统计计数 

| acquire / release | 配对使用建立 happens-before（发布数据） | 发布-订阅标志+数据包 ★ 

| acq_rel / seq_cst | 读改写全序 | 自旋锁、全局序列化点 

```
/* 经典发布模式：先写数据，后置标志(release)；读者 acquire 后必见完整数据 */
data->payload = compute();                       /* 普通 写 */
atomic_store_explicit(&ready, 1, memory_order_release);
if (atomic_load_explicit(&ready, memory_order_acquire))
    use(data->payload);                          /* 保证可见 */
```

### 20.11 深潜：极简线程池骨架
```
typedef void (*job_t)(void *arg);
static struct { job_t fn; void *arg; } jobs[64];
static int jh=0, jt=0; static volatile int running=1;
static pthread_cond_t cv=PTHREAD_COND_INITIALIZER;
static pthread_mutex_t m=PTHREAD_MUTEX_INITIALIZER;

static void *worker(void *a){
    for(;;){
        pthread_mutex_lock(&m);
        while(jh==jt && running) pthread_cond_wait(&cv,&m);
        if(!running && jh==jt){ pthread_mutex_unlock(&m); return NULL; }
        struct { job_t fn; void *arg; } j = jobs[jt++ % 64];
        pthread_mutex_unlock(&m);
        j.fn(j.arg);
    }
}
void pool_submit(job_t f,void *a){ pthread_mutex_lock(&m);
    jobs[jh++]=(typeof(jobs[0])){f,a}; pthread_cond_signal(&cv); pthread_mutex_unlock(&m);}
/* 初始化：创建 N 个 worker；退出：running=0 + broadcast + join */
```

[← 上一篇第19章 常用外设驱动](#ch19)
[下一篇 →第21章 ILA/VIO在线逻辑调试](#ch21)

---

