---
title: "第30章 Bootloader/IAP/OTA 固件升级体系"
part: "[[P3-MOC]]"
chapter: 30
tags:
  - domain/mcu
  - topic/bootloader
difficulty: 5
est_minutes: 45
prerequisites:
  - "[[ch29a-电源异常与掉电保护]]"
related:
  - "[[ch06-链接器与内存布局]]"
  - "[[ch24-中断系统与NVIC深度应用]]"
  - "[[ch89-P3-MCUboot双分区OTA安全升级系统]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第30章 Bootloader/IAP/OTA 固件升级体系

> [!info] 导航
> ⏱ 45min | ★★★★★ | 前置 [[ch29a-电源异常与掉电保护]] | → [[ch31-ESP-IDF入门]]

## 🎯 学习目标
- [ ] 设计双分区 Flash 映射与「TESTING→CONFIRMED→REVERT」升级状态机
- [ ] 逐字理解并实现跳转 APP 六步骤（MSP/VTOR/SysTick 全套）
- [ ] 解释 swap 幂等「永不变砖」不变量，用断电注入 50 连击验证鲁棒性

## 30.1 核心概念：双分区内存规划与升级状态机

```text
0x08000000  Bootloader 32KB   只负责搬运+校验+跳转，极少更新
0x08008000  APP Slot0  448KB  当前运行固件
0x08078000  APP Slot1  448KB  OTA下载区 / 备份区
0x080E8000  参数区      96KB  标志/CRC/版本号/下载进度（掉电安全）
升级流： Boot检查参数区标志 → 有新镜像？→ 校验CRC+签名 → 搬运/交换 → 跳APP
APP侧职责： 收包写Slot1 → 写参数"pending" → NVIC_SystemReset()
状态机： RUNNING(A) → DOWNLOADING(边收边写slot1+CRC) → TESTING(B重启自证)
         → CONFIRMED(B confirm 生效)；TESTING 窗口 N 次复位未确认 → REVERT 切回A
```

## 30.2 关键代码：跳转六步骤精读（每个字都有理由）

```c
#define APP_ADDR 0x08008000
typedef void (*pFunc)(void);
void jump_to_app(void){
    uint32_t sp=*(volatile uint32_t*)APP_ADDR;      /* ① 取APP栈顶指针 */
    uint32_t pc=*(volatile uint32_t*)(APP_ADDR+4);  /*   取Reset_Handler地址 */
    if((sp&0xFF000000)!=0x20000000) return;         /* ② 栈顶合法性快检(SRAM区) */
    __disable_irq();
    for(int i=0;i<8;i++) NVIC->ICER[i]=NVIC->ICPR[i]=0xFFFFFFFF; /* ③ 关中断+清pending */
    SysTick->CTRL=0;                                /* ④ 停SysTick防中途异常 */
    SCB->VTOR=APP_ADDR;                             /* ⑤ 向量表指过去(ch24) */
    __set_MSP(sp);                                  /* ⑥ 切主栈！ */
    ((pFunc)pc)();                                  /*   跳转，一去不返 */
}
```

APP 侧配套三件事：保险起见 `SystemInit` 里自己再设一遍 VTOR；链接脚本 FLASH ORIGIN=0x08008000 且 LENGTH 同步收缩；中断向量表内容整体平移——这就是为什么 APP 的 bin 不能直接烧 0 地址。

## 30.3 传输协议对比

| 协议 | 特点 | 场景 |
|------|------|------|
| Ymodem-1K | Xshell/TeraTerm 原生支持，免开发上位机 | 产线烧录、维修工装 |
| 自定义帧([[ch28-串口工程化IDLE-DMA-RS485]]) | 与业务协议统一，可加密可断点续传 | 远程 OTA 主力 |
| TFTP over Ethernet | F407+LwIP 场景标准件 | 网关类设备批量部署 |

写 Flash 铁律：F407 扇区擦除粒度大小不一(16~128KB)；先擦后写；写入必须按半字/字/双字对齐；擦写期间该 bank 取指会停顿——大固件升级把擦写循环放 Bootloader 执行，APP 运行中只做「搬运指令」。

## 30.4 MCUboot：安全升级工业标准

```text
核心概念（github.com/mcu-tools/mcuboot，Zephyr/Mynewt 默认引导）：
① 镜像头 TLV：版本号/哈希(SHA256)/签名(ECDSA-P256 或 RSA2048)
② swap-move 交换：两 slot 原地互换，任意时刻掉电都能恢复一致性
③ 三态 pending/confirmed/revert：下载→标TESTING→自证OK后confirm；起不来(喂狗超时/复位计数超限)→自动revert回旧版 ★生产刚需
④ 私钥在产线服务器签发，设备端只放公钥哈希——私钥泄露风险归零
```

## 30.5 原理深挖：swap 幂等状态机 + boot 主流程骨架

slot0(A) 与 slot1(B) 互换时，参数区 trailer 记录进度日志：SWAP_START → 每扇区写入前先记录「第 n 步」→ 任意时刻掉电重启后读到「第 n 步」从该步继续（幂等：重做同一扇区写入是安全的）→ 完成后标 SWAP_DONE 清日志。**不变量**：任何一步中断，两 slot 内容组合起来总能恢复出「旧固件或新固件之一完整可用」——这就是「永不变砖」的数学保证。scratch 区是交换中转站；无 scratch 变体直接在两 slot 内轮转，省空间但算法更绕。

```c
int main(void){
    board_init(); param_init();
    if(param_pending_upgrade()){
        img_hdr_t h; flash_read(SLOT1,&h,sizeof h);
        if(img_verify_signature(&h)==OK){        /* ECDSA-P256 */
            boot_swap_slots();                   /* 幂等交换(见上) */
            param_mark_confirmed_pending_test();
        } else param_clear_flag();               /* 坏包直接丢弃 */
    }
    if(!app_image_valid(SLOT0)) enter_recovery();/* 双保险 */
    jump_to_app();                               /* 六步骤(30.2) */
}
```

## 30.6 实测数据表：256KB 固件升级时间分解（F407+115200 串口）

| 阶段 | 耗时 | 占比 | 优化方向 |
|------|------|------|----------|
| 传输(115200) | 23.1s | 92% | 换 UART921600/USB/网口 |
| 擦除目标扇区 | 1.2s | 5% | 边收边写已含；H7 双 Bank 可后台化 |
| CRC+签名校验 | 0.35s | 1.4% | 硬件 CRC+预计算表 |
| swap 交换 | 0.45s | 1.8% | 仅换指针方案可归零 |

启示：**带宽决定体验**——串口 OTA 定位为维修通道，量产主通道走网络/无线；平台差异上 ESP32 的 esp_ota_* 十行切换、H7 双 Bank 升级期间照常跑，本质都是 A/B 指针式思路。

## 30.7 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 跳转后 HardFault | MSP 未设置/VTOR 未改/boot 里 SysTick 未停 | 逐条核对 30.2 六步骤；反汇编确认跳转目标 |
| APP 中断全部失效 | 向量表仍指向 boot 区 | VTOR 打印核对；链接脚本与实际烧录地址一致性 |
| 升级中断电变砖 | 参数区标志时序错误（先清了旧有效标志） | 日志式标志设计：只追加不清除，恢复逻辑读最新一致状态 |
| 签名校验通过但跑飞 | 哈希算的是 bin 而 flash 里含 padding 差异 | 明确镜像尺寸语义；TLV 里记录 image_size 并按其计算 |

## 30.8 部署注意事项

1. Bootloader 功能越少越稳：只做搬运+校验+跳转，极少更新。
2. 参数区用日志式标志：只追加不清除，恢复逻辑读最新一致状态。
3. 常驻一个「仅收 Ymodem 的极简接收器」作恢复模式，App 全灭时仍有一条生路，代码预算 ~8KB。
4. 防降级：单调计数器放 OTP/备份域而非参数区（可被整片擦除伪造），每次升级 +1 且新固件必须 ≥ 计数值。

> [!example]- 🧪 动手实验 L30-1：断电注入 50 连击（60 分钟）
> **步骤**：① 按 [[ch29a-电源异常与掉电保护]] 方法搭继电器断电装置；② 脚本循环：发起升级→随机延时 0~25s 断电→上电→检查设备可达性与固件版本；③ 统计 50 次结果分布（成功升级/干净回滚/需人工介入）；④ 对任何一次异常用黑匣子还原现场。
> **验收**：50/50 无砖。哪怕一次失败都是宝贵 Bug——修到全绿为止。

## 30.9 进阶话题

- **差分升级(bsdiff)的 MCU 移植**：解压需要约 1×新旧镜像之一的 RAM 工作区——小 RAM 设备改用分块 VCDIFF 或整包压缩。
- **A/B 指针式替代真交换**：不搬数据只改「启动槽指针」，代价是两份常驻空间——H7 双 Bank 与 ESP32 都是此思路；Linux 对照见 [[ch72-A-B-OTA升级与Recovery体系]]。
- **权威出处**：mcu-tools/mcuboot 的 `boot/bootutil/src/loader.c` 是 swap 状态机权威实现；AN2606 是 STM32 ROM bootloader 全解。

> [!warning]- ❓ FAQ
> **Q1：为什么 APP 的 bin 不能直接从 0x08000000 烧录？** A：向量表内容按链接地址整体平移生成，烧错基址后 VTOR 指向的位置没有正确向量表，中断一来就飞。
> **Q2：TESTING 自证窗口设多长合适？** A：覆盖最慢启动路径（外设自检+外网注册）加喂狗周期余量，通常数秒；期间连续复位未 confirm 即自动 revert 回旧版。

> [!question] 📝 思考题
> 1. 设计「三副本参数区」：任意单页损坏如何恢复出正确标志集？
> 2. 推导 swap-move 在任意掉电时刻的重启恢复不变量。
> 3. 给 Ymodem 增加 AES-CTR 加密与断点续传，评估改动面与风险点。
---
🏷️ #domain/mcu #topic/bootloader #topic/ota | 🔗 [[ch29a-电源异常与掉电保护]] ← **本章** → [[ch31-ESP-IDF入门]] | 📚 [[P3-MOC]]
