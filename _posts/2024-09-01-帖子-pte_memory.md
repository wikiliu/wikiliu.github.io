---
title: "GPU pte"
date: 2024-07-2T15:47:30-04:00
classes: wide
categories:
  - 帖子
tags:
  - GPU
  - OPENGL
---
1. 在local cpuvisiable 分配一段segment，lock住并map cpuva，通过cpuva直接写entry，最后将一级表也填到ttbr。


这个gart表就是segment分的页表 只不过有一部分是cpu内存的



segment内存包括：
                | --- |
                |pt_buffer(local visiable) |
                |bl_reserved_memory/bitblt |
                |ring_buffer_for_hang(local) |
                |transfer_buffer_for_hang(pcie)|
                |fence_buffer(local) |
                |dma_buffer(可以设) |
                |reserved_memory(private initiallize) |
                |pcie reserved memory|
                |vm node : vidmm_vm_alloc_pd(分三级页表)|

local作为一个分配heap，具体到alloc回调的时候根据range区分cpu visiable和unvisiable，无非是高和低的地址不同，属性没有不同。低一半的visiable可以在bar上看到。

? 最大的ttbr是32个 根table按照8k对齐



zx_create_range_allocator 这是一个分配器 不仅分va也分pa
