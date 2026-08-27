---
title: "TC26 两端各自算 CRC 都对，联调就是对不上"
tags:
  - troubleshooting
  - protocol/crc
severity: high
frequency: common
source: "[[chfh-A8校验族谱CRC全家汉明HMAC边界]]"
date: 2025-01-15
---
# TC26 CRC 五元组联调约定

## 现象
MCU 与上位机互发帧，各自本地校验通过，线上 CRC 必错；或同一段字节两端结果不同。典型触发：一方 CRC16-MODBUS、另一方 CCITT-FALSE，却都自称「CRC16」。

## 环境与适用范围
适用任何自定义帧协议/Modbus/固件包校验；python(crcmod/pycrc) ↔ C ↔ FPGA 三方联调高发。加密 MAC（HMAC）场景不适用本卡。

## 取证过程
1. 黄金向量：两端对 ASCII 串 `123456789` 各算一次并交换结果——不一致即参数不匹配，与业务数据无关。
2. 填联调单：逐项核对 width/poly/init/refin/refout/xorout 六要素，常见坑是 refin≠refout 或漏 xorout。
3. 查字节序：逻辑分析仪解码首字节，确认线上先发低字节还是高字节；CRC 按字节流顺序计算而非按数值。
4. 查位序：LSB-first 的硬件外设与软件实现的反射设置要对应。
5. 修完重跑黄金向量 + 一条真实帧双向互验，并在 CI 固化。

## 根因
CRC 不是单一算法而是一族参数化变体，五元组任一不同结果必不同。「CRC16」这个名称不携带参数信息：MODBUS(refin=refout=true, xorout=0xFFFF) 与 CCITT-FALSE(全 false, init=0xFFFF) 是同名不同物。

## 修复方案
```c
/* CRC-16/MODBUS 五元组：
   width=16 poly=0x8005(反射0xA001) init=0xFFFF
   refin=true refout=true xorout=0x0000 */
uint16_t crc16_modbus(const uint8_t *d, size_t n)
{
    uint16_t crc = 0xFFFF;
    while (n--) {
        crc ^= *d++;
        for (int i = 0; i < 8; i++)
            crc = (crc & 1) ? (crc >> 1) ^ 0xA001 : (crc >> 1);
    }
    return crc;                      /* "123456789" -> 0x4B37 */
}
```
```python
import crcmod
f = crcmod.predefined.mkCrcFun('modbus')
assert f(b'123456789') == 0x4B37   # 两端先对齐黄金向量再联调
```

## 预防措施
- 接口文档固化五元组 + 黄金向量，评审必查项
- 优先选有名标准变体（modbus/ccitt-false/xmodem），不自造参数
- CI 跨语言跑同一组 golden 向量
- 首次联调用逻辑分析仪抓真实首帧核对字节序
- FPGA 侧串行实现与查表实现互相校验

## 关联
- 源章节：[[chfh-A8校验族谱CRC全家汉明HMAC边界]]
- 相关章节：[[ch75-UART-RS485与Modbus-RTU实战libmodbus]] [[ch74a-自研二进制协议设计规范]]
