---
title: "spin_lock在gpu-driver的使用"
date: 2025-12-10T15:58:06+09:00
classes: wide
categories:
  - 帖子
tags:
  - 帖子
toc: true
toc_sticky: true
---

所有的spin_lock都必须保证别被sleep任务抢占!!!

** void spin_lock(spinlock_t *lock);

> 普通锁，必须保证没有任何中断和可睡眠事件打断，否则可能死锁

** void spin_lock_irqsave(spinlock_t *lock, unsigned long flags);

> 屏蔽硬件中断，但是会记录最后一个硬件中断，可以恢复硬件中断，unlock时再触发，适用于需要保存硬件中断的场景，例如hotplug,psr等display中断

** void spin_lock_irq(spinlock_t *lock);

> 完全屏蔽硬件中断，不care，例如crtc flip，我反正已经在flip，你来vblank也不好使

** void spin_lock_bh(spinlock_t *lock)

> kernel帮你屏蔽软中断和tasklet，例如fence，对于下一次fence时效性不是很关心，但是硬件fence既然来了，我还得记录一下
