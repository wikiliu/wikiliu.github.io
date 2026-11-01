# GPU 内存类型、缓存属性与同步

本文结合当前驱动说明 system RAM、local VRAM、CPU 缓存属性和 GPU 页表属性之间的关系。代码示例经过适当简化；涉及硬件一致性时，最终行为以芯片和平台规格为准。

## 1. 先区分几个层面

| 层面 | 示例 | 决定什么 |
| --- | --- | --- |
| 内存位置 | system RAM、local VRAM | 数据放在哪里 |
| CPU 映射属性 | WB、WC、UC | CPU 如何访问映射 |
| GPU 页表属性 | system/local、snoop/nonsnoop | GPU 地址翻译及访问属性 |
| 同步 | 内存屏障、fence、中断 | 读写顺序和任务何时完成 |

这些属性需要配合。比如 GPU 访问 system RAM 时，驱动可以把 CPU 映射设为 WC，并让 GPU 使用 nonsnoop；WC 自身并不代表 GPU 自动知道该用哪种方式访问。

## 2. System RAM 与 local VRAM

System RAM 是系统内存；驱动可分配系统页作为 BO 的后备存储，GPU 通过页表访问这些页。独立 GPU 访问 system RAM 时，请求通常经过 PCIe。

Local VRAM 是 GPU 本地显存。驱动中的 `SEG_LOCAL_CPUVISIBLE` 表示 CPU 可见的 local 区域，其起点和大小来自：

```c
segment->size            = device_info->visible_local_memory_size;
segment->phys_addr_start = arise_device->device_info.fb_bus_addr;
```

见 [arise_memory_region.c:116](arise_memory_region.c#L116)。对于独立显卡，CPU 通过显卡地址窗口访问显存通常经过 PCIe。地址窗口不是一份 system RAM 副本。

```text
system BO： CPU ──> system RAM <── GPU（独显通常经过 PCIe）
local BO：  CPU ──> 显存窗口 ──> local VRAM <── GPU
```

## 3. CPU 缓存属性：WB、WC、UC

| 属性 | 名称 | 典型行为和用途 |
| --- | --- | --- |
| WB | Write Back，写回 | 使用普通 CPU cache，脏缓存行可以暂时不写回；适合 CPU 频繁读写的内存 |
| WC | Write Combining，写合并 | CPU 可以暂存并合并写操作，再向目标地址发出；适合连续写入，CPU 频繁读取通常较慢 |
| UC | Uncacheable，不可缓存 | 通常用于需要设备访问语义的寄存器等区域 |

WC 描述的是 CPU **如何访问**，不是数据被放到哪里：

```text
CPU 写 system 页：CPU → 写合并缓冲 → system RAM
CPU 写显存窗口： CPU → 写合并缓冲 → PCIe → local VRAM
```

写合并缓冲中的数据可能延迟发出。CPU 写完并通知 GPU 使用数据时，需要相应的屏障和交接协议。CPU cache 一致性也不能代替任务完成同步。

## 4. PAT、MTRR 和内存类型

### 4.1 PAT 是什么

PAT（Page Attribute Table，页属性表）是 x86 CPU 提供的内存类型选择机制。CPU 的 PAT 寄存器保存多个内存类型条目，例如 WB、WC、UC；CPU 页表项中的相关位组合选择一个 PAT 条目。这样，操作系统可以为 CPU 的不同虚拟地址映射指定访问属性，通常以页为单位管理。

```text
CPU 虚拟地址 → CPU 页表项中的属性位 → 选择 PAT 条目 → 请求的内存类型
```

PAT 决定的是 **CPU 如何访问映射**，不负责 GPU 虚拟地址翻译，也不直接填写 GPU PTE 的 `Snoop` 位。CPU 页表和 GPU 页表是两套不同的页表。

驱动中的相关接口各有职责：

```c
set_pages_array_wc(pages, count); // 为 system RAM 页设置 WC
pgprot_writecombine(prot);        // 生成带 WC 属性的映射保护值
ioremap_wc(start, size);          // 以 WC 属性映射设备地址范围
```

实际有效类型还受 MTRR、平台配置和其他映射的影响。同一物理地址被多个 CPU 虚拟地址映射时，需要避免互不兼容的缓存类型。[Linux PAT 文档](https://docs.kernel.org/arch/x86/pat.html) 介绍了这些接口和内存类型跟踪。

### 4.2 MTRR 是什么

MTRR（Memory Type Range Register，内存类型范围寄存器）是 x86 CPU 的另一套机制，通过寄存器为**物理地址范围**指定内存类型。它常用于描述设备地址范围，例如将一段可供 CPU 访问的显存窗口设为 WC。

```text
MTRR：物理地址范围 [start, start + size) → 指定内存类型
PAT： CPU 页表映射的属性位              → 选择内存类型
```

MTRR 按物理范围配置，可用寄存器数量和范围形状有限；PAT 则可以在页映射层面选择属性，通常更灵活。两者共同影响 CPU 最终采用的内存类型，不应简单认为其中一个总是无条件覆盖另一个。现代 Linux 主要使用 PAT，MTRR 接口用于 PAT 不可用时的兼容等场景。[Linux MTRR 文档](https://docs.kernel.org/arch/x86/mtrr.html)

`CONFIG_MTRR` 是 Linux 编译配置：启用后，内核编译 MTRR 支持。它不表示调用 `arch_phys_wc_add()` 时一定会真的添加一项 MTRR，也不控制 GPU 的 snoop 位。

### 4.3 驱动如何使用这些接口

驱动对 CPU 可见显存范围调用：

```c
reg = arch_io_reserve_memtype_wc(start, size);

#ifdef CONFIG_MTRR
reg = arch_phys_wc_add(start, size);
#endif
```

见 [os_interface.c:2431](os_interface.c#L2431)。`arch_io_reserve_memtype_wc()` 是 Linux 的接口，**不是 PAT 硬件本身**：在 x86 PAT 内存类型跟踪中，它为设备物理地址范围登记 WC 类型，帮助管理不同映射的类型冲突。它不创建虚拟地址映射，也不直接设置某个 CPU 页表项。

`arch_phys_wc_add()` 是旧平台兼容接口：PAT 可用时通常不需要额外设置 MTRR；PAT 不可用时尝试添加 WC MTRR。其返回的 handle 供 `arch_phys_wc_del()` 使用。实际访问仍需要合适的映射，例如 `ioremap_wc()`。驱动释放时还要使用 `arch_io_free_memtype_wc()` 解除对应的类型登记。

```text
arch_io_reserve_memtype_wc → 登记设备范围的 WC 类型
arch_phys_wc_add           → PAT 不可用时尝试添加 WC MTRR
ioremap_wc                 → 建立请求 WC 属性的 CPU 映射
CPU 访问                   → PAT、MTRR 等共同决定有效行为
```

该函数对 memtype 登记失败只记录日志；启用 `CONFIG_MTRR` 时，`reg` 随后会被第二个调用的返回值覆盖。因此，不能只看最后的返回值就认定第一步成功。

## 5. System BO 如何选择 snoop

BO 创建时，从创建参数保存缓存偏好：

```c
bo->flag.pool_type  = create_info->flags.PoolType;
bo->flag.cache_type = create_info->flags.CacheType;
```

见 [arise_bo.c:251](arise_bo.c#L251)。对于 `POOL_SYSTEMMEM` 和 `POOL_NONLOCALVIDMEM`，选择大致如下：

```c
switch (bo->flag.cache_type) {
case RESOURCE_CACHE_CACHEABLE:
    add_prefer_segment(SEG_PCIE_SNOOP, 0, 1);
    break;
case RESOURCE_CACHE_NON_CACHEABLE:
    if (bSnoopOnly)
        add_prefer_segment(SEG_PCIE_SNOOP, 0, 1);
    else
        add_prefer_segment(SEG_PCIE_NONSNOOP, 0, 0);
    break;
default:
    if (!bSnoopOnly)
        add_prefer_segment(SEG_PCIE_NONSNOOP, 0, 0);
    add_prefer_segment(SEG_PCIE_SNOOP, 0, 1);
}
```

见 [arise_bo.c:141](arise_bo.c#L141)。第三个参数记录该候选 segment 的 `snoopable`。分配会依次尝试候选项，实际结果受设备配置和分配是否成功影响。`CacheType` 在这里用于影响 segment 选择，并不是 CPU PAT 字段的直接值。

## 6. `support_snoop` 如何传到 system 页分配

普通 BO 的主要调用链：

```text
create_info->flags.CacheType
    → bo->flag.cache_type
    → preferred_segments[i].snoopable
    → arise_bo_allocate_physical_memory(..., support_snoop)
    → flags.support_snoop
    → arise_pages_mgr_alloc_pages_memory(..., alloc_flags)
```

分配 system 页时，[arise_bo.c:650](arise_bo.c#L650) 设置：

```c
flags.need_flush    = !support_snoop;
flags.support_snoop = support_snoop;
bo->pages_mem = arise_bo_acquire_system_pages(bo, &flags);

// 成功后保存，供后续映射和 GPU PTE 使用
bo->flag.support_snoop = support_snoop;
```

`need_flush` 会触发分配阶段的页缓存处理；它不是每次 CPU/GPU 交接时自动执行的通用同步。

## 7. 页池与 `need_caching`

[arise_pages_mgr_select_pool](arise_pages_mgr.c#L106) 按 snoop 属性选择池：

```c
if (support_snoop)
    return &pages_mgr->write_back[order];
else
    return &pages_mgr->write_combined[order];
```

新页分配路径简化如下：

```c
int need_caching = 0;
struct page **caching = pages;

page = pool ? arise_pool_take_page(pages_mgr, pool) : NULL;
if (!page) {
    page = arise_pool_alloc_page(gfp_mask, order);
    // 错误处理省略
    if (!alloc_flags.support_snoop)
        need_caching = 1;
}

for (i = 1 << order; i; --i)
    *(pages++) = page++;

if (need_caching)
    set_pages_array_wc(caching, 1 << order);
```

实际 WC 设置受 `CONFIG_X86_PAT` 条件编译控制，见 [arise_pages_mgr.c:327](arise_pages_mgr.c#L327)。`need_caching` 是局部变量，其实际含义是“新分配的 nonsnoop 页需要设置 WC”，并不等于 `support_snoop`。从 WC 池取出的页按池管理逻辑已经具有对应属性，无须再次设置。

`caching` 指向当前批次在 `struct page *` 数组中的起点，`1 << order` 是这批的页数。`set_pages_array_wc()` 对数组列出的页批量设置 WC，数组本身不是被设置属性的目标。此调用的返回值在当前代码中没有检查。

回收时，页可以先回到对应池；真正释放给系统前，nonsnoop 页会调用 `set_pages_wb()` 恢复，见 [arise_pages_mgr.c:55](arise_pages_mgr.c#L55)。

## 8. BO 的 CPU 映射属性

对于驱动自己管理的 BO，[arise_bo_get_map_info](arise_bo.c#L848) 选择映射类型：

```c
if (bo->pages_mem) {                 // system RAM
    argu->flags.mem_type = ARISE_SYSTEM_RAM;
    if (bo->flag.support_snoop)
        argu->flags.mmap_cache_type = ARISE_MMAP_WRITE_BACK;
    else
        argu->flags.mmap_cache_type = ARISE_MMAP_WRITE_COMBINED;
} else {                             // local 显存窗口
    argu->flags.mem_type = ARISE_SYSTEM_IO;
    argu->flags.mmap_cache_type = ARISE_MMAP_WRITE_COMBINED;
}
```

这些是驱动选择的映射类型；平台可能限制最终有效属性。例如 [os_get_pgprot_val](os_interface.c#L2046) 在 x86 且没有 `CONFIG_X86_PAT` 的分支会将请求的 WC 转为 noncached。

GEM mmap 有一行初始设置：

```c
vma->vm_page_prot = pgprot_writecombine(vm_get_page_prot(vma->vm_flags));
```

但在 [arise_gem.c:752](arise_gem.c#L752) 的正常流程中，后续会根据 BO 的 `map_argu`，在 immediate 或 delay 映射路径重新计算 `vm_page_prot`。因此这行本身不能说明所有 BO 最终都是 WC。导入的 dma-buf 在到达该行之前交给 exporter 映射。

## 9. GPU PTE 与 PCIe 请求

填页表时，驱动把 BO 的 snoop 标志传给 PTE 构造函数：

```c
pte_snoop = bo->flag.support_snoop;
pte_value = mmu->funcs->pte(level, addr, pte_snoop,
                            pte_segment, pte_security, 0);
```

PTE 构造函数再填写字段：

```c
mmu_pte.pte_level3.pte_4k.Snoop   = snoop;
mmu_pte.pte_level3.pte_4k.Segment = segment;
mmu_pte.pte_level3.pte_4k.Addr    = addr;
```

见 [arise_vm_pt.c:1606](arise_vm_pt.c#L1606) 和 [arise_mmu.c:83](hw_blocks/arise_mmu.c#L83)。`Segment` 与 `Snoop` 是不同字段：前者描述目标位置，后者描述访问的一致性属性。

对于 PCIe 事务，读写通常分别是 Memory Read 和 Memory Write TLP。常见设计中，snoop/nonsnoop 会影响 TLP 的 **No Snoop 属性**，而不是换一条读写命令：No Snoop 为 0 时期望默认硬件一致性，为 1 时不要求硬件保证缓存一致性。驱动代码能证明 PTE 中填了 `Snoop`，但不能单独证明 Arise2 最终每个 TLP 的属性；要确认需要芯片文档或抓包。GPU 自身缓存命中时，也不一定每次访问都产生 PCIe 事务。

## 10. 缓存属性与 CPU/GPU 同步

下面是概念上的 CPU 写入、GPU 使用过程；屏障和提交 API 必须按实际平台及驱动协议选择：

```text
CPU 写入 BO
  → 完成必要的 cache 维护和写入排序
  → 提交任务 / 通知 GPU
  → GPU 读取 BO 并执行任务
```

反方向则需要等待 GPU 完成，并按平台和映射方式完成必要的可见性处理：

```text
GPU 写入 BO → GPU 完成 → CPU 等待 fence → 必要的 cache 维护 → CPU 读取
```

驱动提供的一个交接路径见 [arise_gem.c:1117](arise_gem.c#L1117)：`begin_cpu_access` 等待 BO fence；`end_cpu_access` 在映射类型为 WC 时调用 `arise_wmb()`。在 x86 上，[arise_disp.h:88](arise_disp.h#L88) 将其定义为 `sfence`。

```c
// end_cpu_access 中的代码
if (map_argu.flags.mmap_cache_type == ARISE_MMAP_WRITE_COMBINED)
    arise_wmb();
```

这只能证明该路径存在屏障，不能单独证明所有提交路径都完成了正确同步；需要结合实际调用路径检查。也不能忽略 GPU 自身 cache 的维护要求。

## 11. Fence buffer 与软件 fence

驱动里有两个分开分配的对象：

```c
// 软件对象：从 slab 分配
fence = kmem_cache_alloc(driver->fence_slab, GFP_KERNEL);
dma_fence_init(&fence->base, &arise_dma_fence_ops, ...);
```

```c
// GPU 可访问的硬件写回缓冲区：创建 BO
fence->fence_buffer_memory = arise_bo_create_reserved(
    arise_device, HW_FENCE_BUF_SIZE, 0,
    POOL_NONLOCALVIDMEM, cache_type, /* 其余参数省略 */);
```

软件 `arise_dma_fence` 保存关联 ring、等待目标值和 Linux `dma_fence` 状态；普通 slab 对象使用系统内存。fence buffer BO 保存 GPU 写回的进度值，CPU 可读取它。见 [arise_fence.c:150](arise_fence.c#L150) 和 [arise_ring.c:265](arise_ring.c#L265)。

```text
GPU 写回 ring 的 fence buffer 完成值
    → CPU 读取完成值
    → 与软件 fence->value 比较
    → 达到目标后 signal dma_fence，通知等待者
```

读取和比较见 [arise_sched.c:59](arise_sched.c#L59)、[arise_fence.c:44](arise_fence.c#L44)。fence buffer 通常请求 nonlocal 内存；特定 ARM cache quirk 下驱动请求 snoop，以规避代码注释中描述的读取旧 fence 值问题。实际分配也受设备配置影响。

如果 CPU 高频轮询 WC fence buffer，读访问可能比读取 WB 内存更昂贵；是否成为瓶颈需要结合实际轮询次数、中断路径和硬件测量。
