---
title: "第58章 字符设备驱动hello-drv到并发安全"
part: "[[P6-MOC]]"
chapter: 58
tags:
  - domain/linux
  - topic/driver
difficulty: 4
est_minutes: 45
prerequisites:
  - "[[ch40-内核适配与设备树dts语法-pinctrl-overlay]]"
  - "[[ch55-交叉编译与sysroot]]"
related:
  - "[[ch60-子系统驱动GPIO-input-IIO-RTC-WDT]]"
  - "[[ch61-中断下半部threaded-irq-workqueue]]"
  - "[[ch62-应用编程epoll进程线程IPC]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第58章 字符设备驱动hello-drv到并发安全

> [!info] 导航
> ⏱ 45min | ★★★★☆ | 前置 [[ch40-内核适配与设备树dts语法-pinctrl-overlay]] | → [[ch59-platform驱动设备树regmap]]

## 🎯 学习目标
- [ ] 独立完成字符驱动的 cdev 注册三步（alloc_chrdev_region→cdev_init/cdev_add→节点创建）与卸载逆序清理
- [ ] 正确使用 copy_to/from_user 并解释用户指针不可直接解引用的底层原因
- [ ] 按场景为驱动选对 mutex/spinlock，并用 wait_queue+poll 打通 epoll 监听全链

## 58.1 最小可用字符驱动（file_operations 全套）
一切驱动的心智原型：`file_operations` 四件套 + `copy_to/from_user`。构建：树外模块 `obj-m := hello_drv.o`，`$(MAKE) -C $(KDIR) M=$(PWD) ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf- modules`；板上 insmod 后 cat/echo `/dev/hello` 即可验证。
```c
#include <linux/module.h>
#include <linux/fs.h>
#include <linux/uaccess.h>
#include <linux/cdev.h>
static char msg[64] = "hello from kernel\n";
static dev_t devid; static struct cdev mycdev; static struct class *cls;
static ssize_t hello_read(struct file *f, char __user *ub, size_t sz, loff_t *off){
    return simple_read_from_buffer(ub, sz, off, msg, sizeof(msg));
}
static ssize_t hello_write(struct file *f, const char __user *ub, size_t sz, loff_t *off){
    if (sz > sizeof(msg)) return -EINVAL;
    if (copy_from_user(msg, ub, sz)) return -EFAULT; /* 必须！用户指针不可直接解引用 */
    return sz;
}
static const struct file_operations fops = {
    .owner = THIS_MODULE, .read = hello_read, .write = hello_write,
};
static int __init hello_init(void){
    alloc_chrdev_region(&devid, 0, 1, "hello");    /* 注册三步① 申请设备号 */
    cdev_init(&mycdev, &fops); cdev_add(&mycdev, devid, 1);  /* ②绑fops ③注册 */
    cls = class_create(THIS_MODULE, "hello");      /* class+device 自动建 /dev/hello */
    device_create(cls, NULL, devid, NULL, "hello");
    return 0;
}
static void __exit hello_exit(void){              /* 卸载逆序清理 */
    device_destroy(cls, devid); class_destroy(cls);
    cdev_del(&mycdev); unregister_chrdev_region(devid, 1);
}
module_init(hello_init); module_exit(hello_exit);
MODULE_LICENSE("GPL");
```

## 58.2 用户态到内核调用路径与边界规则
| 层次 | 动作 | 关键校验 |
|------|------|------|
| glibc/VFS | read() 经 SVC 陷入；file→f_op 定位、pos 校验 | O_NONBLOCK 标志经 f_flags 传入 |
| 字符层 | cdev_get → 你的 hello_read | f_pos 加锁(POSIX 读写原子语义) |
| 你的驱动 | copy_to_user(buf,msg,n) | access_ok 已内含；返回未拷贝数要处理 |
| 返回约定 | 正数=字节数、0=EOF、负值=-errno | 实现 poll 挂 wait queue，epoll 才能工作(ch62) |
| 边界铁律 | 用户指针必须 copy_to/from_user | 地址空间隔离+缺页处理；直接解引用=漏洞 |

## 58.3 关键代码扩展：阻塞读 + ioctl + poll
```c
static DECLARE_WAIT_QUEUE_HEAD(rq); static bool data_ready; static DEFINE_MUTEX(m);
static ssize_t my_read(struct file *f, char __user *ub, size_t sz, loff_t *off){
    int ret = wait_event_interruptible(rq, data_ready);
    if (ret) return -ERESTARTSYS;         /* 被信号打断 */
    /* ... 取数据 ... */ data_ready = false; return n;
}
/* 生产者侧： data_ready=true; wake_up_interruptible(&rq); */
#define HELLO_SET_MSG _IOW('H',2,char[64])
static long hello_ioctl(struct file *f, unsigned cmd, unsigned long arg){
    switch(cmd){
    case HELLO_SET_MSG:{ char tmp[64];
        if(copy_from_user(tmp,(void*)arg,64)) return -EFAULT;
        mutex_lock(&m); memcpy(msg,tmp,64); mutex_unlock(&m);
        data_ready=true; wake_up_interruptible(&rq); return 0; }
    default: return -ENOTTY; }
}
static __poll_t hello_poll(struct file *f, poll_table *w){
    poll_wait(f,&rq,w);
    return data_ready? EPOLLIN|EPOLLRDNORM : 0;   /* epoll 联动关键! */
}
```

## 58.4 并发安全：mutex vs spinlock 选择原则
选择原则一句话：**会睡眠/持锁时间长 → mutex；中断上下文或极短临界区 → spinlock（中断共享须 irqsave）**。
| 场景 | 选择 | 理由 |
|------|------|------|
| 中断上下文共享数据 | spin_lock_irqsave | 不能睡眠，需屏蔽本地中断 |
| 进程上下文短临界区 | spin_lock_bh / mutex | 持锁<百µs 用 spin；可能睡用 mutex |

```c
/* miscdevice 捷径：单节点小驱动生产版形态，一行顶四步(免设备号/class/device 管理) */
static struct miscdevice hello_misc = { .minor = MISC_DYNAMIC_MINOR, .name = "hello", .fops = &fops };
misc_register(&hello_misc);      /* 卸载用 misc_deregister；主设备号固定 10 */
```

## 58.5 实测数据表：并发读写下的正确性验证矩阵
| 场景 | 无锁结果 | mutex 后 |
|------|------|------|
| 4 进程并发 write 不同消息 | 消息交错撕裂 | 完整有序 |
| write+read 同时进行 | 读到半条消息 | 原子可见 |
| ioctl 与 write 竞争 | len 与数据不一致 | 一致 |

## 58.6 排故速查表
| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| insmod 报 Invalid module format | vermagic 不匹配(内核版本/编译选项) | modinfo 对比；同源内核树重编；CONFIG_MODVERSIONS |
| cat 设备后系统卡死 | read 里死等没唤醒源 | SysRq+t 打印所有任务栈定位卡点 |
| 偶发 oops/Bad swap file entry | copy_to_user 返回值没查/越界拷贝 | 加 access_ok 校验；CONFIG_KASAN 抓越界 |
| rmmod 后残留引用崩溃 | 引用计数/回调未注销 | .owner=THIS_MODULE；exit 里逆序清理全部注册项 |

## 58.7 部署注意事项
1. `.owner = THIS_MODULE` 一个都不能漏——它是 rmmod 与 open/read 竞态的第一道防线。
2. exit 函数必须与 init 严格逆序：device_destroy → class_destroy → cdev_del → unregister_chrdev_region。
3. 任何异步回调持有资源前先 kref_get——rmmod 竞态是驱动崩溃榜第一名。

> [!example]- 🧪 动手实验 L58-1：从编译到 epoll 全链打通（60 分钟）
> **步骤**：① 编译 hello_drv.ko 并 insmod(QEMU 或真机)；② 写多线程写入者 + epoll 监听读取者两程序，验证 poll 唤醒与数据完整性；③ 发 SIGINT 注入「读时被信号打断」观察 -ERESTARTSYS 行为；④ stress 并发跑 10 分钟无 oops。**验收**：一套可复用的驱动测试脚手架入库。

## 58.8 进阶话题
- 锁选择表在 ch61 threaded irq 中深化：中断下半部上下文同样禁睡。
- 为什么 read 有 simple_read_from_buffer 而 write 没有对称助手？写路径常伴随解析/校验逻辑，通用化收益低。
- 命令编码规范见 Documentation/driver-api/ioctl.rst；流设备标 `.llseek = no_llseek`；64 位内核跑 32 位应用且 ioctl 含指针需补 compat_ioctl(A64 常见坑)；范本 drivers/char/misc.c + LDD3 第 6 章。

> [!warning]- ❓ FAQ
> **Q1：copy_to_user 返回值是什么语义？** 未成功拷贝的字节数（0=全部成功）——不是 errno！非零时应向上返回 -EFAULT。
> **Q2：mutex 能否用于中断处理函数？** 绝对不能。mutex 可能睡眠，中断上下文禁止睡眠；中断与进程共享数据用 spin_lock_irqsave。

> [!question] 📝 思考题
> 1. 解释为什么 read 可以用 simple_read_from_buffer 而 write 没有对称助手？
> 2. 推演两个进程同时 write 时的竞争窗口及修复方案。

---
🏷️ #domain/linux #topic/driver | 🔗 [[ch57-根文件系统构建只读overlayfs]] ← **本章** → [[ch59-platform驱动设备树regmap]] | 📚 [[P6-MOC]]
