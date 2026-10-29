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

## 一、硬件规格

```text
GPU VA 空间:  40-bit = 1TB
物理页大小:   4KB (也支持 64KB，当前未启用)
PTE 大小:     8 字节 (64-bit)
进程数上限:   16 个 VMID (PROCESS_NUM=16, VMID 0 为 KMD 保留)

页表层级 (3 级, 4KB 页):
┌────────┬──────┬──────────┬──────────┐
│ Level  │ 层级  │ VA 位     │ 条目数    │
├────────┼──────┼──────────┼──────────┤
│ Root   │  L0  │ [39:30]  │ 1024     │
│ Level1 │  L1  │ [29:21]  │  512     │
│ Level2 │  L2  │ [20:12]  │  512     │  ← 叶子 PTE
│ Offset │  —   │ [11:0]   │    —     │
└────────┴──────┴──────────┴──────────┘

每页表大小:
  Root PT:  1024 × 8B = 8KB
  Level1 PT: 512 × 8B = 4KB
  Level2 PT: 512 × 8B = 4KB

一个 Root 条目覆盖的 VA 空间: 2^(9+9+12) = 1GB
一个 Level1 条目覆盖的 VA 空间: 2^(9+12) = 2MB
一个 Level2 条目覆盖的 VA 空间: 2^12 = 4KB
```

**关键定义位置**：[arise_mmu.c:37-43](hw_blocks/arise_mmu.c#L37)，[arise_mmu.c:245-247](hw_blocks/arise_mmu.c#L245)

---

## 二、VA 空间布局

```text
0x0000000000 ───────────────────────────── Shared Space 起始
              │  Shared Local (8GB)       │  identity map, PTE[i]=i
              │  Shared PCIe  (4GB VA)    │  运行时动态填 PTE
0x0300000000 ───────────────────────────── Shared Space 结束 (12GB@8G+4G)
              │  Private UMD              │  用户态进程
              │  Private KMD              │  内核态
0x10000000000 ──────────────────────────── 1TB 结束
```

**关键定义位置**：[arise_vm.c:38-39](arise_vm.c#L38)，[arise_vm.c:2150-2165](arise_vm.c#L2150)

---

## 三、Shared vs Private — 两条硬件翻译路径

```c
硬件根据 Legacy_Offset / Legacy_Size (NOC MMIO) 判断 VA 走哪条路径:

    VA < Legacy_Size ?
    ├── YES → Shared 路径 (TTBR 寄存器)
    └── NO  → Private 路径 (L1_Pt_Base 寄存器)
```

| 对比维度         | Shared 路径                   | Private 路径           |
| ---------------- | ----------------------------- | ---------------------- |
| **入口寄存器**   | TTBR MMIO 寄存器 (32 个/VMID) | L1_Pt_Base (1 个/VMID) |
| **第一级来源**   | MMIO 直接写入                 | 内存中根页表 (8KB BO)  |
| **页表结构**     | 一整块连续 BO                 | 零散独立 BO (树状链接) |
| **跨 VMID 共享** | 16 个 VMID 的 TTBR 值完全相同 | 每个 VMID 独立         |
| **子页表分配**   | init 时一次性                 | 按需懒分配             |
| **更新时机**     | init + resume (MMIO)          | context switch (DMA)   |

**关键定义位置**：[arise_noc.c:922-927](hw_blocks/arise_noc.c#L922)，[arise_vm_pt.c:1038](arise_vm_pt.c#L1038)

---

## 四、TTBR 寄存器详解

### 硬件规格

```text
每 VMID: 32 个 TTBR 寄存器 (MMIO, 每个 8 字节 = 一个 PTE)
总寄存器: 16 VMID × 32 = 512 个

寄存器布局 (MMIO 地址空间):
  VMID 0:  TTBR[0..31]  @ base + 0x000
  VMID 1:  TTBR[0..31]  @ base + 0x100  (32×8=256)
  ...
  VMID 15: TTBR[0..31]  @ base + 0xF00
```

### TTBR 条目瓜分 (以 8GB Local + 4GB PCIe VA = 12GB Shared 为例)

```text
  nr_ttbr_in_shared = 12GB >> 30 = 12 条

  TTBR[ 0..11] ← Shared 空间    MMIO 写入, 16 个 VMID 一模一样, 永不变
  TTBR[12..31] ← Private 空间   context switch 时从根页表 DMA 加载
```

每个 TTBR 条目覆盖 1GB VA 空间。Shared 条目指向 Shared PT Buffer 内的 Level2 页；Private 条目指向各进程的私有 Level1 页表。

### 为什么 TTBR 只有 32 条目但 Root PT 有 1024？

```text
TTBR 寄存器 = 硬件快速 CAM/TLB, 覆盖 VA 前 32GB
根页表内存   = 完整 1024 条目, 覆盖 1TB

Private 空间超过 32GB 时:
  TTBR[12..31] 未命中 → 硬件走 L1_Pt_Base 查内存根页表 → 自动回填 TTBR
  (类似 CPU TLB refill 机制)
```

**关键定义**：[arise_mmu.c:37-38](hw_blocks/arise_mmu.c#L37)，[arise_vm_pt.c:1918-1945](arise_vm_pt.c#L1918)，[arise_gfx.c:1510-1536](hw_blocks/arise_gfx.c#L1510)

---

## 五、VMID 管理

### 分配机制

```text
VMID 0:  KMD 内核保留 (不走 LRU, 不被抢占)
VMID 1~15: LRU 链表动态分配

预留机制 (reserve_vm_id):
  - 同一进程 (相同 PID) 的多个 device context 可绑定同一 VMID
  - 预留的 VMID 从 LRU 链表移到 reserved_vm_id_list
  - 引用计数 (ref_cnt) 归零后归还 LRU
```

### VMID 选择流程

```text
arise_vm_id_mgr_choose_vm_id():
  1. reserved_device → 直接给 VMID 0
  2. device 已有预留 VMID → 复用
  3. LRU 链表找空闲 VMID → 取走, 移到链表尾部
```

**关键定义**：[arise_vmid_mgr.c:38-77](arise_vmid_mgr.c)，[arise_vmid_mgr.c:181-271](arise_vmid_mgr.c#L181)，[arise_vmid_mgr.c:273-338](arise_vmid_mgr.c#L273)

---

## 六、页表内存存储总览

```text
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Shared PT Buffer (一整块连续, ≈18.5MB)                      │
│  ┌──────────┬───────────────┬─────────────────────────────┐ │
│  │ Level1区  │ Level2 页表    │ Level3 叶子页表              │ │
│  │ 8KB      │ 36KB (9页)    │ 18MB (4608页)              │ │
│  │ (TTBR源)  │ 指向 Level3    │ Local 部分: 恒等映射 (init)  │ │
│  │          │               │ PCIe 部分: 运行时动态填       │ │
│  └──────────┴───────────────┴─────────────────────────────┘ │
│  分配时机: driver init (arise_init_shared_pt)               │
│  释放时机: driver deinit                                    │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Private 页表树 (零散独立 BO, 各进程独立)                     │
│                                                             │
│  进程 A:                                                     │
│    根页表 (8KB) ─┬→ L1[0] (4KB) ─→ L2[0] (4KB) 叶子 PTE   │
│                  ├→ L1[1] (4KB) ─→ L2[0] (4KB)             │
│                  └→ ...                                     │
│  进程 B:                                                     │
│    根页表 (8KB) ─┬→ L1[0] (4KB) ─→ L2[0] (4KB)             │
│                  └→ ...                                     │
│  KMD (VMID 0):                                               │
│    根页表 (8KB) ─→ ...                                      │
│                                                             │
│  根页表: 进程创建时分配                                       │
│  L1/L2:  首次映射时按需分配 (arise_vm_alloc_pd)              │
│  全部释放: 进程销毁时                                        │
│  全部从 Local VRAM 优先分配, PCIe fallback                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 16MB 预留机制

```text
RESERVE_FOR_PT_BUFFER = 16MB (arise_vram_mgr.c:38)

不是预分配内存池，而是 VRAM 分配器的一个"围栏":
  - SEG_LOCAL_CPUVISIBLE 上分配非页表 BO 时:
    如果 (size + 16MB > free_size) → 拒绝分配
  - 确保总有 16MB Local VRAM 留给页表
  - 页表本身依然是动态分配，不走预留池
```

---

## 七、关键函数速查

### 页表创建/分配

| 函数                        | 位置              | 作用                                    |
| --------------------------- | ----------------- | --------------------------------------- |
| `arise_init_shared_pt`      | arise_vm_pt.c:912 | 创建 Shared PT Buffer，预填恒等映射 PTE |
| `arise_vm_create_vma_space` | arise_vm.c:415    | 创建进程 VMA 空间，分配根页表 (8KB)     |
| `arise_vm_alloc_pd`         | arise_vm_pt.c:302 | 按需分配 Level1/Level2 页表 (每张 4KB)  |

### TTBR 操作

| 函数                     | 位置               | 作用                                           |
| ------------------------ | ------------------ | ---------------------------------------------- |
| `arise_vm_restore_ttbr`  | arise_vm_pt.c:1932 | Shared PT Level1 内容 MMIO 写入所有 16 个 VMID |
| `arise_vm_update_ttbr`   | arise_vm_pt.c:1918 | MMIO 写入单个 VMID 的 TTBR 寄存器              |
| `arise_vm_set_ttbr_base` | arise_vm_pt.c:1942 | 设置 L1_Pt_Base 寄存器                         |
| `arise_mmu_ttbr_base`    | arise_mmu.c:142    | 构造 L1_Pt_Base 寄存器值                       |

### 页表遍历/更新

| 函数                      | 位置               | 作用                                      |
| ------------------------- | ------------------ | ----------------------------------------- |
| `arise_vm_update_mapping` | arise_vm_pt.c:830  | 遍历三级页表，缺失时 alloc_pd，填 PDE/PTE |
| `arise_vm_update_pd`      | arise_vm_pt.c:647  | 回填上级 PDE                              |
| `arise_vm_update_ptes`    | arise_vm_pt.c:764  | 填充叶子 PTE                              |
| `arise_update_ptes`       | arise_vm_pt.c:1455 | 构造 PTE 并写入目标缓冲区                 |
| `arise_vm_pt_start`       | arise_vm_pt.c:292  | 初始化页表遍历光标                        |
| `arise_vm_pt_next`        | arise_vm_pt.c:267  | 推进遍历光标到下一个条目                  |

### VA 映射/BO 更新

| 函数                               | 位置            | 作用                          |
| ---------------------------------- | --------------- | ----------------------------- |
| `arise_vm_map_gpu_virtual_address` | arise_vm.c:1116 | 为 BO 分配 GPU VA             |
| `arise_vm_bo_update_mapping`       | arise_vm.c:1603 | 遍历 bo->gpu_vm_list 更新映射 |
| `arise_vm_bo_kmap`                 | arise_vm.c:2389 | 将 BO 映射到 KMD VA 空间      |

### VMID 管理

| 函数                            | 位置                 | 作用                            |
| ------------------------------- | -------------------- | ------------------------------- |
| `arise_vm_id_mgr_init`          | arise_vmid_mgr.c:38  | 初始化 VMID 管理器，VMID 0 预留 |
| `arise_vm_id_mgr_choose_vm_id`  | arise_vmid_mgr.c:181 | 为 device 分配 VMID (LRU)       |
| `arise_vm_id_mgr_reserve_vm_id` | arise_vmid_mgr.c:273 | 为进程预留 VMID                 |
| `arise_is_vm_id_idle`           | arise_vmid_mgr.c:131 | 检查 VMID 是否空闲              |

### Context Switch

| 函数                          | 位置              | 作用                    |
| ----------------------------- | ----------------- | ----------------------- |
| `arise_gfx_submit_page_table` | arise_gfx.c:1500+ | GFX 引擎 context switch |
| `arise_mce_submit_page_table` | arise_mce.c:640+  | MCE 引擎 context switch |
| `arise_dce_submit_page_table` | arise_dce.c:690+  | DCE 引擎 context switch |

### 辅助计算

| 函数                           | 位置                | 作用                 |
| ------------------------------ | ------------------- | -------------------- |
| `arise_vm_pt_bits_count`       | arise_vm_priv.h:110 | 各页表级 VA 位数     |
| `arise_vm_pt_buffer_size`      | arise_vm_priv.h:120 | 各页表级 buffer 大小 |
| `arise_vm_accum_pd_bits_count` | arise_vm_pt.c:82    | 累加某级以上 PD 位数 |

---

## 八、Context Switch 时 TTBR 更新细节

```text
Context Switch 流程 (以 GFX 引擎为例):

1. target_vm_id != 0 (非 KMD) 才执行:

2. 计算 shared 占用: nr_ttbr_in_shared = shared_gpu_va_size >> 30

3. 跳过 shared 条目, 只更新 private:
    源地址 = root_gpu_va + nr_ttbr_in_shared × 8
    目标   = TTBR[nr_ttbr_in_shared] 寄存器
    数量   = 32 - nr_ttbr_in_shared

4. 更新 L1_Pt_Base:
    → 指向当前进程的根页表物理地址

5. 发送 TLB invalidate 命令 (RTLB + UTLB + DTLB)

注意: Shared TTBR[0..11] 在这些步骤中被显式跳过,
     因为它们在 init 时通过 MMIO 写死, 永远不会变。
```

---

## 九、PTE 格式

```text
64-bit PTE (arise_mmu_pte 构造):

 ┌──────────┬──────┬───────┬───────┬──────────────────────────┐
 │ Valid(1) │Seg(1)│Snoop(1)│Sec(1) │  Address (高位)          │
 ├──────────┴──────┴───────┴───────┴──────────────────────────┤
 │ 物理页帧号 (PFN, 其余低位)                                   │
 └────────────────────────────────────────────────────────────┘

字段含义:
  Segment: 0=PCIe 总线,   1=Local VRAM 总线
  Snoop:  0=Non-snoop,    1=Snoop (cache coherent)
  Valid:  0=无效,          1=有效
  Security: 权限相关
```

**关键定义**：[arise_mmu.c:59-97](hw_blocks/arise_mmu.c#L59)

---

## 十、GPU 访存物理路径

```text
GPU Core 发出 VA
    │
    ▼
CMMU (页表遍历, 全部用物理地址跳转)
    │
    ▼
NOC (根据 PTE.Segment 路由)
    │
    ├── segment=1 → MIU → Local VRAM (GDDR/DDR)
    │
    └── segment=0 → BIUM → PCIe Controller → 主机 Root Complex
                                              │
                                         [IOMMU?]
                                              │
                                         系统内存控制器 → DDR
```

**页表遍历链上每一级都是物理地址 (物理地址 + segment)，没有 GPU VA。** MMU 用物理地址寻址下一级页表，只有最后叶子 PTE 指向数据页。

---

## 十一、Shared PT Buffer 大小计算 (示例: 8GB Local)

```text
level3_entries = total_local/4KB + pcie_va/4KB
               = 2,097,152 + 1,048,576 = 3,145,728

level3_ptbs    = ceil(3,145,728 / 512) = 6,144 页 (每页 512 条目)
               = 6,144 × 4KB = 24MB

level2_entries = level3_ptbs = 6,144
level2_ptbs    = ceil(6,144 × 8 / 4096) = ceil(49,152/4,096) = 12 页
               = 12 × 4KB = 48KB

level1_ptbs    = 2 页 = 8KB (固定, 容纳 1024 条目)
level1_entries = 12 (实际只用 12 条目)

Total = 8KB + 48KB + 24MB ≈ 24MB
```

---

## 十二、软件填页表完整流程

### 12.1 总览

```text
一次 VA 映射的三步:

Step 1: 分配 VA 范围        → arise_vm_map_gpu_virtual_address
Step 2: 触发映射更新         → arise_vm_bo_update_mapping
Step 3: 遍历三级页表并填充   → arise_vm_update_mapping
         ├─ 缺中间级 → arise_vm_alloc_pd (4KB 页表页)
         ├─ 填上级 PDE → arise_vm_update_pd
         └─ 填叶子 PTE → arise_vm_update_ptes → arise_update_ptes
```

**关键**: 页表页 (PDE/PTE 的载体) 和数据页 (应用数据) 是**两套独立的分配系统**:

```text
页表页 (中间级):                  数据页:
┌─────────────────────┐          ┌─────────────────────┐
│ arise_vm_alloc_pd   │          │ arise_bo_create     │
│   ↓                 │          │   ↓                 │
│ arise_bo_create     │          │ arise_bo_allocate   │
│   _kernel(4KB/8KB)  │          │   _physical_memory  │
│   ↓                 │          │   ↓                 │
│ BO 在 VRAM          │          │ BO 在 VRAM 或 PCIe  │
│ 用于存 PDE/PTE      │          │ 应用数据             │
└─────────────────────┘          └─────────────────────┘
```

### 12.2 Step 1: 分配 VA 范围

[`arise_vm_map_gpu_virtual_address`](arise_vm.c:1116)

```c
vma_space = bo->flag.global ? vm_mgr->reserved_vma : device->vm;
```

**Shared Local 恒等映射** ([arise_vm.c:1150](arise_vm.c#L1150)):

```c
// VA = Shared基址 + VRAM物理偏移 + BO内偏移
// PTE[i] = i (init时预填), VA == 物理偏移, 无需走页表遍历
arg->out_va = shared_gpu_va_offset + range_node[0]->start + arg->offset;
```

> 前提: BO 在 local VRAM, contiguous, 单 range_node。离散 local BO (range_node_num > 1) 不走此路径。

**其他情况** ([arise_vm_allocate_bo](arise_vm.c:841)):

```c
// Shared PCIe: zone = VM_ZONE_ID_SHARE_SPACE_PCIE
// Private:     zone = VM_ZONE_ID_PRIVATE_SPACE_UMD 或 KMD
// 从 zone 的 range allocator 分配 VA
vm_node = arise_vm_allocate_node(zone->ra, prefer_start_addr, size, alignment);
```

### 12.3 Step 2: 触发映射更新

[`arise_vm_bo_update_mapping`](arise_vm.c:1603): 遍历 `bo->gpu_vm_list`:

```c
list_for_each_entry(vm_node, &bo->gpu_vm_list, mapped_list_item)
{
    if (vm_node->age >= bo->resident_age) continue;  // 已最新, 跳过

    if (vm_node->zone->vma_space == reserved_vma)
        arise_map_shared_buffer(...);  // Shared: 直接填 Level3 PTE
    else
        arise_vm_update_mapping(...);  // Private: 遍历三级页表
}
```

### 12.4 Step 3: 页表遍历与填充

[`arise_vm_update_mapping`](arise_vm_pt.c:830) — 核心循环:

```c
arise_vm_pt_start(&cursor, root, start_pfn);  // 从 Root 级定位到起始 PFN

while (cursor.pfn <= end_pfn)
{
    // ① 缺页表 → 当场分配 4KB BO
    if (NULL == cursor.entry->buffer)
        arise_vm_alloc_pd(vma_space, cursor.level, cursor.entry);

    // ② 回填上级 PDE: 子页表物理地址写入上级条目
    arise_vm_update_pd(vma_space, engine_index, &cursor, ...);

    // ③ 叶子级 → 填数据页 PTE
    if (cursor.level == ARISE_PT_LEVEL_MAX - 1)
        arise_vm_update_ptes(vma_space, &cursor, ..., bo);

    // ④ 推进光标
    arise_vm_pt_next(vma_space, &cursor);
}
```

**光标推进** ([arise_vm_pt_next](arise_vm_pt.c:267)):

```text
优先 descendant (下钻到子级)
  → 不行就 sibling (同级兄弟)
    → 不行就 ancestor (上溯父级, 再找兄弟)
      → 都没有 → 遍历结束
```

**光标覆盖粒度**:

| 光标所在级  | 一次遍历覆盖的 VA | 下级条目数 |
| ----------- | ----------------- | ---------- |
| Root (L0)   | 1GB               | 1024       |
| Level1 (L1) | 2MB               | 512        |
| Level2 (L2) | 4KB (1 页)        | — (叶子)   |

### 12.5 三种场景走查

#### 场景 A: 分配 1 字节 (对齐到 4KB, 第一次映射该区域)

```text
VA = 0x3000000000, VA bits: Root[8] L1[0] L2[0]

① Root[8] → buffer=NULL → alloc_pd → 4KB L1 页表
② 回填 Root[8] PDE: pa=L1页表物理地址, segment=1
③ L1[0] → buffer=NULL → alloc_pd → 4KB L2 页表
④ 回填 L1[0] PDE: pa=L2页表物理地址, segment=1
⑤ L2[0] 叶子 PTE: pa=数据页物理地址, segment, snoop

结果: 分配 2 个新页表 (L1+L2=8KB), 填 2 条 PDE + 1 条 PTE
```

#### 场景 B: 分配 8MB 连续 local 内存 (大纹理)

```text
8MB = 2048 个 4KB 页 = 4 个 L2 页表 (每个 512 条目 = 2MB)

① Root[8] → L1 已分配
② L1[0] → L2[0] 填 512 条 PTE (2MB)
   每条: pa = VRAM起始 + i×4KB, segment=1
③ cursor 推进 → L1[1] → 新 L2[1] 填 512 条 PTE (下 2MB)
   ... 重复 4 次

结果: 4 个 L2 页表各填 512 条 PTE, 中间 PDE 复用
```

#### 场景 C: 8MB 离散 PCIe 物理页

```c
// 和 B 的区别在叶子 PTE 填充 (arise_update_ptes:1636-1658):

for(i = 0; i < pte_count; i++)
{
    pte_pa = arise_get_page_phys_address(pages_mem, i/page_ratio + start_idx, NULL);
    //        ↑ 从 scatterlist 按页取出物理地址, 每页可能不连续
    dst += arise_write_buf_pte(dst, 8,
            mmu->funcs->pte(LEVEL2, pte_pa>>12, snoop, segment=0, ...));
}

// VA 连续递增, 但 PTE 里的物理地址可以跳来跳去。
```

### 12.6 Local 内存也可以离散

[`arise_update_ptes:1568-1653`](arise_vm_pt.c#L1568): 通过 `range_node_list` 数组支持:

```c
// 初始化: 定位到当前 range_node
current_node = &fb_pages_mem->range_node_list[0];
while (total_skip_pages < start_page_idx) { ... }

// 填 PTE:
for(i = 0; i < pte_count; i++)
{
    pte_pa = (*current_node)->start + current_page * page_size;
    if (++current_page == (*current_node)->size / page_size)
    {
        current_node++;   // 当前 range 用完, 跳下一个
        current_page = 0;
    }
}
```

每个 `range_node` 最大 8MB (`MAX_ONCE_ALLOC_FB_SIZE`)，非连续分配时有多个 range_node。遍历到边界自动切换到下一个。

### 12.7 回填 PDE 用的是 KMD VA, 不是 GPU 页表翻译的 VA

[`arise_vm_update_pd:718`](arise_vm_pt.c:718):

```c
update_pte_arg.dst_pte_buffer_start_va = cursor->parent->gpu_va;
```

**这里的 `gpu_va` 实际是 KMD 私有 VA 空间的地址**，通过 `arise_vm_bo_kmap` 把页表 BO 映射到 KMD(reserved_device) VA 空间得到。

**双层翻译机制**:

```text
DMA 引擎写 PDE 时:

  KMD VA (gpu_va)  ──→ KMD 页表翻译 ──→ 物理地址 (页表 BO 在 VRAM 里的位置)
       ↑                                       ↑
   软件给的地址                            硬件最终写入的位置
   (reserved_device VA)                   (GPU MMU 自动完成翻译)
```

```text
应用进程 VA  ──→ 应用页表 (存在 VRAM BO 里) ──→ 数据页物理地址
                         │
                         │ 这些页表 BO 又被映射到:
                         │
                KMD VA ──→ KMD 页表 ──→ 页表 BO 物理地址
                                              ↑
                                    DMA 引擎通过 KMD VA 访问页表内容
                                    GPU MMU 自动完成 KMD VA → 物理地址
```

**Shared PT Buffer 的特殊情况**: Shared PT Buffer 的物理偏移在 shared VA 的 local 恒等映射范围内 (VA 偏移 = 物理偏移)，所以用 shared VA 或物理地址访问效果相同。Shared PT 的 PTE 走 **CPU 直接写** (`cpu_va` 指针)，不走 DMA 引擎。

### 12.8 叶子页 (数据页) 不走 `arise_vm_alloc_pd`

| 类型              | 分配函数                            | 分配时机            |
| ----------------- | ----------------------------------- | ------------------- |
| Root 页表 (8KB)   | `arise_vm_create_vma_space`         | 进程创建            |
| Level1 页表 (4KB) | `arise_vm_alloc_pd`                 | 首次映射该 VA 区间  |
| Level2 页表 (4KB) | `arise_vm_alloc_pd`                 | 首次映射该 VA 区间  |
| 数据页 (4KB~N)    | `arise_bo_allocate_physical_memory` | BO 创建时 / swap in |

[arise_vm_update_mapping:876-890](arise_vm_pt.c#L876) 中的关键逻辑:

```c
if (NULL == cursor.entry->buffer)
    arise_vm_alloc_pd(...);      // ← 只分配页表载体 (空页框)

arise_vm_update_pd(...);          // ← 把子页表物理地址回填上级 PDE

if (cursor.level == LEVEL2)       // 到了叶子级
    arise_vm_update_ptes(...);    // ← 把数据页物理地址填入叶子 PTE
    //   数据页物理地址来源于 bo->fb_pages_mem 或 bo->pages_mem
    //   这些在 BO 创建时早已分配好
```

**类比**: `alloc_pd` = 买空白笔记本 (4KB 空页表)，映射时在笔记本上抄数据页的物理地址。数据是本子在 BO 创建时就存在的，不是映射时才买。

---

## 十三、VA 分配 vs PA 分配

```text
VA 分配 (软件概念):              PA 分配 (物理页映射):
──────────────────              ──────────────────────
管理:  连续区间 (range alloc)    管理:  离散页框 (scatterlist)
        一个 vm_node 总连续              多个 segment 优先级
        不连续就分多个 vm_node           连续/离散都收

函数:  arise_vm_allocate_node    函数:  arise_bo_allocate_physical_memory_try
       从 zone->ra 分配 VA              遍历 preferred_segments[] 尝试

失败:  没有足够大连续区间→报错    失败:  一个 segment 无法容纳→换另一个
                                    local 满了 → 降级 PCIe 系统内存

物理连续:  不关心                  关心:  VRAM 内尽量连续 (8MB/次)
                                    PCIe 系统内存是 OS 页, 天然离散
```

`arise_bo_allocate_physical_memory_try` ([arise_bo.c:621](arise_bo.c#L621)) 的核心就是遍历 `bo->preferred_segments[]`，依次尝试分配物理内存。传入的是 segment_id (LOCAL_CPUVISIBLE / LOCAL_NONCPUVISIBLE / PCIE_NONSNOOP / PCIE_SNOOP)，而非 VA 地址。物理内存分配在 segments 间 fallback，但 VA 段始终连续——**两套独立的资源管理，通过页表用物理地址串起来。**

---

## 十四、常用 grep 命令

```bash
# 查找 TTBR 相关
grep -rn "ttbr\|TTBR\|Ttbr" --include="*.c" --include="*.h"

# 查找页表分配
grep -rn "arise_vm_alloc_pd\|arise_vm_create_vma_space\|arise_init_shared_pt"

# 查找 VMID 管理
grep -rn "vm_id\|VMID\|choose_vm_id\|reserve_vm_id"

# 查找 PTE 构造
grep -rn "arise_mmu_pte\|pte_segment\|pte_pa"

# 查找 context switch
grep -rn "set_root_page_table\|ttbr_reg_num_per_process\|nr_ttbr_in_shared"
```


1. 分页表一个用arise_pages_mgr_alloc_pages_memory，arise_vram_mgr_allocate_fb_page_memory，arise_pages_mgr_alloc_pages_memory得到的是sg table，地址要dma_map_sg，arise_vram_mgr_allocate_fb_page_memory得到的gpu pa，+bus_addr就是cpu pa.
2. 页表内存也是bo分配，但是填的是reserved bo，reserved bo map gpu 虚拟地址后，cpu填gpu pa和map gpu va. DCE用这个gpu va改页表项. 分支在 update_vm_task != NULL，一个用cpu填一个gpu填，本质是visiable只能cpu填，不然死循环.
3. 所有vma共享只有128M只包含fence、BL等；128M~4G放页表bo；，reserved vma有4G，reserved vma初始化阶段1.2级表都填好了，且reserved vma页表由cpu填. APP在reserved vma分了页表bo后，页表bo的页表entry是cpu填的，要拿到gpu va给dce去改页表项.    总结： 页表所在bo的vma 1.2.3级都是cpu填，APP分配的bo只需往页表填东西，DCE可以填了.