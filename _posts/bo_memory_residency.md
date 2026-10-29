# Arise2 BO 内存管理与 context 调度机制

本文基于当前 `Linux/arise2_drm_kmd` 源码，说明 local memory 不足后的分配路径、BO 的 resident/pin 生命周期、跨客户端换出范围，以及 context 创建、ring 调度与任务队列容量。结论来自静态源码分析，未进行硬件内存压力测试。

## 1. 关键概念

| 概念 | 在本驱动中的含义 |
| --- | --- |
| BO（Buffer Object） | 一块由驱动管理的缓冲区，核心对象为 `struct arise_bo` |
| local memory | 驱动管理的本地显存/保留显存；独显上通常对应 VRAM |
| CPU-visible local | CPU 可以通过映射窗口访问的 local 部分 |
| non-CPU-visible local | local 的另一部分，不能按 CPU-visible local 的方式直接映射 |
| nonlocal/system memory | BO 背后的存储使用系统 RAM，由 `pages_mem` 表示 |
| segment | 描述 BO 所处内存区域及统计、分配属性的分类 |
| resident | BO 已驻留到某个有效 segment；不等同于“一定在 local 中” |
| pin | 固定 BO 的内存位置，防止使用期间被换出或搬动 |
| paging out | 将 local BO 的内容复制到系统内存，释放原 local 存储 |
| swapout | 将系统内存 BO 的内容保存到 shmem，再释放原系统页；与 local paging out 是两层机制 |

`SEG_PCIE_NONSNOOP` 和 `SEG_PCIE_SNOOP` 背后都可以是系统 RAM，不是两份独立的物理内存池。SNOOP 属性主要涉及 CPU/GPU 缓存一致性处理。

定义和分配实现见 [arise_memory_region.h](arise_memory_region.h)、[arise_memory_region.c](arise_memory_region.c) 和 [arise_bo.c](arise_bo.c) 中的 `arise_bo_allocate_physical_memory()`。

## 2. BO、context 和 device 的关系

首先区分两个名字相近的 device：

| 对象 | 范围与作用 | 关键成员 |
| --- | --- | --- |
| `arise_device` | 一块 GPU 设备的驱动实例 | `paging_mgr`、`memory_region_mgr`、`device_list` |
| `gpu_device` | 客户端对象；普通打开 DRM 文件时创建，通常有自己的 GPU 虚拟地址空间 | `arise_device`、`filp`、`vm`、`context_list` |
| `arise_context` | 客户端的执行上下文 | `device`、`rb_index`、`task_queue` |
| `arise_bo` | 归属某个 `arise_device` 的缓冲区，可有多个地址空间映射 | `arise_device`、`gpu_vm_list`、`segment_id`、`status.pin_count` |

普通客户端按 DRM 打开文件实例创建，不宜严格理解为“每个进程唯一一个 gpu_device”。内核还会创建 `reserved_device` 用于内部操作。

```text
arise_device：一块 GPU 设备
  ├─ gpu_device A：客户端 A
  │    ├─ vm A
  │    ├─ context A1
  │    └─ context A2
  ├─ gpu_device B：客户端 B
  │    ├─ vm B
  │    └─ context B1
  └─ paging_mgr：该 GPU 设备统一的换出管理器
       └─ segment_bo_lists[segment_id]
            ├─ lru_list[priority]：各客户端的可换出 BO
            └─ pinned_list：当前被固定的 BO
```

相关创建路径：

- [arise_drv.c](arise_drv.c)：打开 DRM 文件时，通过 `arise_create_device(arise_device, priv, 0)` 创建客户端对象。
- [arise_ctx.c](arise_ctx.c)：`arise_create_device()` 设置 `device->arise_device`，创建普通客户端的 `device->vm`，加入 GPU 设备的 `device_list`。
- [arise_ctx.c](arise_ctx.c)：`arise_create_context()` 设置 `context->device = device`。
- [include/kernel/arise_ctx.h](include/kernel/arise_ctx.h)：`arise_context`、`gpu_device` 的结构定义。

### 2.1 BO 不绑定唯一的 context

`struct arise_bo` 中的相关成员如下，摘自 [arise_bo.h](arise_bo.h)：

```c
struct arise_device                *arise_device;

struct list_head                   list_item;
struct list_head                   gpu_vm_list;
```

它没有一个表示“唯一所属 context”的成员。多个 context 可以使用同一个 BO；通过合法的共享、导入等路径，同一个 BO 也可以映射到多个客户端的 GPU 地址空间。

[arise_vm.c](arise_vm.c) 中 `arise_vm_map_gpu_virtual_address()` 为一次映射创建 VM node，加入 `bo->gpu_vm_list`，并记录 `new_node->device = device`。

因此，要区分三件事：BO 的物理存储归哪个 GPU 设备管理、哪些客户端有权访问它，以及哪些 context 当前正在使用它。统一内存管理不代表所有客户端都自动获得访问权限。

## 3. local memory 不够时分到哪里

### 3.1 候选 segment 的生成与实际容量

[arise_bo.c](arise_bo.c) 中 `arise_bo_set_segment_id()` 按 PoolType、缓存属性、CPU 可见性和设备配置生成候选顺序。

需要注意：函数先使用临时数组 `segments[5]`，最后只复制 `ARRAY_SIZE(bo->preferred_segments)` 项；当前 [arise_bo.h](arise_bo.h) 定义是：

```c
arise_bo_segment_preference_t      preferred_segments[3];
```

**因此实际最多保存 3 个候选，不能把临时数组中生成的 4 个候选都当作实际回退路径。**

以下表格假设 `system_only=0`、`local_only=0`、`snoop_only=0`、`cpu_visible_only=0`，且 BO 不要求 CPU 可见：

| PoolType / 缓存属性 | 实际候选顺序 |
| --- | --- |
| `POOL_VIDEOMEMORY` / `POOL_UNKNOWN`，默认缓存属性 | local 不可见 → local 可见 → 系统 NONSNOOP |
| 上述类型，`RESOURCE_CACHE_NON_CACHEABLE` | local 不可见 → local 可见 → 系统 NONSNOOP |
| 上述类型，`RESOURCE_CACHE_CACHEABLE` | 系统 SNOOP |
| `POOL_LOCALVIDMEM`，独显模式 | local 不可见 → local 可见 |
| `POOL_NONLOCALVIDMEM` / `POOL_SYSTEMMEM`，默认缓存属性 | 系统 NONSNOOP → 系统 SNOOP |
| 上述系统内存类型，`RESOURCE_CACHE_NON_CACHEABLE` | 系统 NONSNOOP |
| 上述系统内存类型，`RESOURCE_CACHE_CACHEABLE` | 系统 SNOOP |

补充条件：

- 普通视频内存要求 CPU 可见时，跳过 local 不可见候选；默认缓存属性下可保存的 3 项为 local 可见 → 系统 NONSNOOP → 系统 SNOOP。
- `POOL_LOCALVIDMEM` 仅在 `soc_mode && !snoop_only && !force_local` 时额外加入系统 NONSNOOP。
- `system_only` 会影响候选的 `is_local` 属性，所以不能仅凭 segment 名字判断实际物理存储。
- `local_only` 会将创建请求的 PoolType 改为 `POOL_LOCALVIDMEM`；其他特殊配置也会改变候选。

### 3.2 分配函数示例

下面是 `arise_bo_allocate_physical_memory_try()` 的核心摘录，省略了 trace 调用：

```c
for (i = 0; !allocated && i < ARRAY_SIZE(bo->preferred_segments); i++)
{
    if (preferred_segments[i].segment_id == SEG_INVALID)
        continue;

    allocated = arise_bo_allocate_physical_memory(bo, preferred_segments[i].segment_id,
                                                  preferred_segments[i].is_local,
                                                  preferred_segments[i].snoopable);
}

return allocated ? S_OK : -ENOMEM;
```

`arise_bo_allocate_physical_memory()` 再按 `is_local` 选择实际分配器：

```text
is_local = 1
  → arise_vram_mgr_allocate_fb_page_memory()
  → 保存到 bo->fb_pages_mem

is_local = 0
  → arise_bo_acquire_system_pages()
  → 普通 BO 使用 arise_pages_mgr_alloc_pages_memory()
  → 保存到 bo->pages_mem
```

普通视频内存 BO 可以先尝试系统内存回退；独显上显式要求 `POOL_LOCALVIDMEM` 的 BO，则需要换出其他 local BO 来腾出显存。

## 4. 分配失败如何触发自动换出

[arise_bo.c](arise_bo.c) 中 `arise_bo_prepare_memory()` 的实际控制关系是：

```text
arise_bo_allocate_physical_memory_try(bo)
  ├─ 成功：增加 resident_age，返回
  └─ -ENOMEM，且 try_times < 100
       → 遍历该 BO 的实际候选
       → 对 is_local 的候选调用：
          arise_paging_mgr_unresident_segment_bos(paging_mgr, segment_id)
       → 返回 S_OK：try_times++，重新尝试全部候选
       → 无法继续：打印分配失败日志并返回错误
```

这里的 100 是回收调用返回成功后重新分配的次数上限，不保证真的成功换出了 100 个 BO。

### 4.1 unresident_segment_bos 的候选范围

`arise_paging_mgr_init()` 为每个 `arise_device` 创建一套 `paging_mgr`，其中有按 segment 分类的 BO 链表。`arise_paging_mgr_unresident_segment_bos()` 从这里取候选：

```c
struct arise_segment_bo_list *segment_bo_list =
    &paging_mgr->segment_bo_lists[segment_id];
```

函数没有按 context、`gpu_device` 或进程过滤。它的范围是：**同一个 GPU 设备实例中，登记在指定 segment 回收链表里的 BO。** 不同物理 GPU 的 `arise_device` 各自管理。

例如客户端 A 的一次分配失败，可以触发客户端 B 的 BO 被换出；但 B 的 BO 必须满足换出条件，且换出不会使 A 获得其数据访问权限。

### 4.2 unresident 是动作，不是候选的先决状态

`arise_paging_mgr_unresident_segment_bos()` 从按优先级组织的 LRU 链表中选对象，核心摘录如下。省略了外层链表暂存、恢复及其锁操作：

```c
list_for_each_entry_safe(bo, next, &lru_list, list_item)
{
    arise_mutex_lock(bo->paging_lock);

    if (!bo->status.pin_count)
    {
        ret = arise_paging_mgr_unresident_bo(paging_mgr, bo);

        arise_mutex_unlock(bo->paging_lock);
        goto done;
    }

    arise_mutex_unlock(bo->paging_lock);
}
```

下层 `arise_paging_mgr_unresident_bo()` 又检查：

```c
if (bo->segment_id == SEG_INVALID || !bo->fb_pages_mem)
{
    arise_warning("can't unresident bo %x, only local bo can paging...\n", bo->gid);
    return -EINVAL;
}
```

所以选中的是当前仍然驻留在 local、且 `pin_count == 0` 的 BO，而不是已经被换出的 BO。

### 4.3 实际换出与数据保存

`arise_bo_paging_out(arise_device, bo, FALSE)` 的正常路径为：

1. 创建临时系统内存 BO，分配用于保存原数据的空间。
2. 创建 VM update 和 paging 任务，生成从原 BO 到临时 BO 的 GPU 拷贝命令。
3. 提交任务，在普通换出路径等待 paging fence 返回。
4. 将系统内存所有权转给原 BO。
5. 将原 local 存储交给临时 BO 的释放路径，并把原 BO 放入 `SEG_INVALID` 的链表。
6. 对非 global BO，更新映射客户端的 resident 待处理记录。

关键状态更新摘录：

```c
bo->pages_mem = blit_bo->pages_mem;
blit_bo->pages_mem = NULL;

if (!save_restore)
{
    blit_bo->segment_id = bo->segment_id;
    blit_bo->fb_pages_mem = bo->fb_pages_mem;
    bo->fb_pages_mem = NULL;

    bo->segment_id = SEG_INVALID;
    arise_paging_mgr_move_bo_to_segment_resident_list_tail(paging_mgr, bo);
}
```

BO 对象和数据继续存在。`SEG_INVALID` 表示此时没有有效的驻留 segment，不意味着没有任何物理数据副本；换出后的系统 RAM 数据仍由 `pages_mem` 保存。

## 5. resident 与 pin_count 是两个独立状态

| 状态 | 可以得出的结论 |
| --- | --- |
| `segment_id != SEG_INVALID` | BO 当前已驻留到一个有效 segment |
| `pin_count > 0` | BO 被固定，普通回收不能搬动它 |
| `pin_count == 0` | 没有固定者；可以成为回收候选，但不代表已经换出 |
| `SEG_INVALID` 且有 `pages_mem` | 可能是 local 换出后保留了系统内存副本；需要结合其他状态判断 |
| `SEG_INVALID` 且有 `file_storage` | 可能是系统内存 BO 已执行 swapout |

`arise_bo_unpin()` 不释放 local 存储、不清空 `fb_pages_mem`，也不把 `segment_id` 改成 `SEG_INVALID`。

### 5.1 pin / unpin 函数示例

以下为 [arise_paging.c](arise_paging.c) 中的函数实现：

```c
int arise_bo_pin(struct arise_bo *bo)
{
    int ret = 0;

    arise_mutex_lock(bo->paging_lock);
    ++bo->status.pin_count;

    ret = arise_bo_make_resident_locked(bo);
    if (ret != S_OK)
        -- bo->status.pin_count;

    arise_mutex_unlock(bo->paging_lock);

    return ret;
}

void arise_bo_unpin(struct arise_bo *bo)
{
    arise_mutex_lock(bo->paging_lock);

    if (--bo->status.pin_count == 0)
        arise_paging_mgr_move_bo_to_segment_resident_list_tail(bo->arise_device->paging_mgr, bo);

    arise_mutex_unlock(bo->paging_lock);
}
```

这里先增加 pin，再保证 BO 驻留，避免在准备阶段让目标 BO 成为普通换出候选。驻留失败会撤销本次增加。

链表移动函数 `arise_paging_mgr_move_bo_to_segment_resident_list_tail()` 根据计数选择目标：

```c
if (bo->status.pin_count)
{
    list_move_tail(&bo->list_item, &segment_bo_list->pinned_list);
}
else
{
    list_move_tail(&bo->list_item, &segment_bo_list->lru_list[bo->priority]);
}
```

因此最后一次 unpin 将 BO 放入对应 segment 的 LRU 尾部，后续内存压力才可能真正触发换出。LRU 是按优先级分组的回收候选顺序，不是每次 GPU 内存访问都会精确更新时间的硬件访问记录。

### 5.2 pin_count 什么时候变成 0

普通 BO 由清零分配创建，初始 pin 计数为 0；但 `Unpagable` 或 `share` BO 在创建时会额外持有一个 pin：

```c
if (bo->flag.unpagable || bo->flag.share)
    bo->status.pin_count++;
```

其他操作可以继续增加 pin。只有这些固定者对应的 unpin 全部完成，计数才会归零。例如两个 context 的任务各 pin 一次：

```text
原始：pin_count = 0
任务 A pin：0 → 1
任务 B pin：1 → 2
任务 A 回收，unpin：2 → 1，仍不能换出
任务 B 回收，unpin：1 → 0，进入 LRU，可以成为换出候选
```

这个计数属于 BO 本身，所有使用该 BO 的 context 累计到同一个计数上。BO 引用计数则用于对象生存期管理，不能代替 pin 计数。

## 6. 渲染任务使用后的 unpin 时机

### 6.1 普通提交路径

准备阶段见 [arise_task.c](arise_task.c) 和 [arise_bo.c](arise_bo.c)：

```text
arise_render_parse_post_dependency()
  → 非 immediate 模式使用 parser->bo_list
  → arise_bo_list_prepare_resident()
  → 对列表中的 BO 调用 arise_bo_pin()
  → 准备并执行相应的 GPU 映射更新
  → 提交 GPU 任务
```

正常完成后的回收路径：

```text
arise_sched_release_completed_tasks()
  → arise_is_fence_back(sched, task->fence_id) 确认任务完成
  → 从 submitted_task_list 移除
  → arise_task_dec_reference(task)
  → 最后一个任务引用释放时：arise_sched_do_release_task()
  → desc->release()
  → arise_dma_task_release()
  → arise_bo_unpin()
```

`arise_dma_task_release()` 中对应的摘录：

```c
if (dma_task->flag.has_resident)
{
    if(!context->flag.immediate_mode)
    {
        for(i = 0; i < dma_task->bo_cnt; i++)
        {
            arise_bo_unpin(dma_task->bo_list[i]);
            dma_task->bo_list[i] = NULL;
        }
    }

    for(i = 0; i < dma_task->resident_cnt; i++)
        arise_bo_unpin(dma_task->resident_bo_list[i]);

    if(parser->pin_cnt > 0)
    {
        for(i = 0; i < parser->pin_cnt; i++)
            arise_bo_unpin(parser->pin_list[i]);
    }
    /* 后续清理省略 */
}
```

因此，正常任务中的 pin 持有到 GPU 完成并进入任务释放阶段；不是 CPU 提交接口返回就立刻 unpin。即使硬件已经完成，回收尚未执行或任务仍有其他引用时，计数也可能暂时未下降。

### 6.2 immediate 模式与其他固定者

immediate 模式通过客户端的 `resident_list_todo` 和 `resident_list` 准备本次任务需要的 BO：

- `arise_render_parse_bos()` 将待处理记录放入 parser 的 `resident_list`，已有 resident 记录放入 parser 的 `pin_list`。
- `arise_render_parse_post_dependency()` 固定需要准备的 resident BO。
- `arise_render_vm_handling()` 成功后固定 `pin_list` 中的 BO。
- 任务释放时，对应的 `resident_bo_list` 和 `pin_list` 执行 unpin。

客户端的这些 resident 链表用于提交与映射维护，和 GPU 设备统一管理的 `segment_bo_lists` 是不同链表，不应根据名称将它们混为一谈。

此外，任务完成不一定使计数归零，因为还可能有其他固定者：

| 操作 | 释放本次 pin 的位置 |
| --- | --- |
| 内核 CPU 映射 `arise_bo_kmap()` | 最后一次实际解除映射时，`arise_bo_kunmap()` 调用 unpin |
| BO fill/clear 等异步操作 | 相关 fence 回调安排延迟清理，再由工作函数执行 unpin |
| 其他未完成任务 | 各自任务释放时 unpin |
| `Unpagable` / `share` 的初始 pin | 普通任务的成对 pin/unpin 不会消除这一个初始固定计数 |

相关代码见 [arise_bo.c](arise_bo.c) 的 `arise_bo_kmap()`、`arise_bo_kunmap()`、`arise_bo_fill()`，以及 [arise_vm.c](arise_vm.c) 的 `arise_dma_fence_delay_release_callback()`、`arise_device_release_delay_entry_func()`。

## 7. 被换出的 BO 再次使用时会怎样

`arise_bo_pin()` 会调用 `arise_bo_make_resident_locked()`。后者区分：

1. 已有有效 `segment_id`：继续使用当前驻留位置，必要时调整链表。
2. 有 `file_storage`：先执行系统内存 swapin。
3. 有普通自有 `pages_mem`、但没有有效 segment：调用 `arise_bo_resident()`。
4. 尚无物理存储：调用 `arise_bo_prepare_memory()` 进行分配。

`arise_bo_resident()` 不一定把数据搬回 local。如果当前 paging segment 本就在 BO 的候选列表中，它直接把 `segment_id` 设为该系统内存 segment，并增加 `resident_age`；只有不允许以该系统内存 segment 驻留时，才进入 `arise_bo_paging_in()`。

`resident_age` 是 BO 存储/驻留变化后用于判断映射是否需要更新的代数，不是 pin 计数。相关映射路径通过 VM node 的 age 和 BO 的 `resident_age` 判断是否需要更新页表。

## 8. 系统内存也不足时的行为

驱动有一层系统内存 swapout：

```text
arise_pages_mgr_alloc_pages_memory()
  → 当 swap_enable 开启且超过 used_pages_limit
  → arise_paging_mgr_global_swapout()
  → arise_paging_mgr_segment_swapout()
  → arise_paging_mgr_swapout_bo()
  → arise_pages_memory_swapout()
```

[os_interface.c](os_interface.c) 中 `arise_pages_memory_swapout()` 使用 `shmem_file_setup()` 创建保存空间，将内容复制进去。shmem 页是否能进一步进入磁盘 swap，取决于 Linux 的 swap 配置及资源情况；这不是驱动直接写一个磁盘文件。

但当前 [arise_pages_mgr.c](arise_pages_mgr.c) 初始化明确设置：

```c
pages_mgr->swap_enable = 0;
```

当前驱动源码中没有找到其他开启位置。因此默认配置不能依赖这条路径继续换出系统内存 BO。

已注册的 shrinker 统计和回收的是 `pages_in_pool`，即驱动页池里缓存的空闲页；它不直接执行仍在使用的 BO 的换出。

当允许的候选都无法分配，且 local 换出无法腾出可用空间时，分配路径最终返回 `-ENOMEM`。local 换出本身也需要系统内存保存数据，系统 RAM 紧张时，这一步同样可能失败。

## 9. 名称相近但含义不同的接口

| 接口或字段 | 实际作用 |
| --- | --- |
| `arise_bo_pin()` / `arise_bo_unpin()` | 固定/解除固定 BO 位置，维护 `status.pin_count` |
| `arise_bo_make_resident_locked()` | 保证 BO 驻留；本函数本身不增加 pin 计数 |
| `arise_paging_mgr_unresident_segment_bos()` | 从指定 segment 的统一回收链表选择 local BO，尝试换出 |
| `arise_gem_make_resident_locked()` | 保证驻留，成功后增加 `bo->resident_cnt` |
| `arise_gem_evict_locked()` | 减少 `bo->resident_cnt`，并在相关模式下附加最后的 fence；不直接执行 local paging out，也不调用 unpin |
| `arise_bo_get()` / `arise_bo_put()` | 持有/释放对象引用，控制生存期，不等于固定物理位置 |

尤其不能因为 `arise_gem_evict_locked()` 名字里有 evict，就认为它直接调用了自动换出路径。当前 `unresident_segment_bos()` 的候选检查使用的是 `pin_count`，不是 `bo->resident_cnt`。

## 10. 当前实现的边界

以下是阅读当前函数时需要保留的限定，本文没有修改这些实现：

- 实际 `preferred_segments` 只有 3 项，多余的临时候选不会保存。
- `arise_paging_mgr_unresident_segment_bos()` 并非每次遍历并换出整个 segment。它在当前优先级里找到首个 `pin_count == 0` 的对象后，尝试换出并跳到链表恢复处；返回成功则结束。
- 该函数初始化 `ret = 0`，而 `S_OK` 也是成功值。当当前优先级没有可处理对象时，也可能以成功返回并提前结束优先级遍历。因此 **S_OK 不足以证明实际换出了一个 BO**，也不能仅凭这次返回值判断 segment 已有空闲空间；调用者后续重新分配才是直接的结果检验。
- 100 次重试是调用者的次数上限，不保证回收容量，也不保证恰好换出 100 个 BO。
- `pin_count == 0` 表示没有固定者，不是一个可以脱离调用路径直接使用的“GPU 已空闲”证明。正常任务路径通过完成回收来解除对应 pin；手工调用调试接口时仍需满足其调用与同步条件。

## 11. 典型过程示例

假设同一个 `arise_device` 上，客户端 A 与 B 各有一个 BO：

```text
B 的 BO 已驻留 local，pin_count = 0
  → B 提交任务，pin_count = 1
  → A 分配 local 失败：此时不能换出 B 的该 BO
  → B 的 GPU 任务完成并被回收，pin_count = 0，重新进入 LRU
  → A 再次触发分配回收，B 的 BO 可以成为候选
  → 成功 paging out：B 的数据保存到系统 RAM，原 local 空间被释放
  → A 重试分配，可能使用腾出的空间
  → B 再次使用该 BO：先 pin 并保证驻留，再维护相应映射
```

这个例子中的回收是跨客户端的，但范围限定在同一 GPU 设备；BO 对象、访问权限与保存的数据不会因换出而归属客户端 A。

## 12. open、context 创建与 ring 的关系

### 12.1 open 只创建客户端，用户 context 由 ioctl 按需创建

[arise_drv.c](arise_drv.c) 中 `arise_drm_open()` 的相关操作是：

```c
priv->ctx_idr = arise_create_idr();
priv->ctx_table_lock = arise_create_spinlock();

priv->gpu_device = arise_create_device(arise_device, priv, 0);
```

这里创建 context 句柄表和客户端 `gpu_device`，没有调用 `arise_create_context()`。新客户端的 `context_list` 在 `arise_create_device()` 中初始化为空链表。

用户态驱动随后通过 `ARISE_IOCTL_CREATE_CONTEXT` 请求创建 context，进入 [arise_ioctl.c](arise_ioctl.c) 的 `arise_ioctl_create_context()`：

```c
context = arise_create_context(priv->gpu_device, create_context);
```

`arise_create_context()` 每次分配一个新对象，关联客户端，初始化任务队列引用，并加入客户端的 `context_list`。一个客户端可以请求多个 context，数量不与 ring 数量绑定，也不是每个 open 自动分配固定的一套用户 context。

### 12.2 多个 context 可以共用一个 ring / sched

[arise_ctx.c](arise_ctx.c) 的 context 创建代码选择目标 ring：

```c
context->device = device;
arise_device_resource_ref_num_inc(device);

context->rb_index = (create_context->type == CONTEXT_PAGING_QUEUE) ?
        (arise_device->paging_engine_index) : create_context->engine_index;
```

普通 context 根据请求的 `engine_index` 记录目标 ring；paging queue 使用设备选择的 paging ring。

[arise_sched.c](arise_sched.c) 中 `arise_sched_by_rb_idx()` 遍历已初始化的 rings，返回匹配 ring 的 `&ring->sched`。每条 ring 有自己的 sched，多个 context 可以指向同一条 ring：

```text
客户端 A 的 context A1 ─┐
客户端 A 的 context A2 ─┼──→ GFXL ring / 同一个 sched
客户端 B 的 context B1 ─┘
客户端 B 的 context B2 ────→ DCE ring / 另一个 sched
```

因此，新增用户 context 不会同时新增一条 ring，也不会为该 context 新建一套 ring 调度器。

### 12.3 内核 reserved context 是另外一组对象

GPU 初始化时调用 `arise_create_reserved_device()` 和 `arise_create_reserved_context()`，创建内部使用的客户端和 context：

| 成员 | 目标 ring |
| --- | --- |
| `reserved_context_dce` | DCE |
| `reserved_context` | GFXL |
| `reserved_context_sw_dce` | 软件 DCE |
| `reserved_context_mce` | MCE，按配置创建 |

这些对象用于 BO 清零、paging、VM update、page table set 等内部操作。[arise_hwblock.c](arise_hwblock.c) 根据硬件能力和配置，从中选择 `paging_context`、`vm_update_context`、`root_pt_context`，这些角色也可能引用同一个 context。

它们按 GPU 设备初始化，不随每次客户端 open 再创建一套。不能把这几个 reserved context 的数量当成整个驱动允许的用户 context 数量。

## 13. task queue 的入队、调度与数量限制

本节说明启用 worker thread 的正常提交路径。`arise_handle_dma_task()` 在 `worker_thread_enable` 关闭时有直接调用 `arise_submit_dma()` 的分支，不能将下面的 worker 准入流程无条件套用于该分支。

### 13.1 当前配置下，context 从创建时就引用 sched 的共享队列

[arise_sched.c](arise_sched.c) 的 `arise_sched_init()` 当前设置：

```c
sched->hw_queue_size = sched->ring->max_hw_submission;
sched->timeout = sched->ring->hw_hang_timeout_ns;
sched->name = args->name;
sched->sequence_schedule = 1;
```

因此当前创建 context 时走的是共享队列分支。[arise_workerthread.c](arise_workerthread.c) 中 `arise_init_task_queue()` 根据 ring 找到 sched，并按优先级取得已有队列引用：

```c
if (sched->sequence_schedule)
{
    list_for_each_entry(q, &sched->task_queue_list->queue_list, link)
    {
        if (q->priority == context->priority)
        {
            context->task_queue = arise_task_queue_get(q);
            break;
        }
    }
}
```

同一 ring、同一优先级的多个 context，`context->task_queue` 指向同一个 `q`。任务直接加入这个共享队列，没有先进入独立 context 队列、再搬到另一条公共 schedule queue 的步骤。

代码也保留了 `sequence_schedule == 0` 的分支：每个 context 分配自己的 task queue，再将队列注册到对应 sched 的队列池；当前初始化没有选择该模式。

```text
context A ─┐
context B ─┼─ 相同 ring、相同 priority
context C ─┘
           ↓
       同一个 q->task_list
           ↑
该 ring 的 sched->task_queue_list：队列池
  ├─ queue_list：登记队列 q
  └─ active_list[priority]：登记待调度队列 q

另一条 ring → 另一套 sched、队列池和 worker
```

队列池保存队列，task 保存在 `q->task_list` 中；`active_list` 挂的是队列的 `active_link`，不是 task。队列空闲后还可能暂时保留 active 状态，之后由 `arise_task_queue_try_deactive()` 移除。

### 13.2 入队与唤醒时机

普通 render 的调用链如下：

```text
arise_handle_dma_task()
  → arise_add_task_to_pending_queue(sched, task, 1)
    → arise_task_queue_add(context->task_queue, task, intr)
      → down_interruptible(q->sema) / down(q->sema)：取得软件队列名额
      → 真实 render 准备 BO 驻留、依赖和映射
      → 增加 task 引用
      → 把 task 加入 q->task_list
      → 必要时把 q 加入 pool->active_list[priority]
    → 增加 sched->enqueue_tasks_num
    → 唤醒 sched->worker_thread
```

真正将任务放进待提交链表的是 `arise_task_queue_add()`：

```c
arise_spin_lock(q->lock);
list_add_tail(&t->schedule_node, &q->task_list);
++q->task_num;
arise_get_nsecs(&t->enqueue_timestamp);
arise_spin_unlock(q->lock);
```

信号量名额在 BO 准备之前取得，所以“16 个名额”也可能包含已取得名额、尚未完成准备和入链的任务，不能简单等同于瞬间观察到的链表长度。

### 13.3 worker 直接从队列取任务提交

```text
arise_worker_thread_event_handler()
  → arise_schedule()
    → 从高到低检查 pool->active_list[priority]
    → 选择队列 q
    → arise_try_submit_task_queue_first_task(sched, q)
      → 取 q 的队首任务
      → arise_can_submit_task() 检查 ring 容量、任务依赖
      → 按 render / paging / vm_update / page_table_set 类型提交
      → 成功：释放软件队列名额和队列持有的 task 引用
      → 不能提交或提交需等待：放回该队列头部
```

真实 render 的提交中还可能创建 page-table-set 工作；相关依赖未满足时，`arise_submit_dma_task()` 返回 `-EBUSY`，render 会留在软件队列中等待下一次调度。

成功提交的任务由 `arise_set_task_submitted()` 加入该 sched 的 `submitted_task_list`。这是已提交任务的完成跟踪链表，不是另一条等待调度的公共队列；它使用 `task->list_item`，而待调度队列使用 `task->schedule_node`。

### 13.4 两层数量限制

| 层次 | 当前限制 | 容量满后的行为 |
| --- | --- | --- |
| 每个软件 task queue | 16 个名额 | 提交线程等待 `q->sema` |
| 每条 ring 的已提交但未完成任务 | 当前 ring 初始化值为 5 | worker 暂停继续提交该 ring 的任务，任务保留在软件队列 |
| `submitted_task_list` 的链表长度 | 没有独立的固定长度准入限制 | 已完成但尚未回收的记录仍可能留在链表里 |

软件队列容量来自 `arise_init_task_queue_pool()`：

```c
arise_task_queue_t *q = arise_task_queue_alloc(16, k);
```

`arise_task_queue_alloc()` 再用 `arise_create_sema(max_num)` 初始化名额。当前共享队列模式下，同一 ring、同一优先级的所有 context 共用这 16 个名额，不是每个 context 各有 16 个。不同优先级队列各有自己的名额。

ring 的准入条件来自 [arise_submit.c](arise_submit.c) 中 `arise_can_submit_task()`：

```c
sched->returned_fence_id = *(volatile unsigned long long*)(sched->fence_buffer_cpu_va);
sched->uncomplete_task_num = sched->last_send_fence_id - sched->returned_fence_id;

if (sched->uncomplete_task_num < sched->hw_queue_size)
{
    /* 后续还要检查任务依赖 */
}
```

`hw_queue_size` 来自 `ring->max_hw_submission`；当前 GFX、DCE、MCE、VCP、VPP 和软件 ring 初始化中均设置为 5。这是按提交 fence 进展控制的未完成任务数量，不是 context 数、BO 数、DMA 段数或 ring buffer 的字节容量。多个优先级、多个 context 提交到同一 ring 的任务共同使用这一限制。

`submitted_task_list` 的长度也不能替代这个计算：GPU 已完成但尚未被软件回收的任务，仍可能留在跟踪链表里。

### 13.5 软件名额释放不等于任务完成或 BO unpin

worker 成功提交任务后，在 `arise_try_submit_task_queue_first_task()` 中立即执行：

```c
if(submitted)
{
    ++task_num;
    arise_up(q->sema);

    arise_task_dec_reference(task);
    arise_atomic64_dec(sched->enqueue_tasks_num);
}
```

这里减少的是队列持有的 task 引用；正常已提交任务还有完成跟踪路径持有的引用，不会仅因这一操作就立即释放并 unpin。

```text
任务成功提交到 ring
  → up(q->sema)：释放软件队列名额
  → CPU 可以继续向软件队列入队
  → GPU 仍可能正在执行，相关 BO 仍保持 pin

GPU 完成，驱动回收 submitted task
  → 最后一个 task 引用释放
  → arise_dma_task_release()
  → 对应 BO 执行 unpin
```

当 ring 的未完成提交数达到上限时，正常推进链是：

```text
GPU fence 进展
  → arise_update_sched_status() 更新完成进度并唤醒 worker
  → worker 发现 ring 有名额，继续提交软件队列任务
  → 提交成功后 up(q->sema)
  → 等待软件队列名额的 CPU 提交线程继续
```

`intr=1` 只表示软件队列名额等待可以被 Linux 信号打断，不控制 GPU 硬件中断，也不负责修复缺失的 fence。BO 的 unpin 时机仍应按第 6 节的任务完成回收路径判断。

## 14. 源码导航

| 文件 | 建议阅读的对象或函数 |
| --- | --- |
| [arise_bo.h](arise_bo.h) | `arise_bo_status`、`arise_bo`、`preferred_segments[3]` |
| [include/kernel/arise_ctx.h](include/kernel/arise_ctx.h) | `arise_context`、`gpu_device` |
| [arise_drv.h](arise_drv.h) | `arise_device`、`arise_file`、客户端 resident 链表 |
| [arise_drv.c](arise_drv.c) | DRM 打开文件时创建客户端对象的路径 |
| [arise_ctx.c](arise_ctx.c) | `arise_create_device()`、`arise_create_context()`、`arise_create_reserved_context()` |
| [arise_ioctl.c](arise_ioctl.c) | `arise_ioctl_create_context()` |
| [arise_sched.c](arise_sched.c) | `arise_sched_init()`、`arise_sched_by_rb_idx()`、`arise_update_sched_status()` |
| [arise_workerthread.c](arise_workerthread.c) | 队列池初始化、`arise_init_task_queue()`、`arise_task_queue_add()`、`arise_schedule()`、`arise_try_submit_task_queue_first_task()` |
| [arise_submit.c](arise_submit.c) | `arise_handle_dma_task()`、`arise_can_submit_task()`、`arise_submit_dma_task()`、`arise_set_task_submitted()` |
| [arise_hwblock.c](arise_hwblock.c) | `arise_hwblock_interface_init()` 选择内部工作使用的 context |
| [arise_bo.c](arise_bo.c) | `arise_bo_set_segment_id()`、`arise_bo_prepare_memory()`、`arise_bo_make_resident_locked()`、`arise_bo_list_prepare_resident()` |
| [arise_paging.c](arise_paging.c) | `arise_paging_mgr_init()`、`arise_bo_pin()`、`arise_bo_unpin()`、`arise_paging_mgr_unresident_segment_bos()`、`arise_bo_paging_out()`、`arise_bo_resident()` |
| [arise_task.c](arise_task.c) | `arise_render_parse_bos()`、`arise_render_parse_post_dependency()`、`arise_dma_task_release()`、`arise_sched_release_completed_tasks()` |
| [arise_vm.c](arise_vm.c) | `arise_vm_map_gpu_virtual_address()`、`arise_render_vm_handling()`、`arise_device_release_delay_entry_func()` |
| [arise_gem.c](arise_gem.c) | `arise_gem_make_resident_locked()`、`arise_gem_evict_locked()` |
| [arise_pages_mgr.c](arise_pages_mgr.c) | 系统页分配、`swap_enable` 初始值、shrinker |
| [os_interface.c](os_interface.c) | `arise_pages_memory_swapout()`、`arise_pages_memory_swapin()` |




1. paging out = unresident. resident list包括pin和unpin，每个segment维护几个优先级lru list（表示可以paging out的bo list，优先级越低越容易paging out）和pinned_list，task finish会把bo加到lru lisr，真正决定paging out出去才unresident bo. 先从系统内存pool（包括cachable 和 uncachable）里分，pool不够了再alloc page，这个pool是bo release放进去的.
2. swap out. alloc page系统不会swap，需要自己做. 有一套机制move 到 shmem_file_setup. 
3. swap和paging out都只弄一个bo，外面的alloc physical mem 循环100次