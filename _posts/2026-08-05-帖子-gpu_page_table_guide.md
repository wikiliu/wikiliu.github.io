---
title: "gpu_page_table_guide"
date: 2026-08-05T12:14:50+09:00
classes: wide
categories:
  - 帖子
tags:
  - 帖子
toc: true
toc_sticky: true
---

# Arise2 GPU 页表架构速查手册

> 正文更新：2026-10-29，依据当前 `arise2_drm_kmd` 源码。最后三条用户总结按要求原文保留，不纳入本次修订。下文统一使用二进制容量单位 KiB/MiB/GiB/TiB。

## 一、硬件规格与对象定义

先区分三个对象：**VMA 是一套 GPU 地址空间；页表 BO 是存放 PDE/PTE 的内存；页表 BO 在 reserved VMA 中的 VA，是驱动访问、修改该内存的地址。** 它们不是同一个概念。

当前 Arise2 配置为 40-bit GPU VA（1 TiB）、4 KiB GPU 页、8 字节 PTE、16 个硬件 VMID。VMID 0 留给 KMD 内部任务，其他 VMID 动态复用；16 个 VMID 不等于最多只能有 16 个应用。

本文按代码名称称三级表为 L1/L2/L3；枚举值分别为 0/1/2，不再混用旧文中的 Root/L0、Level1/L1、Level2/L2。

| 代码名称 | 枚举值 | 索引 VA 位 | 表项数 | 一张表大小 | 每个表项覆盖 |
| --- | ---: | --- | ---: | ---: | ---: |
| `ARISE_PT_LEVEL_1`，根表 | 0 | [39:30] | 1024 | 8 KiB | 1 GiB |
| `ARISE_PT_LEVEL_2`，中间目录 | 1 | [29:21] | 512 | 4 KiB | 2 MiB |
| `ARISE_PT_LEVEL_3`，叶子表 | 2 | [20:12] | 512 | 4 KiB | 4 KiB |
| 页内偏移 | — | [11:0] | — | — | — |

根表描述范围：`1024 × 512 × 512 × 4 KiB = 1 TiB`。L3 的一张 4 KiB 表能描述 2 MiB 的业务 VA。

定义见 [arise_mmu.c](hw_blocks/arise_mmu.c#L35)、[页表位数配置](hw_blocks/arise_mmu.c#L243)、[级别枚举](hw_blocks/arise_mmu.h#L36)、[表大小计算](arise_vm_priv.h#L117)。

---

## 二、当前 VA 空间布局

### 2.1 global、reserved、App private 是不同维度

当前常量：

来源：[arise_vm.c:38](arise_vm.c#L38)。

```c
#define GPU_VA_GLOBAL_SPACE_OFFSET           0
#define GPU_VA_GLOBAL_SPACE_SIZE             0x8000000ull  //128M
#define GPU_VA_PAGING_SPACE_INIT_SIZE        0x100000000ull  //4G
```

当前配置的 **global 区是每个 VMA 低 128 MiB**；App 的 private 区从 128 MiB 开始。`reserved_vma` 是驱动单独持有的一套 VMA，其预建页表覆盖低 4 GiB。不能把这 4 GiB 当成所有 App 都相同的映射。

```text
GPU VA          驱动 reserved_vma              App A 的 VMA              App B 的 VMA
0               ┌─────────────────────┐       ┌──────────────────┐     ┌──────────────────┐
                │ global：公共映射    │       │ 相同 global 映射 │     │ 相同 global 映射 │
128 MiB         ├─────────────────────┤       ├──────────────────┤     ├──────────────────┤
                │ 驱动内部 private VA │       │ A 的 private VA  │     │ B 的 private VA  │
                │ K_A → A 的页表 BO   │       │ V → A 的业务 BO  │     │ V → B 的业务 BO  │
                │ K_B → B 的页表 BO   │       │                  │     │                  │
                │ 其他内部 BO         │       │                  │     │                  │
4 GiB           └─────────────────────┘       │ 可继续使用更高 VA│     │ 可继续使用更高 VA│
                当前预建表覆盖到此            │                  │     │                  │
legacy 起点                                   └──────────────────┘     └──────────────────┘
                                              高地址 legacy 预留区（大小按 local 容量对齐）
1 TiB
```

上图的 App private 与 reserved private 是**不同 VMA 中的 VA**，数值可以重叠，映射不必相同。global 区共享已建立的公共映射，也不代表 128 MiB 的每一页都有效。

关键配置见 [global/reserved 范围](arise_vm.c#L1903)、[App private 起点](arise_vm.c#L1930)。只有 reserved VMA 的 zone 会在这里创建 `range_allocator`；普通 App 的 `base_addr` 由调用者提供，再记录成 `vm_node`，不能把所有 App 的 VA 分配都说成内核从 `zone->ra` 选空闲地址。见 [zone 初始化](arise_vm.c#L286)、[节点分配](arise_vm.c#L535)。

### 2.2 128 MiB global 区里有什么

这些 BO 通过 `arise_bo_create_reserved(..., global=TRUE, ...)` 创建：

| BO | 当前大小 | 用途 / 位置 |
| --- | --- | --- |
| Fence buffer | 4 KiB/创建实例 | GPU 完成值回写，[arise_ring.c](arise_ring.c#L275) |
| Timestamp buffer | 4 KiB/创建实例 | GPU 时间戳，[arise_ring.c](arise_ring.c#L322) |
| BL buffer | 32 MiB | 压缩相关数据及 slot 分配，[arise_compressor.c](arise_compressor.c#L53)、[大小](hw_blocks/arise_bl.c#L35) |
| Video bridge buffer | 8 MiB/VCP core | 视频 FE 输出，[arise_video.c](arise_video.c#L97) |

当前 boot config 设置 `hw_global_enable=1`、`hw_global_local_size=64 MiB`。正常 local 分配路径下，global local BO 使用前 64 MiB 的硬件直映窗口，其他 global BO 从 64 MiB 以上分配，整个 global 区仍是 128 MiB。

```text
0          ┌─────────────────────────────────────┐
           │ global local 直映窗口，64 MiB       │
           │ BL、video bridge 等，余量不预占 PA  │
64 MiB     ├─────────────────────────────────────┤
           │ 其他 global 映射，64 MiB            │
           │ fence、timestamp 等系统内存 BO      │
128 MiB    └─────────────────────────────────────┘
```

实际创建数量取决于启用的引擎和模块；框图不表示已分配满整个窗口。见 [boot config](arise_boot_config.c#L29)、[global VA 分配边界](arise_vm.c#L545)、[local PA 分配边界](arise_vram_mgr.c#L50)。页表 BO、ring buffer、DMA command buffer 的相关创建路径使用 `global=FALSE`，映射在 reserved private 区。

### 2.3 global 映射怎样进入各 App

`arise_bo_create_reserved()` 为 global BO 保存固定 VA，并加入 `global_bo_list`：

来源：[arise_bo.c:1118](arise_bo.c#L1118)。

```c
    if (bo->flag.global)
    {
        list_add_tail(&bo->global_list_item, &arise_device->vm_mgr->global_bo_list);
        bo->global_force_gpu_va = *out_gpu_va;
    }
```

普通 App 创建 device 时调用 `arise_vm_update_mapping_global_list()`，以该固定地址记录映射；后续更新映射时，App 的 global L3 引用 reserved 表 BO 中对应的那段表，而不是为每个 App 再复制一整套低 4 GiB 页表。

来源：[arise_vm_pt.c:958](arise_vm_pt.c#L958)。

```c
                    offset = vm_mgr->reserved_level3_ptb_offset + arise_vm_pt_buffer_size(arise_device, ARISE_PT_LEVEL_3) *
                            (cursor.parent->index * arise_vm_pt_num_entries(arise_device, ARISE_PT_LEVEL_2) + current_entry->index);

                    current_entry->gpu_va = reserved_root->gpu_va + offset;
                    current_entry->age = arise_device->resume_age;
                    current_entry->buffer = reserved_root->buffer;
                    arise_bo_get(current_entry->buffer);
```

判断条件是 `bo->flag.global && cursor.level == ARISE_PT_LEVEL_3`。App 自己的根表、上级目录及 private L3 仍独立管理。见 [global 节点接入](arise_vm.c#L744)、[L3 复用条件](arise_vm_pt.c#L947)。

注意 `bo->flag.global` 与 `bo->flag.share` / `create_info.flags.bGlobalSpace` 不是同一字段；不能因为某 BO 可共享，就判断它必在这 128 MiB 内。

---

## 三、旧 Shared 布局、legacy 与当前实现的区别

旧文的“低地址 Shared Local 8 GiB + Shared PCIe 4 GiB，12 GiB 后才是 Private UMD/KMD”不能继续作为当前 checkout 的布局。

当前代码没有把 reserved PCIe VA 起点设为 8 GiB，也没有 `VM_ZONE_ID_SHARE_SPACE_PCIE`、`VM_ZONE_ID_PRIVATE_SPACE_UMD/KMD` 这组 zone。当前使用 `GLOBAL_SPACE` 和 `PRIVATE_SPACE`，后者在不同 VMA 中分别存在。

当前 legacy 范围按 local 显存容量计算，并放在 GPU VA 顶部：

来源：[arise_vm.c:1906](arise_vm.c#L1906)。

```c
    vm_mgr->legacy_gpu_va_size = arise_align_up(vm_mgr->legacy_gpu_va_size, arise_device->hw->mmu.shared_va_size_alignment);
    valid_va_space_total_size -= vm_mgr->legacy_gpu_va_size;
    vm_mgr->legacy_gpu_va_offset = valid_va_space_total_size;

    vm_mgr->reserved_gpu_va_offset = vm_mgr->global_gpu_va_offset;
    vm_mgr->reserved_gpu_va_size = GPU_VA_PAGING_SPACE_INIT_SIZE; // 4G
```

`legacy_gpu_va_size` 初值来自 `device_info.total_local_memory_size`；普通配置按 1 GiB 对齐。若显存为 8 GiB，则 legacy 预留起点为 `1 TiB - 8 GiB`，不是低地址 12 GiB 的边界。硬件 `Video_Size` 使用的是 `hw_global_local_size`，并非直接把整块显存都设成 global 可直访窗口。

源码中存在两种容易混淆的用词：

- [VMID 0 注释](arise_vmid_mgr.c#L54) 把 KMD reserved 使用称为 `share space(kmd)`。
- [reserved 初始化旁的注释](arise_vm_pt.c#L1025) 把 legacy 寄存器范围称为 `share context`，并说明了硬件边界问题和 workaround。

因此本文用明确的 `global`、`reserved_vma`、`legacy` 字段名，不再把它们统一叫 Shared Space。寄存器设置见 [arise_noc.c](hw_blocks/arise_noc.c#L933)。硬件精确路由和 TTBR 内部查找机制需要芯片文档；不能仅凭这些注释推出“VA 小于某固定 12 GiB 就必走同一张表”。

---

## 四、TTBR 与根表基址寄存器

### 4.1 当前能从源码确认的配置

| 项目 | 配置 |
| --- | ---: |
| 每 VMID 内存根表条目数 | 1024 |
| 每 VMID TTBR 寄存器条目数 | 32 |
| 每条目大小 | 8 字节 |
| 每 VMID TTBR 寄存器跨度 | 256 字节 |
| VMID 数量 | 16 |

`arise_vm_update_ttbr()` 把源内存中的根目录项写进指定 VMID 的 TTBR MMIO 寄存器，最多写 `ttbr_reg_num_per_process` 条。reserved 初始化仅明确调用 VMID 0；当前覆盖 4 GiB 时，填好并装载前 4 个根目录项。

来源：[arise_vm_pt.c:1153](arise_vm_pt.c#L1153)。

```c
    arise_vm_update_ttbr(arise_device, 0, level2_entries, level1_cpu_va_offset);

    arise_vm_set_ttbr_base(arise_device, vm_mgr->reserved_level1_gpu_pa_offset, 0);
```

`arise_vm_restore_ttbr()` 的函数体确实可以遍历所有 VMID，但当前源码中未找到它的调用点，不能据此声称初始化会把所有 App 的低 4 GiB TTBR 都设置成相同内容。

### 4.2 不再沿用的旧结论

当前设置 App 根表的代码没有 `nr_ttbr_in_shared=12`，也没有跳过 TTBR[0..11]。实际以 App 根表 VA 为源，装载配置数量的 TTBR 条目，同时设置该 App 的 L1 根表 PA。

32 个 TTBR 条目对应根目录前 32 GiB 的索引范围；完整 1024 条内存根表描述 1 TiB。源码不足以证明 TTBR 是“自动回填的 CAM/TLB”，本文不再把旧文中的自动回填说法当作已证实事实。

见 [TTBR MMIO 写入](arise_vm_pt.c#L2150)、[未找到调用点的全 VMID helper](arise_vm_pt.c#L2164)、[GFX 根表设置](hw_blocks/arise_gfx.c#L1540)。

---

## 五、open、App VMA 与 VMID 管理

### 5.1 open 创建什么

```text
arise_drm_open()
  → arise_create_device(arise_device, priv, 0)
    → arise_vm_create_vma_space()
      → 创建 App 自己的根表 BO，映射到 reserved VMA，清零
    → arise_vm_update_mapping_global_list()
```

`gpu_device` 是每次 DRM open 的客户端对象，不应简单等同于唯一 PID；同一进程可有多个 open。用户 context 通过后续创建 context 的接口建立，不是 open 就创建一套新的 reserved context。

内部 reserved device 使用已有的 `vm_mgr->reserved_vma`，普通客户端创建独立 VMA：

来源：[arise_ctx.c:83](arise_ctx.c#L83)。

```c
    if(!use_global_vm)
    {
        device->vm = arise_vm_create_vma_space(arise_device->vm_mgr, device);
        if(device->vm == NULL)
        {
            arise_error("create gpu device: alloc vm memory failed!\n");
            return NULL;
        }
        arise_vm_update_mapping_global_list(arise_device->vm_mgr, device);
    }
    else
    {
        //for the global reserved device, use the global reserved vma.
        //the global reserved vma is initialized in vm init
        device->vm = arise_device->vm_mgr->reserved_vma;
        arise_device->vm_mgr->reserved_vma->device = device;
    }
```

见 [DRM open](arise_drv.c#L1119)、[创建 App 根表](arise_vm.c#L464)、[创建 reserved device](arise_ctx.c#L369)。

### 5.2 VMID 是执行时选择的硬件槽位

```text
VMID 0：reserved_device，KMD 内部执行使用
VMID 1～15：普通客户端动态选择、复用

choose_vm_id():
  reserved_device → VMID 0
  已有且仍属于该 device 的 VMID → 复用
  有预留 VMID → 按预留规则使用
  否则 → 从普通列表选择空闲槽位，必要时等待
```

槽位重新归属 device 时标记 `need_set_root_page_table`。同 PID 的多个 device 可以按预留机制共用一个 VMID，但换 device 时仍可能需要重新设置根表，不等于它们共享整个 private VMA。

见 [VMID 初始化](arise_vmid_mgr.c#L38)、[选择](arise_vmid_mgr.c#L181)、[预留](arise_vmid_mgr.c#L284)。

---

## 六、页表 BO 的存储与地址保存

### 6.1 一份 reserved 表与各 App 自己的表

```text
一块 GPU / 一个 vm_mgr
├─ reserved_pt_buffer：一份，连续容纳 reserved L1/L2/L3
│   ├─ global 对应 L3：各 App 复用这一片段
│   └─ reserved private 对应 L3：映射各 App 页表 BO 等内部对象
├─ App A 的根表 BO、private L2/L3 BO
└─ App B 的根表 BO、private L2/L3 BO
```

reserved 表的物理内存布局：`[L1 8 KiB][L2 16 KiB][L3 8 MiB]`，计算见第十一节。普通 App 创建时先分配 8 KiB 根表；下级表首次映射时按需创建，每张 4 KiB。global L3 分支复用 reserved 表，不再为它分配独立叶子表。

### 6.2 App 的根表地址记在哪里

页表 BO 只是**映射到** reserved VMA；其管理对象依然保存在 App 的 `gpu_device->vm->pt_info` 中：

```text
App A gpu_device
└─ vm->pt_info.root
   ├─ buffer → 根表 BO → fb_pages_mem / pages_mem → backing 地址
   ├─ gpu_va：根表 BO 在 reserved VMA 中的 GPU VA
   ├─ addr：当前记录的 GPU 地址，初始化时等于 gpu_va，不是 PA
   └─ entries[]：下一级页表的 CPU 管理对象，继续形成树
```

关键赋值：

来源：[arise_vm.c:490](arise_vm.c#L490)。

```c
    result = arise_vm_bo_kmap(root->buffer, &root->gpu_va);
```

来源：[arise_vm.c:513](arise_vm.c#L513)。

```c
    root->addr = root->gpu_va;
```

更新 L1 目录项时，从 `cursor->parent->gpu_va` 得到根表的写入 VA；更新 L3 PTE 时，从对应 L3 对象的 `gpu_va` 得到写入 VA。不是每次写叶子 PTE 都要重新使用根表 VA。

来源：[arise_vm_pt.c:715](arise_vm_pt.c#L715)。

```c
        update_pte_arg.entity          = entry->buffer;
        update_pte_arg.start_va        = cur_va;

        /* (dst_pde_buffer_start_va + pde_offset x GPU_PTE_SIZE) is the updating pde addr */
        update_pte_arg.dst_pte_buffer_start_va = cursor->parent->gpu_va;
        update_pte_arg.pte_offset      = entry->index;
        update_pte_arg.npte            = 1;
```

见 [页表对象定义](arise_vm.h#L103)、[VMA 的 pt_info](arise_vm.h#L130)、[叶子更新目标](arise_vm_pt.c#L807)。

### 6.3 当前页表 BO 都请求 CPU visible

根表、普通 local/system PD/PT、reserved 表的创建参数都为 `TRUE /* cpu_visible */`。当前软件要用 CPU 清零、dump 页表；reserved 初始化和直接映射路径也需要 CPU 访问。

这不等于“CPU visible 的表只能由 CPU 填”。普通页表仍可由 DCE 任务更新。源码还留有 `set cpu_visible=FALSE and do blit in arise_dump_ptes` 的 TODO；若将来改为不可见内存，还需一并处理清零等 CPU 路径。

见 [普通 PD/PT](arise_vm_pt.c#L302)、[根表](arise_vm.c#L470)、[reserved 表](arise_vm_pt.c#L1086)、[CPU 清零](arise_bo.c#L1168)、[CPU dump](arise_vm_pt.c#L1962)。

### 6.4 16 MiB local 预留的实际条件

`RESERVE_FOR_PT_BUFFER=16 MiB` 是分配策略，不是已经分配好的页表池。`page_table_pcie_enable` 为真时 `reserved_size=0`；否则针对 CPU-visible local 段、且没有 `skip_reserve` 的相关分配保留余量。kernel BO 创建会设置 `skip_reserve=1`。不能概括成“所有配置总是硬留 16 MiB”。

见 [arise_vram_mgr.c](arise_vram_mgr.c#L38)、[连续分配检查](arise_vram_mgr.c#L80)、[kernel BO 标志](arise_bo.c#L1048)。

---

## 七、关键函数速查

| 函数 | 当前作用 |
| --- | --- |
| [`arise_vm_init_reserved_pt`](arise_vm_pt.c#L1030) | 分配 reserved 表，CPU 清零并连接 L1/L2 |
| [`arise_vm_create_vma_space`](arise_vm.c#L424) | 创建 App VMA、根表 BO 和管理结构 |
| [`arise_vm_alloc_pd`](arise_vm_pt.c#L302) | 分配普通下级页表 BO，reserved kmap，CPU 清零 |
| [`arise_vm_map_gpu_virtual_address`](arise_vm.c#L1014) | 在传入 device 的 VMA 中记录 BO 的 VA 节点 |
| [`arise_vm_bo_kmap`](arise_vm.c#L2025) | reserved VA 映射，传 NULL 选择 CPU 直接填表 |
| [`arise_vm_bo_dma_kmap`](arise_vm.c#L2049) | reserved VA 映射，传任务指针选择写表任务 |
| [`arise_vm_bo_update_mapping`](arise_vm.c#L1352) | 筛选映射节点、检查更新状态、选择 CPU/任务路径 |
| [`arise_map_reserved_buffer`](arise_vm_pt.c#L1323) | CPU 直接更新 reserved L3，并标记 TLB dirty |
| [`arise_vm_update_mapping`](arise_vm_pt.c#L820) | 任务路径遍历表树，按需更新 PDE/PTE |
| [`arise_vm_update_pd`](arise_vm_pt.c#L654) | 为父目录项生成写入命令 |
| [`arise_vm_update_ptes`](arise_vm_pt.c#L772) | 确定业务 VA 对应叶子表区间并调用底层更新 |
| [`arise_update_ptes`](arise_vm_pt.c#L1556) | 生成表项值和更新命令，不等于 CPU 已写目标表 |
| [`arise_vm_update_ttbr`](arise_vm_pt.c#L2150) | MMIO 设置指定 VMID 的 TTBR 条目 |
| [`arise_vm_set_ttbr_base`](arise_vm_pt.c#L2174) | MMIO 写指定 VMID 的根表物理基址编码 |
| [`arise_submit_vm_update_task`](arise_submit.c#L395) | 提交已生成的写表任务 |
| [`arise_submit_page_table_set_task`](arise_submit.c#L484) | 按需设置目标 App 根表或失效 TLB |
| [`arise_gfx_set_root_page_table_r2`](hw_blocks/arise_gfx.c#L1457) | GFX 后端加载 TTBR、设置根表 PA、失效 TLB |
| [`arise_dce_set_root_page_table`](hw_blocks/arise_dce.c#L735) | DCE 后端执行对应的根表设置 |
| [`arise_mce_set_root_page_table`](hw_blocks/arise_mce.c#L636) | MCE 后端执行对应的根表设置 |

旧文中的 `arise_init_shared_pt`、`arise_map_shared_buffer`、`arise_*_submit_page_table` 及固定 shared 条目划分，不作为当前代码入口使用。

---

## 八、设置 App 根表与 TTBR 的实际路径

**写页表内存**与**让硬件使用指定 App 的根表**是两项操作。`arise_submit_page_table_set_task()` 根据根表切换标志和 dirty 状态决定设置根表还是仅失效 TLB，不是每次提交都固定重建整套页表。

```text
需要更新映射时：生成/提交 vm_update 任务
需要切换根表或刷新翻译缓存时：page_table_set / invalidate
依赖满足后：目标 App 任务使用对应 VMID 执行
```

GFX 根表设置首先取得目标 App 的 VMA 和根表 reserved VA：

来源：[hw_blocks/arise_gfx.c:1459](hw_blocks/arise_gfx.c#L1459)。

```c
    struct arise_mmu *mmu = &arise_device->hw->mmu;
    arise_vma_space_t   *vm         = target_device->vm;
    unsigned long long  root_gpu_va = vm->pt_info.root.addr;
```

当前非零 VMID 的 TTBR 加载源从 `root_gpu_va` 开始，不跳过固定的 shared 前缀：

来源：[hw_blocks/arise_gfx.c:1540](hw_blocks/arise_gfx.c#L1540)。

```c
    if (target_vm_id != 0)
    {
        if (mmu->ttbr_reg_num_per_process)
        {
            *rb++ = SET_REGISTER_ADDR(CNU_BLOCK, Reg_Cmmu_Ttbr_Offset + target_vm_id * mmu->ttbr_reg_num_per_process * (gpu_pte_size >> 2), SET_REGISTER_ADDRESS_MODE_ADDRESS);

            *rb++ = SET_REGISTER_ADDR_LOW((unsigned int)root_gpu_va);
            *rb++ = SET_REGISTER_ADDR_HIGH_AND_REGCNT((unsigned int)(root_gpu_va >> 32), mmu->ttbr_reg_num_per_process *(gpu_pte_size >> 2));

```

同一路径还从根表 BO 取得 PA，并编码到 `L1_Pt_Base`：

来源：[hw_blocks/arise_gfx.c:1550](hw_blocks/arise_gfx.c#L1550)。

```c
        {
            unsigned long long ttbr_base_reg = mmu->funcs->ttbr_base(arise_bo_get_pa_offset(vm->pt_info.root.buffer));

            *rb++ = SET_REGISTER_FD(CNU_BLOCK, Reg_L1_Pt_Base_Proc0_Offset + target_vm_id * mmu->ttbr_base_reg_size_dw, 2);
            *rb++ = ttbr_base_reg & 0xFFFFFFFF;
            *rb++ = (ttbr_base_reg >> 32) & 0xFFFFFFFF;
        }
```

| 地址 | 用途 |
| --- | --- |
| `vm->pt_info.root.gpu_va` / `root.addr` | 驱动通过 reserved GPU VA 访问根表内存，也作为加载 TTBR 内容的源地址 |
| `arise_bo_get_pa_offset(root.buffer)` | 编码到硬件根表物理基址寄存器 |

见 [根表任务创建条件](arise_vm.c#L1946)、[提交时的 set/invalidate 分支](arise_submit.c#L506)、[DCE 的对应设置](hw_blocks/arise_dce.c#L805)。

---

## 九、PTE 属性与 CPU 缓存属性

### 9.1 GPU 页表项

不要把 PFN、CPU pgprot、GPU Snoop 和 DMA 地址转换当成同一件事。

| GPU 表项字段 | 当前含义 |
| --- | --- |
| `Valid` | 表项有效性 |
| `Segment` | 1 表示 local 地址；0 表示系统内存访问地址 |
| `Snoop` | 访问的一致性属性 |
| `Addr` | 按页移位后的地址：local PA/偏移，或系统内存 DMA 地址/PA |
| `Security` 等 | 权限和其他硬件属性，按具体表项格式编码 |

字段赋值见 [arise_mmu_pte](hw_blocks/arise_mmu.c#L59)。这里只描述源码赋值，不把概念示意画成未经核实的硬件 bit 排列。

### 9.2 CPU 的 WB/WC/UC 在哪里设置

CPU PTE 是“PFN + 缓存属性 + 权限”等；PFN 本身只是页号。

- CPU `mmap`：先通过 `os_get_pgprot_val()` 设置 `vma->vm_page_prot`，再 `remap_pfn_range()` 建表；延迟映射在 fault 时由 `vmf_insert_pfn()` 使用这些属性。
- CPU 内核映射：`vmap(..., prot)`，local IO 内存使用 `ioremap_wc()` 等。
- `CONFIG_X86_PAT` 下新分配的 nonsnoop 系统页还会在分配阶段执行 `set_pages_array_wc()`；释放回系统前恢复 WB。复用相同类型页池时不一定重复转换。
- GPU 的 `Snoop/Segment` 在生成 GPU 表项时设置，不会修改 CPU 的 `pgprot`。

见 [CPU pgprot](os_interface.c#L2046)、[vmap](os_interface.c#L2073)、[用户态 CPU 映射](arise_gem.c#L145)、[延迟映射属性](arise_gem.c#L722)、[x86 WC 设置](arise_pages_mgr.c#L359)、[释放恢复 WB](arise_pages_mgr.c#L56)。

---

## 十、local PA、系统内存 PA 与 DMA 地址

### 10.1 local BO

`fb_pages_mem->range_node_list[i]->start` 是 GPU local 显存地址/偏移，不是 CPU 的物理地址。普通 local GPU 填表直接使用这个值加段内页偏移，再按 GPU 页大小右移；不加 BAR 基址。

```text
GPU：业务 VA → GPU 页表 → local 地址 P
CPU：fb_bus_addr + P → ioremap_wc / 用户态 CPU 映射 → CPU VA
```

CPU 访问显存不需要 `dma_map_resource()`。本驱动在显存 dma-buf 导出映射中，给 `attachment->dev` 建立设备访问映射时才调用它；那是给设备 DMA 使用，不是给 CPU 生成指针。

见 [local PTE 地址](arise_vm_pt.c#L1391)、[CPU IO 映射](os_interface.c#L2316)、[dma-buf resource 映射](arise_gem.c#L240)。CPU IO 映射要求对应 local 范围处于 CPU 可见窗口。

### 10.2 系统内存 BO

底层是 `struct page`；`sg_phys()` 给出系统 PA，`dma_map_sg()` 建立设备 DMA 映射并提供 DMA 地址。DMA 地址可能是 IOVA，也可能与 PA 数值相同。

普通分配路径在 `arise_allocate_pages_memory_priv()` 中根据 `need_dma_map` 调用 DMA API，成功后设置 `has_dma_map`；**不是每次 GPU 填表时再执行一遍 DMA 映射**。

来源：[os_interface.c:1941](os_interface.c#L1941)。

```c
    if (alloc_flags.need_dma_map)
    {
        memory->st->nents = dma_map_sg(device, memory->st->sgl, memory->st->orig_nents, DMA_BIDIRECTIONAL);
        if (!memory->st->nents)
        {
            goto alloc_failed;
        }
        memory->has_dma_map = 1;
```

后续取地址时选择 `has_dma_map ? sg_dma_address(sg) : sg_phys(sg)`，由 CPU 直接填表路径或写表任务路径使用这个结果。见 [SG 地址选择](os_interface.c#L1998)。GPU 硬件走表读取的是表项中的下级地址，不会把每一级下级表地址再递归当作业务 GPU VA 翻译。

### 10.3 SoC 的 snoop 与地址类型

当前驱动选择条件：

来源：[arise_bo.c:650](arise_bo.c#L650)。

```c
        /* For unsnoop mem, need do flush firstly */
        flags.dma32        = arise_device->device_info.platform_caps.system_need_dma32;
        flags.need_flush   = !support_snoop;
        flags.fixed_page   = TRUE;
        /* set need_dma_map only in non-soc-mode or soc-mode + snoop */
        /* soc-mode + nonsnoop doesn't use bus address, should not set need_dma_map */
        flags.need_dma_map = arise_device->device_info.platform_caps.iommu_support && (!arise_device->hw->config.soc_mode || support_snoop);
        flags.support_snoop = support_snoop;
        flags.phys_continuous = bo->flag.phys_continuous;
```

在 `iommu_support` 为真时：非 SoC 的 snoop/nonsnoop 都请求 DMA 映射；SoC snoop 请求 DMA 映射；SoC nonsnoop 不请求 DMA 映射，后续使用系统 PA。

**一致性决定如何取得最新数据，地址转换决定设备用哪个地址访问。** nonsnoop 也可以需要 DMA 映射，非 SoC 分支就是例子。上述 SoC 绑定是平台代码约定，不能仅凭它断言“所有 snoop 请求必经 IOMMU”。当前 `arise_query_platform_caps()` 将 `iommu_support` 设为 TRUE，这个标志本身也不是实际已启用 IOMMU 翻译的证明。硬件端口、路由及转换顺序仍需芯片资料或运行状态确认。

### 10.4 上游提供 SG 表的例外

`bo->sg_table` 分支只用 `arise_allocate_pages_memory_from_sg()` 包装已有 SG 表，不使用普通分配路径的 `flags.need_dma_map`，也不再次分配数据页或调用 `dma_map_sg()`。当前赋值来源是 HUCA：先用 `page_array` 建 SG 表并调用 DMA 映射，再传给 BO。普通 dma-buf import 另有路径，直接设置 `bo->pages_mem`，不要把两者混为同一个入口。

见 [BO 获取页的分支](arise_bo.c#L599)、[HUCA 上游](huca/huca_gpu_pmm.c#L49)、[SG 包装](os_interface.c#L1864)、[dma-buf open](arise_gem.c#L1217)。

---

## 十一、reserved 页表大小与容量边界

`arise_vm_init_reserved_pt()` 按 `reserved_gpu_va_size` 计算 L1/L2/L3 所需内存，再一次分配表 BO：

来源：[arise_vm_pt.c:1067](arise_vm_pt.c#L1067)。

```c
    reserved_pages = vm_mgr->reserved_gpu_va_size / gpu_page_size;
    reserved_pages_global = vm_mgr->global_gpu_va_size / gpu_page_size;

    level3_entries = arise_align_up(reserved_pages * gpu_pte_size, level3_entry_size)/level3_entry_size;
    level2_entries = arise_align_up(level3_entries * gpu_pte_size, level2_entry_size)/level2_entry_size;
    level1_entries = arise_align_up(level2_entries * gpu_pte_size, level1_entry_size)/level1_entry_size;

    level3_ptbs_size  = level3_entries * level3_entry_size;
    level2_ptbs_size  = level2_entries * level2_entry_size;
    level1_ptbs_size  = level1_entries * level1_entry_size;

    level2_ptb_offset = level1_ptbs_size;
    level3_ptb_offset = level1_ptbs_size + level2_ptbs_size;

    total_ptbs_size = level1_ptbs_size + level2_ptbs_size + level3_ptbs_size;
```

当前 4 GiB 覆盖、4 KiB 页、8 字节表项的计算：

```text
叶子 PTE 数：4 GiB / 4 KiB = 1,048,576
L3 表张数：1,048,576 / 512 = 2048 张
L3 内存：2048 × 4 KiB = 8 MiB

L2 需要 2048 个目录项，每张能容纳 512 项：
L2 表张数：2048 / 512 = 4 张
L2 内存：4 × 4 KiB = 16 KiB

L1：分配一张 8 KiB 根表，实际连接上述 4 张 L2

合计：8 MiB + 16 KiB + 8 KiB
    = 8 MiB + 24 KiB
    = 8,413,184 字节 = 0x806000
```

此前讨论中“8 MiB + 16 KiB”的口算少算了两张 L2，以这里按源码公式复算的结果为准。

4 GiB 是**当前预建页表支持的 GPU VA 范围**，不是物理 PA 上限，不是 BO 本身大小，也不是所有应用业务数据的总容量上限。所有 App 映射到 reserved 的私有页表 BO，与 reserved 表自身、其他内部 BO、对齐空隙等共同消耗其 VA。去掉低 128 MiB global 后，private 覆盖额度约 3968 MiB；它不是页表专用池。

共享 global L3 物理上只存一份，不能对每个 App 重复计入物理页表大小。4 KiB 的 L3 表可以描述 2 MiB 业务 VA，所以 reserved 中页表 BO 的占用远小于它们描述的业务地址范围。

名字虽有 `INIT_SIZE`，当前代码只找到这一处覆盖大小赋值和固定表分配；没有发现自动扩展 reserved 表覆盖范围的实现。当前通用节点路径还对 reserved 范围作断言，见 [arise_vm_pt.c](arise_vm_pt.c#L895)。这不代表所有越界路径都必然优雅返回 `-ENOMEM`。

---

## 十二、CPU / DCE 填表边界与初始化闭环

### 12.1 判断依据是调用路径，不只是“目标表属于 reserved”

`arise_vm_bo_update_mapping()` 的核心分支是 `update_vm_task != NULL`，而不是看到 reserved VMA 就一律走 CPU。`*update_vm_task == NULL` 但外层指针非空时，仍走任务路径，只是先创建任务。

```text
update_vm_task == NULL
  → 仅允许 reserved_vma
  → arise_map_reserved_buffer()
  → CPU 直接写 reserved L3

update_vm_task != NULL
  → 必要时创建 vm_update 任务
  → arise_vm_update_mapping()
  → 构造 PDE/PTE 写入命令，执行后才修改目标表
```

见 [任务分支](arise_vm.c#L1430)、[CPU 分支](arise_vm.c#L1471)。

| 操作 | 写哪些表 | 实际写入者 |
| --- | --- | --- |
| reserved 初始化 | 先清零整块表，再预填 L1/L2 | CPU |
| `arise_vm_bo_kmap()` | reserved L3，建立 BO 的 reserved VA 映射 | CPU |
| 新建 App 页表 BO 的清零 | 根表及普通 PD/PT 内存 | CPU |
| 普通 App 业务 BO 映射更新 | App 的 L1/L2/L3 中需要更新的项 | 写表任务后端 |
| `arise_vm_bo_dma_kmap()` | reserved L3；目录状态需要时也走上级 PDE 更新 | 写表任务后端 |
| App global 映射更新 | 复用 reserved 中的 global L3 | 写表任务也可能写这段内存 |

若当前选用 DCE，表中的“写表任务后端”就是 DCE；选择逻辑还支持 MCE、GFX、SW-DCE，不能仅凭任务名认定板上一定用 DCE。见 [后端选择](arise_hwblock.c#L501)。

### 12.2 CPU 直接写的代码

初始化 L2 指向 L3，再初始化 L1 指向 L2：

来源：[arise_vm_pt.c:1139](arise_vm_pt.c#L1139)。

```c
    //reserved part level 3
    for(idx = 0; idx < level3_entries; idx++)
    {
        arise_pte_t *pte_ptr = (arise_pte_t *)(level2_cpu_va_offset + (unsigned long long)idx * mmu->pte_size);
        *pte_ptr = mmu->funcs->pte(ARISE_PT_LEVEL_2, (level3_gpu_pa_offset + (unsigned long long)idx * gpu_page_size) >> gpu_page_shift, 0, 1, 0, 0);
    }

    //reserved part level 2
    for(idx = 0; idx < level2_entries; idx++)
    {
        arise_pte_t *pte_ptr = (arise_pte_t *)(level1_cpu_va_offset + (unsigned long long)idx * mmu->pte_size);
        *pte_ptr = mmu->funcs->pte(ARISE_PT_LEVEL_1, (level2_gpu_pa_offset + (unsigned long long)idx * gpu_page_size) >> gpu_page_shift, 0, 1, 0, 0);
    }
```

后续普通 kmap 由 CPU 填 reserved L3，local 分支例如：

来源：[arise_vm_pt.c:1204](arise_vm_pt.c#L1204)。

```c
        for (i = 0; i < range_size / mmu->page_size; i++)
        {
            arise_pte_t *pte_ptr = (arise_pte_t *)(vm_mgr->reserved_level3_cpu_va_offset + (unsigned long long)pte_start * mmu->pte_size);
            *pte_ptr = mmu->funcs->pte(ARISE_PT_LEVEL_3, (pte_pa + i * mmu->page_size) >> mmu->page_shift, 0, 1, 0, 0);
            ++pte_start;
```

系统内存分支在 [arise_fill_gart_pcie](arise_vm_pt.c#L1256) 中同样直接 `*pte_ptr = ...`，只是表项地址来自 SG。

### 12.3 reserved 也有任务填表路径

普通 kmap 把任务参数传为 NULL：

来源：[arise_vm.c:2038](arise_vm.c#L2038)。

```c
    ret = arise_vm_bo_update_mapping(arise_device->reserved_device->vm, arise_device->reserved_context, bo, NULL, NULL);
```

dma kmap 映射的仍是 reserved device，但把任务指针传进去：

来源：[arise_vm.c:2062](arise_vm.c#L2062)。

```c
    ret = arise_vm_bo_update_mapping(arise_device->reserved_device->vm, arise_device->reserved_context, bo, update_vm_task, NULL);
```

实际使用场景包括 [BO fill](arise_bo.c#L440)、[paging 临时映射](arise_paging.c#L162)。通用更新循环在 [arise_vm_pt.c](arise_vm_pt.c#L982) 调用 `arise_vm_update_pd()` 和叶子更新；目录已最新时可以跳过，不能说每次都重写上级表。

DCE 的 `update_ptes` 函数由 CPU 生成 immediate blit 命令：

来源：[hw_blocks/arise_dce.c:384](hw_blocks/arise_dce.c#L384)。

```c
static unsigned int* arise_dce_update_ptes_imm_blit(unsigned int *dma_buffer, unsigned long long dst_pte_buffer_va, unsigned int size)
{
    unsigned int *dma_end = dma_buffer;
    dma_end += SEND_DATA_BLT_IMM_DCE(dst_pte_buffer_va, (size >> 2), dma_buffer);

    return dma_end;
}
```

CPU 写这里的 `dma_buffer` 是准备命令，不等于 CPU 已经写了目标页表。目标表项在该任务执行时由后端写入。

### 12.4 为什么不会“先有 VA 还是先有页表”的死循环

```text
驱动初始化：
  CPU 用 arise_bo_kmap() 得到 R 的 CPU VA
  → CPU 清零并写 R 的 L1/L2
  → MMIO 设置 R 的根表物理地址
  → CPU 建立 R 自身的 reserved VA 映射

为 App A 分配页表 BO P：
  arise_vm_bo_kmap(P)
  → 在 reserved VMA 分配 K_A
  → CPU 写 R 的 L3，建立 K_A → P 的 backing 地址

更新 App A 的业务映射：
  CPU 生成“往 K_A + 表项偏移写入”的命令
  → DCE 通过已建立的 R 映射访问 P
  → 修改 P 中的 App PDE/PTE
```

CPU 映射 `arise_bo_kmap()` 与 GPU reserved 映射 `arise_vm_bo_kmap()` 是两种操作。硬件从物理根表基址开始走表；页表 BO 的 reserved GPU VA 是给写表任务访问表内存用的，不是硬件逐级走表必须再翻译的一层。

### 12.5 DMA 映射与填表的先后

```text
系统内存页 → 建 SG → 按 need_dma_map 调用 dma_map_sg() → 得到地址 D
                                                        │
                 ┌──────────────────────────────────────┘
                 ├─ CPU 路径：直接把 GPU VA → D 写入 reserved PTE
                 └─ 任务路径：把目标表 VA 与表项值放入命令，后端执行写入
```

local BO 不需要经过这里的 `dma_map_sg()`，仍可由 CPU 或任务更新映射。因此“谁执行 DMA API”和“谁写 GPU 表内存”是两条独立边界。

---

## 十三、按顺序看初始化、App A、App B 的 VA / PA

以下假设 local 容量为 8 GiB，只选普通 private local BO，A、B 各分配 2 MiB；地址均为示例、不表示实际分配顺序和连续保证。示例中的非 global BO PA 均避开低 64 MiB 的 global local 窗口。App 阶段画到驻留和 GPU 映射已经完成，**不是单纯 create ioctl 返回的瞬间**。

普通 BO create 主要建立描述/GEM handle；VA 节点通过 map 接口记录，物理 backing 在需要驻留时分配，表项在映射更新路径中建立。页表 kernel BO 因其 kmap/清零需求，会在创建后的相关准备步骤获得 backing。见 [create](arise_gem.c#L1023)、[VA map ioctl](arise_ioctl.c#L838)、[驻留](arise_bo.c#L778)。

### 13.1 初始化

```text
GPU VA：reserved VMA                     GPU local PA：实际内存
0 ～ 128 MiB：global                     0x10000000：R（reserved L1/L2/L3）
128 MiB ～ 4 GiB：                            大小 0x806000
  K_R = 0x08000000 → R

App A/B 尚未 open，没有它们的 VMA 和私有页表。
CPU 建好 R 的 L1/L2，并建立 K_R → R 的 reserved L3 映射。
```

### 13.2 App A 分配并使用 BO_A

```text
reserved VMA                           App A VMA
0 ～ 128 MiB：global                    0 ～ 128 MiB：global 映射接入
128 MiB ～ 4 GiB：                      private：
  0x08000000 → R                         0x10000000 → BO_A
  0x09000000 → A 根表                    覆盖 2 MiB
  0x09002000 → A 的 L2
  0x09003000 → A 的 L3

GPU local PA：
  0x10000000：R
  0x20000000：A 根表，8 KiB
  0x20002000：A L2，4 KiB
  0x20003000：A L3，4 KiB
  0x40000000：BO_A，2 MiB

CPU 修改 R：建立上面的页表 BO 映射。
写表任务通过 reserved VA 修改 A 的表：0x10000000 → 0x40000000。
App A 普通任务通过 A 的根表查自己的业务映射。
```

### 13.3 App B 分配并使用 BO_B，A 的对象保留

```text
reserved VMA                           App A VMA                 App B VMA
0 ～ 128 MiB：global                    相同 global 映射          相同 global 映射
128 MiB ～ 4 GiB：                      private：                 private：
  0x08000000 → R                         0x10000000 → BO_A         0x10000000 → BO_B
  0x09000000 → A 根表
  0x09002000 → A L2
  0x09003000 → A L3
  0x0A000000 → B 根表
  0x0A002000 → B L2
  0x0A003000 → B L3

GPU local PA（同一份物理显存）：
  0x10000000：R，仍是原来一份
  0x20000000 / 0x20002000 / 0x20003000：A 的根表 / L2 / L3
  0x30000000 / 0x30002000 / 0x30003000：B 的根表 / L2 / L3
  0x40000000：BO_A，2 MiB
  0x50000000：BO_B，2 MiB

CPU 修改 R：新增 B 页表 BO 的映射。
写表任务通过 B 页表的 reserved VA，写入 0x10000000 → 0x50000000。
```

A、B 可以使用相同业务 VA，指向不同 PA。它们的页表 BO 不需要再映射进各自的业务 VA；但其管理对象仍在各自 VMA 的 `pt_info` 中。不是“各 App 没有页表”，也不是“各 App 的低 4 GiB 都相同”。

### 13.4 连续 VA 与离散 backing

一个映射节点描述连续 VA；local backing 可以跨多个 `range_node`，系统内存可以跨多个 SG 段。普通 private 页表按实际 backing 生成表项，不能据此假定整个 local BO 是恒等映射。

local 的连续填表见 [arise_vm_update_ptes_local](arise_vm_pt.c#L1370)，系统 SG 连续段填表见 [arise_vm_fill_ptes_pcie](arise_vm_pt.c#L1431)，非连续命令后端分支见 [arise_vm_pt.c](arise_vm_pt.c#L1809)。`MAX_ONCE_ALLOC_FB_SIZE=8 MiB` 限制普通分段分配的单次块大小，不意味着请求连续内存时整个 BO 也最多 8 MiB。

4 KiB 页下，示例 VA `0x10000000` 的索引为 L1[0]、L2[128]、L3[0]。首次映射其 2 MiB 对齐范围，除已有根表外，需要一张 L2、一张 L3，写对应目录项和 512 个叶子 PTE；不是旧文中 `0x3000000000` 对应 Root[8] 的错误索引。

---

## 十四、源码核对命令与证据边界

```bash
# 当前范围配置、global 标志与对象关系
rg -n 'GPU_VA_.*SPACE|reserved_gpu_va_size|global_gpu_va_size|legacy_gpu_va' arise_vm.c
rg -n 'hw_global_enable|hw_global_local_size' arise_boot_config.c arise_vm.c arise_vram_mgr.c
rg -n 'flag.global|global_force_gpu_va|global_bo_list' arise_bo.c arise_vm.c

# CPU 路径与任务路径
rg -n 'arise_vm_bo_(dma_)?kmap|update_vm_task != NULL|arise_map_reserved_buffer' arise_vm.c
rg -n 'arise_vm_bo_dma_kmap' arise_bo.c arise_paging.c
rg -n 'arise_vm_init_reserved_pt|reserved_level[123]_cpu_va_offset|arise_vm_update_pd' arise_vm_pt.c

# 根表、TTBR 与后端选择
rg -n 'root_gpu_va|ttbr_base|ttbr_reg_num_per_process' hw_blocks/arise_gfx.c hw_blocks/arise_dce.c
rg -n 'arise_vm_restore_ttbr\(' -g '*.[ch]'
rg -n 'vm_update_context|vm_update_interface' arise_hwblock.c

# 系统内存 DMA 地址与 CPU 缓存属性
rg -n 'need_dma_map|dma_map_sg|has_dma_map|sg_dma_address|sg_phys' arise_bo.c os_interface.c
rg -n 'set_pages_array_wc|set_pages_wb' arise_pages_mgr.c
rg -n 'os_get_pgprot_val|vmap|ioremap_wc' os_interface.c
```

本次正文以当前源码定义、赋值和调用点为依据。DCE/MCE/GFX 的实际选择、IOMMU 是否启用及 SoC 一致性端口的精确路由，需要板上配置、日志或硬件资料才能确认；这些内容不由静态源码检查替代。下面的用户总结保持原文。

---


1. 分页表一个用arise_pages_mgr_alloc_pages_memory，arise_vram_mgr_allocate_fb_page_memory，arise_pages_mgr_alloc_pages_memory得到的是sg table，地址要dma_map_sg，arise_vram_mgr_allocate_fb_page_memory得到的gpu pa，+bus_addr就是cpu pa.
2. 页表内存也是bo分配，但是填的是reserved bo，reserved bo map gpu 虚拟地址后，cpu填gpu pa和map gpu va. DCE用这个gpu va改页表项. 分支在 update_vm_task != NULL，一个用cpu填一个gpu填，本质是visiable只能cpu填，不然死循环.
3. 所有vma共享只有128M只包含fence、BL等；128M~4G放页表bo；，reserved vma有4G，reserved vma初始化阶段1.2级表都填好了，且reserved vma页表由cpu填. APP在reserved vma分了页表bo后，页表bo的页表entry是cpu填的，要拿到gpu va给dce去改页表项.    总结： 页表所在bo的vma 1.2.3级都是cpu填，APP分配的bo只需往页表填东西，DCE可以填了.