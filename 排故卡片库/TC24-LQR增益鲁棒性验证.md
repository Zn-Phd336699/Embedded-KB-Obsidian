---
title: "TC24 LQR 仿真收敛完美，实物轻微摄动就发散"
tags:
  - troubleshooting
  - algorithms/control
severity: high
frequency: occasional
source: "[[chfe-A5复合与现代控制前馈串级-Smith-LQR]]"
date: 2025-01-15
---
# TC24 LQR 增益鲁棒性验证

## 现象
名义模型上 LQR 闭环快速收敛、指标 J 最优；换实物或负载/延迟一变（±20~30%）就震荡甚至发散。典型触发：忽略了执行器带宽、传感延迟与建模误差。

## 环境与适用范围
适用全状态反馈 LQR（倒立摆/云台/平衡车），MATLAB Control Toolbox 或 python-control 可验证。输出反馈、降维观测器场景裕度结论进一步打折。

## 取证过程
1. 复现边界：扫负载质量/转动惯量 ±30%，注入延迟 τ∈[0,2Ts]，找到发散临界点。
2. 名义裕度：画开环回路 L(s)=K(sI-A)^-1B 的 Bode，margin() 读增益/相位裕度作基线。
3. 敏感性分离：逐项放开摄动（只动 B / 只动 A / 只加延迟），找出拉垮裕度的主导因素。
4. HIL 验证：实物注入延迟+量化+噪声，阶跃跟踪对比仿真差异。
5. 修订回归：调 Q/R 降带宽或补补偿后，重跑全部摄动组合确认稳定。

## 根因
LQR 的「最优」只相对名义模型和选定的 Q/R。经典鲁棒结论（单回路增益裕度 0.5~∞、相位裕度 ≥60°）前提是全状态反馈、理想执行器、无延迟；实际延迟直接侵蚀相位裕度，未建模高频动态在剪切频率附近附加滞后，裕度耗尽即失稳。

## 修复方案
```matlab
K = lqr(A,B,Q,R);
L = -K*ss(A,B,eye(size(A)),0);       % 回路传函 L(s)
[GM,PM] = margin(L);                 % 要求 GM>=6dB 且 PM>=45deg
fprintf('GM=%.1f dB, PM=%.1f deg\n', 20*log10(GM), PM);
for m = 0.7:0.1:1.3                  % B 参数摄动 ±30%
    cl = feedback(ss(A,B*m,-K,0), eye(size(A)));
    assert(all(real(pole(cl)) < 0), 'm=%.1f unstable', m);
end
```

## 预防措施
- 设计交付物强制附 margin 报告与摄动扫描结论
- 建立参数摄动范围表（电压/负载/温度）纳入验证矩阵
- 带宽留余量：闭环带宽 ≤ 执行器带宽的 1/3，延迟 τ < 1/(5fc)
- HIL/台架必做延迟与量化注入实验
- 状态误差超限自动切安全模式（降增益或停机）

## 关联
- 源章节：[[chfe-A5复合与现代控制前馈串级-Smith-LQR]]
- 相关章节：[[chfd-A4-PID工程化全集抗饱和自整定]] [[chff-A6电机控制数学内核Clarke-Park-SVPWM-SMO]] [[ch53-RTOS综合实战三轴云台控制器]]
