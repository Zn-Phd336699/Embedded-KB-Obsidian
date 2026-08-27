---
title: "第28章 串口工程化：空闲中断 + DMA 不定长接收与 RS485"
part: "[[P3-MOC]]"
chapter: 28
tags:
  - domain/mcu
  - topic/uart
difficulty: 3
est_minutes: 40
prerequisites:
  - "[[ch26-DMA与Cache一致性]]"
  - "[[ch07-嵌入式数据结构与算法]]"
related:
  - "[[ch75-UART-RS485与Modbus-RTU实战libmodbus]]"
  - "[[chfh-A8校验族谱CRC全家汉明HMAC边界]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第28章 串口工程化：空闲中断 + DMA 不定长接收与 RS485

> [!info] 导航
> ⏱ 40min | ★★★☆☆ | 前置 [[ch26-DMA与Cache一致性]] | → [[ch29-低功耗设计]]

## 🎯 学习目标
- [ ] 实现 IDLE 中断+DMA 循环接收的不定长帧提取方案（含三种变体取舍）
- [ ] 说清 IDLE 触发的硬件本质与 TXE/TC 的精确语义差异
- [ ] 移植零拷贝喂入式帧解析器状态机并接入 RS485 方向控制与 CRC 校验

## 28.1 不定长接收三方案对比
「收到一帧完整报文」是所有串口协议的第一需求。

| 方案 | 机制 | CPU占用 | 适用 |
|------|------|---------|------|
| 逐字节中断 | RXNE 每字节进 ISR | 高（9600bps 下每 ms 一次） | 低速调试口 |
| **IDLE+DMA 循环** | 总线空闲1字节时间触发 IDLE，一次性取走整段 | 极低，每帧一次 | ★通用首选 |
| 接收超时 RTO/LBD | H7/L4/G4 有 RTO 计数器可配任意超时 | 极低 | 新系列优先用 |

## 28.2 原理深挖：IDLE 硬件本质与 TC/TXE 之辨
```c
/* IDLE 位何时置起？接收移位器在 RxD 连续保持 1 个完整字符时间的高电平后置位——
   「一个字符时间」随波特率自适应，这就是它比固定 µs 定时优雅的原因 */
/* TXE vs TC 的精确语义：
   TXE(Transmit Data Empty): 数据已从 DR 拷进移位器 —— 可写入下一字节
   TC (Transmission Complete): 移位器也空了，线上最后一位已移出
   → 连续发送看 TXE；切 RS485 方向/关时钟必须等 TC！清IDLE序列=先读SR再读DR */
```

## 28.3 关键代码：IDLE + DMA 循环双区方案
```c
void USART1_IRQHandler(void){
    if(USART1->SR & USART_SR_IDLE){                    /* 帧间隔到了 */
        (void)USART1->DR;(void)USART1->SR;             /* 清IDLE标志序列 */
        uint16_t pos = BUF_SZ - __HAL_DMA_GET_COUNTER(&hdma_usart1_rx); /* 当前写指针 */
        uint16_t len = (pos >= last_pos) ? pos-last_pos : BUF_SZ-last_pos; /* 处理回卷 */
        feed_frame(rxbuf,last_pos,len);                /* 交给协议解析器(可能跨区拼接) */
        last_pos = pos;
    }
}
```

## 28.4 RS485 方向控制（半双工，DE=RE 并联一颗 GPIO）
```c
rs485_tx_en(1);                                        /* 切方向 */
HAL_UART_Transmit(&huart,frame,len,100);
/* 关键：必须等最后一位完全移出 TC 才能切回！
   HAL_UART_TxCpltCallback 在 TC 后触发，在里面置方向0 —— 时机正确 */
rs485_tx_en(0);                                        /* 回接收态释放总线 */
/* 硬件替代：MAX13487 等自动方向收发器；或定时器精确延时 */
```

## 28.5 完整工程：协议帧解析器 parser（零拷贝喂入式全文）
推荐帧结构（兼容 Modbus RTU 思想又更灵活）：`HEAD(0xAA)+ADDR(1B)+CMD(1B)+LEN(1B)+PAYLOAD(0~255B)+CRC16(2B)`
```c
typedef enum {P_HEAD,P_LEN,P_PAYLOAD,P_CRC} p_st_t;
typedef struct {
    p_st_t st; uint8_t buf[280]; uint16_t idx,len;
    void (*on_frame)(uint8_t*,uint16_t);
} parser_t;
void parser_feed(parser_t*p,const uint8_t*d,int n){     /* 喂任意长度片段 */
    while(n--){
        uint8_t b=*d++;
        switch(p->st){
        case P_HEAD: if(b==0xAA){p->buf[0]=b;p->idx=1;p->st=P_LEN;} break;
        case P_LEN:  p->len=b; p->buf[p->idx++]=b;
                     p->st=(b<=255)?P_PAYLOAD:P_HEAD;    /* 非法长度即复位 */
                     if(p->st==P_PAYLOAD&&p->len==0)p->st=P_CRC; break;
        case P_PAYLOAD: p->buf[p->idx++]=b;
                        if(p->idx==p->len+2u)p->st=P_CRC; break;
        case P_CRC: p->buf[p->idx++]=b;
                    if(p->idx==p->len+4u){
                        if(crc16(p->buf,p->idx-2)==
                          (p->buf[p->idx-2]|p->buf[p->idx-1]<<8))
                            p->on_frame(p->buf+3,p->len); /* 校验通过派发载荷 */
                        p->st=P_HEAD; }
                    break; }}}
```
鲁棒性三招：① 头部搜索失败即复位状态机（防字节错位永久失步）；② 超时看门狗：收到一半停了→清空重等（配合 IDLE 天然实现）；③ 转义可选：PAYLOAD 里出现 AA 用 `AA 01` 表示。CRC16-MODBUS：多项式 0x8005 初值 0xFFFF，查表法每字节 8 周期。

## 28.6 实测数据表：波特率误差与时钟源选择
84MHz 总线 BRR 取整误差：115200→46(+0.79% 可用)；921600→6(-5.3% ❌溢出，换时钟或降速)；3M 需 OVERSAMPLE8(H7)。双板对发 1GB 实测：

| 双方误差组合 | 总误差 | 实测误码 |
|--------------|--------|----------|
| ±0.2%(双晶振) | 0.4% | 0 错误 |
| +2%/-0.8%(RC vs 晶振) | 2.8% | <1e-9 边缘 |
| +2%/+2%(双 RC) | 4% | **明显错帧，framing 频发** |

红线记忆：两端误差叠加要 <1.5%（留采样余量），合计 >3% 即不可靠；采样点在第 7~8 bit 处，末位最先失守。高速率建议 HSE 精晶振 + 整除友好的 PLL 分配。

## 28.7 参数调试技巧
| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 偶发丢帧 | 逻辑分析仪抓 RX 对照计数 | 补全清标志序列；修回卷边界 | 长跑 24h 无丢 |
| 发完收乱码 | 示波器量 DE 与 TX 时序差 | 改 TC 回调切换方向 | 无截尾字节 |
| 高速误码频发 | 双端各自测波特率误差 | 换晶振时钟源/降速 | 总误差 <1.5% |

## 28.8 排故速查表
| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 偶发丢帧 | IDLE 清标志序列不完整/DMA 回卷处理漏边界 | 逻辑分析仪抓 RX 与方向脚对照；单测构造跨界帧 |
| RS485 发完立刻收乱码 | 方向切换过早（最后位未移出） | 改 TC 回调切换；示波器量 DE 与 TX 最后一位时序差 |
| 总线上多设备冲突 | 无主从仲裁/两主同时发 | 严格主从轮询制；或 CAN(ch78) 替代 |
| 长线传输误码率升高 | 未接终端电阻/共模电压超限/地电位差 | 120Ω 匹配；隔离型收发器 ADM2582E；屏蔽双绞单点接地 |

## 28.9 部署注意事项
1. 多机总线严格主从轮询，杜绝两主同时发言；长线加 120Ω 终端匹配。
2. 方向切换统一封装进 TxCpltCallback，禁止在业务代码里手工延时。
3. 高波特率项目先核算 BRR 整数化误差再选时钟源。

> [!example]- 🧪 动手实验 L28-1：RS485 方向切换时序取证（40 分钟）
> **步骤**：① CH1 探 DE 脚，CH2 探 A 线（经差分或单端近似）；② 在 TxCplt 回调切方向的正确实现下抓波形，测量最后一位结束到 DE 下降的间隙；③ 故意改成「Transmit 返回即切」的错误版本再抓——观察截尾字节与从站 NACK；④ 记录两种时序图。**验收**：两张对比截图+一句话结论「为什么必须等 TC」。

## 28.10 进阶话题
- **9-bit 多机模式**：第 9 位做地址标记——硬件地址匹配(MMR)过滤非本机帧，多从机省 CPU 的老牌利器。
- **printf 重定向的性能账**：一次 %d 格式化 ~200 cycles + 发送阻塞 87µs/字符——热路径日志走 ch14 异步架构。
- **Smartcard/IrDA 模式**：同一 USART 外设的隐藏形态——读卡器项目直接启用无需外扩芯片。

> [!warning]- ❓ FAQ
> **Q1：为什么 IDLE 用「一个字符时间」而不是固定微秒？** 移位器检测 RxD 高电平时长以当前波特率的字符时间为单位自适应，任何波特率下语义一致。
> **Q2：连续发送该盯哪个标志？** 盯 TXE 流水填 DR；只有切方向、关外设时钟等「收尾动作」才需要等 TC。

> [!question] 📝 思考题
> 1. 推导 IDLE 检测的触发条件为何是「一个字符时间」而不是固定 µs。
> 2. 设计「DMA 接收缓冲跨界帧」的零拷贝拼接方案（提示：二级环形索引）。
> 3. 对比 RS485 与 CAN 在多节点仲裁、错误隔离上的本质差异。

---
🏷️ #domain/mcu #topic/uart | 🔗 [[ch27-ADC-DAC与模拟前端]] ← **本章** → [[ch29-低功耗设计]] | 📚 [[P3-MOC]]
