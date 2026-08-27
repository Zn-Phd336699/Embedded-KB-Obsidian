---
title: "A9 信号处理工具箱：FFT / Goertzel / NTC / SOC 融合"
part: "[[P11-MOC]]"
chapter: "A9"
tags:
  - domain/algorithms
  - topic/dsp
difficulty: 4
est_minutes: 40
prerequisites:
  - "[[chfh-A8校验族谱CRC全家汉明HMAC边界]]"
related:
  - "[[chfa-A1数字滤波七件套]]"
  - "[[chfb-A2卡尔曼滤波族谱KF-EKF-UKF]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# A9 信号处理工具箱：FFT / Goertzel / NTC / SOC 融合

> [!info] 导航
> ⏱ 40min | ★★★★☆ | 前置 [[chfh-A8校验族谱CRC全家汉明HMAC边界]] | → [[chfj-A10轻量加密编码XTEA-AES-HMAC-RLE]]

## 🎯 学习目标
- [ ] 用 CMSIS-DSP FFT 完成「加窗→变换→幅值恢复」的频谱取证流程
- [ ] 在单频检测场景用 Goertzel 替代 FFT 省 90% 算力，含系数定点化
- [ ] 落地 NTC 查表线性化与「安时积分+OCV 修正」的 SOC 融合架构

## A9.1 FFT 取证流水线：从波形到结论

```c
#define NFFT 1024
static float32_t in[NFFT], out[NFFT], mag[NFFT / 2];
static arm_rfft_fast_instance_f32 S;
void fft_forensic(const float32_t *raw){
    /* ① 加 Hann 窗防频谱泄漏——不加窗的谱峰全是骗人的 */
    for(int i=0;i<NFFT;i++)
        in[i]=raw[i]*0.5f*(1-arm_cos_f32(2*PI*i/NFFT));
    arm_rfft_fast_init_f32(&S,NFFT);
    arm_rfft_fast_f32(&S,in,out,0);
    /* ② 幅值谱 |X[k]|，分辨率=f_s/N(例 1kHz/1024≈1Hz) */
    for(int k=0;k<NFFT/2;k++) mag[k]=hypotf(out[2*k],out[2*k+1]);
}
```

判读三峰指纹：50Hz 尖峰+谐波族→工频耦合(布线/共模)；20kHz~MHz 毛刺群→DC-DC 开关频率及倍频；宽底抬升→白噪(参考电压/采样时间不足,见 [[ch27-ADC-DAC与模拟前端]])。

## A9.2 频谱泄漏与窗函数选择

截断即矩形窗→泄漏；余弦族窗压旁瓣：

| 窗 | 主瓣宽(bin) | 旁瓣抑制(dB) | 适用 |
|----|------------|--------------|------|
| 矩形(不加) | 2 | -13 差 | 仅信号整周期截断时 |
| **Hann ★通用** | 4 | -31 | 默认选择 |
| Blackman | 6 | -58 | 动态范围大(找微弱成分) |
| Flat-top | 10 宽 | -93 | **幅度精度优先**(校准类测量) |

**幅值恢复别漏两步**：`A=|X[k_peak]|×2/(N×CG)`，CG 为窗相干增益(Hann=0.5,Blackman≈0.42)。例 N=1024/Hann/谱峰 300→A=1.17V——漏掉这步的人会把「1.17V 的信号」读成「0.586」，幅值差一倍的经典事故。

## A9.3 Goertzel：只要一个频率时的性价比之王

DFT 单条谱线的递推实现，循环内仅 1 乘 2 加，流式逐样本：

```c
typedef struct { float coef,q1,q2; } goz_t;
void goz_init(goz_t*g,float target_hz,float fs){
    g->coef=2*cosf(2*PI*target_hz/fs);
}
float goz_run(goz_t*g,const q15_t*x,int n){
    for(int i=0;i<n;i++){ float t=x[i]+g->coef*g->q1-g->q2;
        g->q2=g->q1; g->q1=t; }
    return sqrtf(g->q1*g->q1+g->q2*g->q2-g->coef*g->q1*g->q2);
}
```
**系数怎么来(697Hz@8kHz,N=205)**：归一频率 f̂=0.087125→coef=2cos(2π·f̂)=1.7074；Q15 存不下(round(1.7074×32768)=55952>32767)→存 coef/2=27976 运行期乘 2 还原，或升 Q16。判决门限：与相邻频点(770Hz)输出比值>4dB 判有效。成本 ~410 cycles vs 同精度 FFT 8000+——门铃音/DTMF/载波检测首选。

## A9.4 NTC 线性化：B 值公式与查表混合法

- **公式两档**：快速估算用 B 值公式 `R(T)=R25·exp[B·(1/T−1/T25)]`(仅窄温区可靠)；全范围精确用 Steinhart-Hart `1/T=a+b·lnR+c·(lnR)³`，三点标定(0/25/70℃)解出 a,b,c，精度 ±0.05℃ 内；
- **嵌入式两段策略**：出厂前主机按 SH 公式生成 128 点 LUT(Q16)烧入 Flash，MCU 只做线性插值(~30cy)零浮点零对数；表外读数标记 INVALID 而非硬插；
- **标定 SOP**：恒温槽三点+标准温度计对照+记录 R/T 对→脚本解系数。

## A9.5 电池 SOC：安时积分+OCV 修正的互补架构

| 方法 | 原理 | 缺陷 |
|------|------|------|
| 库仑计数(安时积分) | SOC += I·dt/Capacity | 电流采样误差累积漂移 |
| OCV 开路电压法 | 静置电压查表反推 SOC | 需静置；LFP 平台期斜率近零失效 |
| **融合(A2 卡尔曼直接套用)** | 库仑计做预测,OCV 做「偶尔到来的慢观测」 | - ★BMS 标准答案 |

融合四要点：过程噪声 Q 由「容量×负载方差」定；OCV 观测仅在静置>30min 或电流<C/50 时触发修正；温度进 OCV 表维度(LFP 高低温差异巨大)；满充事件强制校准 100%——消除长期漂移的用户可感知误差。EKF 观测矩阵 H=[−dOCV/dSOC , −1]：LFP 平台期 dOCV/dSOC≈0→SOC 不可观，**EKF 自动只信库仑计**——数学优雅处理平台期。OCV-LUT 制作：C/20 放电近似开路+每 5% SOC 静置 30min 记录三温度曲线→分段拟合→脚本输出 `const uint16_t ocv_lut[T][P]`(Q12)→随机 20 工况点误差 ≤10mV 入库(ch09 流程)→magic 校验版本管理，换电芯只换表不改代码。

## A9.6 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 49Hz 与 51Hz 分不清 | 看分辨率 f_s/N | 增大 N 或降采样率 | Δf≤f_s/N(N≥500@1kHz) |
| Goertzel 漏检/误报 | 相邻频点输出比统计 | 判决门限/N 长度 | 相邻频点比>4dB 判有效 |
| 温度插值偏差大 | LUT vs SH 全算对比 | 表密度/Q 格式宏 | 128 点误差 ≤0.1℃(典型值) |

## A9.7 实测数据表：SOC 三方案在 LFP 电池上的误差（10 天真实工况）

| 方案 | 最大误差 | 末端(95%+)可信度 |
|------|----------|------------------|
| 纯库仑计 | 11%(漂移累积) | 差 |
| 纯 OCV | 平台期 ±18% | 中 |
| **KF 融合+满充校准** | **3%** | 好 |

## A9.8 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 谱峰全是毛刺假峰 | 未加窗频谱泄漏 | 先上 Hann 再谈判读 |
| 全谱底噪整体抬高 | ADC 偏置 DC 泄漏 | FFT 前减均值看底噪回落 |
| M0 项目内存爆 | 1024 点 f32 FFT≈12KB | 改 Goertzel 或降 N |
| LUT 输出与公式不符 | 两侧 Q 格式宏不一致 | 同一份头文件定义禁手改 |

## A9.9 部署注意事项（上线前五查）

1. **内存预算先行**：1024 点 f32 FFT=输入 4KB+输出 4KB+窗表 4KB——M0 直接超预算；
2. **实时性节拍**：FFT 放低优先级任务批处理，ISR 只填缓冲——38µs/帧的账算进最忙时段；
3. **直流分量处理**：ADC 有偏置先减均值再 FFT，否则 DC 泄漏抬高全谱底噪；
4. **LUT 尺度统一**：Q 格式在生成脚本与 C 侧必须同一份宏定义——两侧手改必错；
5. **SOC 显示平滑**：显示层迟滞 ±1% 内不跳字——体验细节。

> [!example]- 🧪 动手实验 LA9-1：给充电宝做一颗「诚实的心」（120 分钟）
> **步骤**：① NTC 三点标定并生成 LUT 对比 SH 全算误差；② INA226 类电流计采集真实充放循环；③ 实现 A9.5 融合滤波并与库仑计裸跑对比；④ 电子负载复现平台期工况验证 OCV 门控触发逻辑。
> **验收**：10 天误差 ≤3% 且全程无负 SOC 显示。

## A9.10 进阶话题

- **实时频谱监测**：FFT 每 100ms 一帧画瀑布图上云([[ch80a-MQTT-CoAP云协议本体与实现]])——电机轴承故障特征频率追踪入门；
- **DSP 库选型**：CMSIS-DSP(f32/q15 全家桶)+KISS FFT(纯 C 备胎)覆盖本节全部需求；
- **rfft 只算一半的原因**：实信号谱共轭对称 X[N−k]=X*[k]；DC 与 Nyquist 谱线恢复时不乘 2。

> [!warning]- ❓ FAQ
> **Q1：FFT 和 Goertzel 怎么选？**
> 要整条谱/找未知干扰→FFT；只盯已知频率(DTMF/载波/门铃音)→Goertzel 省 90% 算力且内存极小。
> **Q2：为什么 rfft 只算一半？**
> 实信号频谱共轭对称 X[N−k]=X*[k]，后半段是镜像——若看到不对称的谱，说明输入混入复数或采样异常。

> [!question] 📝 思考题
> 1. 采样率 1kHz 时想分清 49Hz 与 51Hz，N 至少取多少？内存代价是什么？
> 2. 手算 f_s=8kHz 下检测 697Hz 的 Goertzel 系数及其 Q15 定点化技巧。
> 3. 从 H=[−dOCV/dSOC, −1] 出发，解释满充校准消除长期漂移的机制。

---
🏷️ #domain/algorithms #topic/dsp #topic/battery #topic/ntc | 🔗 [[chfh-A8校验族谱CRC全家汉明HMAC边界]] ← **本章** → [[chfj-A10轻量加密编码XTEA-AES-HMAC-RLE]] | 📚 [[P11-MOC]]
