---
title: "dma-command"
date: 2024-09-2T15:47:30-04:00
classes: wide
categories:
  - 帖子
tags:
  - GPU
  - OPENGL
---
usermode 填写command在ELite3K层，就是在gl warpper层下具体的实现，功能是由service层给的，但是full是这一层实现的，hardware command在chip common层。


usermode的command分在哪？
resident_list 也会挂再zx_file/driver上


dma-command由cbmgr管理，一个进程最多包含16个cbo，也就是16个dma，在cbmgr初始化时会给定一个大小. 当需要dmacommand时，申请一段内存然后call zx_cbo_alloc下来拿一段cpu visiable的内存(直接map了). 在cbmgr的buffer满了或者allcation数量到极限了就flush. 这里的allcation指的是这段dma command所操作的所有allocation，如果太多的allocation最好也flush一下.

patch command会插队，必须先保留左边未完成的command和allocation
