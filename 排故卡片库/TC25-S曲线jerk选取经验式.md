---
title: "TC25 S 曲线启停要么哐当撞击、要么软得赶不上节拍"
tags:
  - troubleshooting
  - algorithms/motion-planning
severity: medium
frequency: common
source: "[[chfg-A7运动轨迹规划梯形S曲线前馈跟踪]]"
date: 2025-01-15
---
# TC25 S 曲线 jerk 选取经验式

## 现象
jerk 设太大：启动「哐当」异响、皮带打滑、到位过冲激发共振；设太小：同等行程时间翻倍，产线节拍不达标。典型触发：照抄别人设备的轨迹参数没做机械适配。

## 环境与适用范围
适用梯形/S 曲线速度规划（步进/伺服 + 滚珠丝杠/皮带/直线模组），gcode、运动控制卡、云台均适用。纯速度环调试不涉及 jerk。

## 取证过程
1. 基线标定：取保守 j = a/0.3（加速度爬升 0.3s）试运行，采集电机电流与机身振动（加速度计贴头部/中部/尾部）。
2. 阶梯加倍 j：每档记录振动 RMS、失步/报警数、单程时间；振动超标或失步后回退 30% 作工作点。
3. 异响定位：只出现在加减速段 → jerk 问题；匀速段也有 → 联轴器间隙等机械问题。
4. 负载分组：空载/典型负载/满载各标一组参数，检查差异幅度。
5. 固化入轨迹库并版本化管理，随固件发布。

## 根因
S 曲线柔顺度由加加速度决定：j ≈ a/t_rise（t_rise 为加速度爬升时间）。j 大则接近梯形图冲击大；j 小则过渡冗长。机械固有频率 f_n 是天花板——t_rise 应明显大于共振周期（工程上 ≥3 倍），否则激励共振。

## 修复方案
```c
/* jerk 经验选取：j = a / t_rise，t_rise 按机械刚性分档 */
typedef enum { MECH_BELT, MECH_GANTRY, MECH_LEADSCREW } mech_t;
static const float t_rise_tab[] = {
    [MECH_BELT]      = 0.15f,   /* 皮带/弱刚性：爬升要慢 */
    [MECH_GANTRY]    = 0.08f,   /* 龙门双驱：折中 */
    [MECH_LEADSCREW] = 0.03f,   /* 丝杠+伺服：刚性高可快 */
};
float jerk_pick(float a_max, mech_t m) { return a_max / t_rise_tab[m]; }
/* 步进附加约束：a_max ≤ 0.7×矩频特性可用加速度，防失步 */
```

## 预防措施
- jerk/加速度与负载惯量绑定建档，更换载重重新标定
- 振动 RMS 阈值写入产线验收标准
- 参数按「机械型号 × 负载档位」二维表管理，禁止手抄
- 前馈量与 jerk 同步更新，避免前馈超前限幅制造冲击
- 机械结构大改（换皮带/加配重）后强制回归轨迹测试

## 关联
- 源章节：[[chfg-A7运动轨迹规划梯形S曲线前馈跟踪]]
- 相关章节：[[chfe-A5复合与现代控制前馈串级-Smith-LQR]] [[chff-A6电机控制数学内核Clarke-Park-SVPWM-SMO]]
