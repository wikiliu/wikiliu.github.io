---
title: "Power and Dvfs"
date: 2024-06-17T15:47:30-04:00
classes: wide
categories:
  - 帖子
tags:
  - GPU
---

这里将power和dvfs单独拿出来，内容会比hardware概览更详细。

## overview

    power相关的控制包括几个模块：供电的power，被调控的VENG，控制器AP/SCP，还有power/dvfs处理的核心PMU+VSUS_PMU。当然还包括这种数据流和信号线参与。

## power reset

    power reset信号可以来自于：
        硬件的VMM_SUB_RST信号（会传到PMU）
        软件命令重启信号 SW_PWM_RST
        PMU重启信号

    最后作用于各个模块，但DIU有independent的power信号，也有自己的rst控制，和non-DIU的module区分开来。

    在硬件中的步骤：
    AP/SCP（application processor/ system control processor）或者MMIO 发送request到PMU
    PMU通过pmu internal interface 到VSUS_PMU,VSUS中的RST模块根据状态判断回传到PMU，最后其实由PMU发送控制信号。

## dvfs

    AP/SCP（application processor/ system control processor）或者MMIO 发送request到PMU
    PMU通过pmu internal interface 到VSUS_PMU,VSUS发送ctrl到VMM clock frequency的PLL/EPLL，如果是AVS则到PMIC
