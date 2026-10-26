# Arise2 任务提交、页表依赖与 fence 机制

本文按当前工作区源码整理，重点说明 render、paging、页表辅助任务，以及 internal / RB / external fence 之间的关系。代码块为原文件节选；跨段节选使用“中间代码略”标明。示意编号只用于解释，不代表板上的实际编号。

以下结论来自静态源码追踪，没有进行硬件运行验证。internal fence 的流水线示意属于基于接口注释和调用顺序的硬件模型，不是 RTL 结论；“主要用途”指源码中的调用结构，不代表运行频次统计。

## 1. 先区分 task、ring、sched、BO 和 fence

| 名称 | 含义 |
| --- | --- |
| task | 一项工作，包含任务类型、context、sched、依赖和自己的完成编号 |
| ring / RB | GPU 读取命令的环形缓冲区，RB 是 ring buffer 的缩写 |
| engine | 执行 GPU 工作的硬件引擎，例如 GFX、DCE；一个引擎可以支持不同 ring |
| sched | 管理某条 ring 的软件调度状态，包括队列、已提交编号和已完成编号 |
| BO | buffer object，驱动管理的内存对象；业务 BO 和专用 fence BO 用途不同 |
| PTE | 页表项，记录 GPU 虚拟地址到物理存储的映射 |
| TLB | 硬件对地址转换结果的缓存；PTE 改变后可能需要使旧缓存失效 |
| fence | 一个进度标记，以及何时更新、如何判断满足条件的规则；不是独立执行工作 |

任务类型和 sched 不是一一对应：render、paging、vm_update、page_table_set 可以在硬件与配置允许时共用同一个 sched / ring。同 ring 的任务共用该 sched 的编号序列。

| 任务类型 | 主要工作 | 提交函数 |
| --- | --- | --- |
| `task_type_vm_update` | 写内存中的页目录／页表项 | `arise_submit_vm_update_task()` |
| `task_type_page_table_set` | 设置页表根，或使 TLB 失效，让硬件使用正确映射 | `arise_submit_page_table_set_task()` |
| `task_type_paging` | 搬运、填充 BO、清理 BL slot 等数据工作 | `arise_submit_paging_task()` |
| `task_type_render` | 执行用户提交的 DMA 命令，例如 3D 渲染 | `arise_submit_dma()` → `arise_submit_dma_task()` |

实际使用哪条 ring，取决于 `arise_hwblock_interface_init()` 选择的 `paging_context`、`vm_update_context`、`root_pt_context`，不能仅根据 task 名称判断。

源码：[arise_hwblock.c:604](arise_hwblock.c#L604)（节选）。

```c
if (arise_device->hw_interface->vm_update_context == arise_device->hw_interface->root_pt_context)
    device_info->pt_set_same_ring_flag = TRUE;
else
    device_info->pt_set_same_ring_flag = FALSE;

if (arise_device->hw_interface->vm_update_context == arise_device->hw_interface->paging_context)
    device_info->paging_same_ring_flag = TRUE;
else
    device_info->paging_same_ring_flag = FALSE;
```

`pt_set_same_ring_flag` 比较的是 VM update 与 page_table_set 使用的 context；`paging_same_ring_flag` 比较的是 VM update 与 paging 使用的 context。这两个标志都不是“是否与 render 共用 ring”的判断。

## 2. 三种硬件 fence，以及软件 dma_fence

| 类型 | 值存放在哪里 | 当前路径中的主要用途 | 当前路径中的取值方式 |
| --- | --- | --- | --- |
| internal fence | 指定硬件内部的 slot | 确认某条执行路径上的前序工作完成 | 复用固定标记，例如 `1`、`2`、`0xFFFF` |
| RB fence | CNU 内的共享硬件 slot | 不同 ring / engine 之间同步执行进度 | 写入任务的 64 位 `fence_id` |
| external fence | GPU、CPU 均可访问的内存地址，例如专用 fence BO | 把完成进度报告给 CPU | 写入任务的 64 位 `fence_id` |
| 软件 `dma_fence` | 内核对象 | BO 依赖、syncobj、回调及软件调度 | 软件 context / seqno；本驱动还记录对应硬件完成值 |

“internal 使用固定值”描述的是本文这些 KMD 调用点的用法，并非硬件只能使用固定值。RB / external 使用递增值也是这里的驱动分配策略。

软件 `dma_fence` 对象、内部 slot、RB slot、fence BO 不是同一个存储对象。软件 `dma_fence` 的 `context/seqno` 也不能直接当成硬件 `fence_id`。

## 3. external fence：专用 fence BO 中保存完成进度

### 3.1 分配和初始值

`arise_fence_buf_init()` 为对应 ring/sched 分配专用 fence BO，保存 GPU 地址和 CPU 映射，并初始化为零。`HW_FENCE_BUF_SIZE` 在 `arise_ring.h` 中定义为 `4*1024`；正常完成值使用指定位置的 64 位内容，不是每次提交都新分配一个 BO。

源码：[arise_ring.c:273](arise_ring.c#L273)（节选）。

```c
int cache_type = (arise_device->quirks & ARISE_QUIRK_MASK_ARM_CACHE_INV_FOR_WC) ? RESOURCE_CACHE_CACHEABLE : RESOURCE_CACHE_NON_CACHEABLE;
fence->fence_buffer_memory = arise_bo_create_reserved(arise_device, HW_FENCE_BUF_SIZE, 0,
                                                      POOL_NONLOCALVIDMEM, cache_type,
                                                      FALSE /* create_from_top */,
                                                      TRUE /* cpu_visible */,
                                                      TRUE /* global */,
                                                      FALSE /* phys_continuous */,
                                                      &sched->fence_buffer_gpu_va,
                                                      (void *)&sched->fence_buffer_cpu_va);
if (fence->fence_buffer_memory)
{
    sched->fence_buffer_gpu_va_fake = sched->fence_buffer_gpu_va + 8;
    sched->fence_buffer_cpu_va_fake = sched->fence_buffer_cpu_va + 1;
    // set the initial fence value to 0, to avoid random value before first render
    arise_bo_zero_memory(fence->fence_buffer_memory);
}
```

源码注释还记录了中断已经到达、CPU 却迟迟读到旧值的历史问题，所以这里有缓存属性与 snoop 相关处理。`volatile` 读本身不能代替平台所需的缓存一致性保证。

正常运行时，BO 中是“该 ring 最近完成的编号”，不是每个任务开始前清零：

```text
初始化：                        完成值 = 0
提交任务 1、2、3，但尚未完成：   完成值仍可能是 0
任务 1 完成：                   完成值 = 1
任务 2 完成：                   完成值 = 2
任务 3 完成：                   完成值 = 3
```

以上是普通硬件完成路径；测试、fake submit、hang recovery 等路径可能由软件改写完成值，例如 `arise_sched_hang_recovery()` 会改写该地址。

### 3.2 GPU 往 BO 写什么

DCE 提交尾部把 external fence 编码成五个 DWORD：一个命令头、两个地址字、两个数据字。

源码：[hw_blocks/arise_dce.c:641](hw_blocks/arise_dce.c#L641)（节选）。

```c
unsigned long long FenceOffset = misc_info->fence_buffer_gpu_va;
unsigned long long FenceId = dma_task->desc.fence_id;

/* 中间代码略 */

dce_fence.Major_Opcode = DCE_OPCODE_Fence_Dce;
dce_fence.Dwc = 4;
dce_fence.Fence_Type = FENCE_DCE_FENCE_TYPE_EXTERNAL64;
dce_fence.Irq = FENCE_DCE_IRQ_INTERRUPT_CPU;
*rb++ = dce_fence.uint;
*rb++ = (FenceOffset & 0xFFFFFFFF);
*rb++ = ((FenceOffset >> 32) & 0xFFFFFFFF);
*rb++ = (FenceId & 0xFFFFFFFF);
*rb++ = ((FenceId >> 32)& 0xFFFFFFFF);
```

可以把该命令的效果近似理解为：到达规定完成点后，把 `FenceId` 写到 `FenceOffset` 指向的内存中，并按 `Irq` 配置通知 CPU。这里 DCE 请求 CPU 中断；GFX 路径则根据 `need_send_irq` 决定是否请求中断。

### 3.3 CPU 如何判断完成

源码：[arise_sched.c:69](arise_sched.c#L69)（节选）。

```c
new_fence = *(volatile unsigned long long*)(sched->fence_buffer_cpu_va);

old_fence = sched->returned_fence_id;

/* check if new_returned valid, if not skipped it */
if((new_fence >  sched->returned_fence_id) &&
   (old_fence <= sched->last_send_fence_id))
{
    sched->returned_fence_id = new_fence;
    sched->ring->misc_info.returned_fence_id = sched->returned_fence_id;
    sched->uncomplete_task_num = sched->last_send_fence_id - sched->returned_fence_id;

/* 中间代码略 */

int arise_is_fence_back(struct arise_sched *sched, unsigned long long fence_id)
{
    unsigned long long returned_fence_id = 0ll;
    arise_sched_update_fence_id(sched, &returned_fence_id);

    if(sched->returned_fence_id >= fence_id)
        return 1;

    return 0;
}
```

在同一 ring 的有序完成语义下，观察到完成值 `N`，即可认为该 ring 中编号不大于 `N` 的任务已完成。中断路径会更新进度、唤醒等待者和 worker，并通知软件 dma_fence 处理；中断不是完成值本身。

### 3.4 GPU 是否通过读取 fence BO 等待

本文 render 开头的 `WAIT_RB_SYNC` 等待的是 CNU 中的 RB slot，不是反复读取 external fence BO。若要等待内存里的值，需要硬件支持的相应 external/memory WAIT 命令；不能把 external fence 写命令与这种 WAIT 混为一谈。

## 4. internal fence：前面的工作何时真正完成

### 4.1 命令头指定路径与 slot，后一个 DWORD 指定值

`SEND_INTERNAL_WRITEFENCE_DCE()` 生成命令头，`SEND_INTERNAL_FENCE_VALUE_DCE()` 生成这条命令的数据；二者合起来是一条 WRITEFENCE 命令。

源码：[../../chip/RegistersWrapper/Arise2/arise2DceRegisterCmd.h:92](../../chip/RegistersWrapper/Arise2/arise2DceRegisterCmd.h#L92)（节选）。

```c
static __inline uint32_t SEND_INTERNAL_WRITEFENCE_DCE(uint32_t Route, uint32_t SubRout, uint32_t Slot)
{
    Dce_Opcode_Cmd     Cmd = { 0 };

    Cmd.cmd_Fence_Dce.Major_Opcode = DCE_OPCODE_Fence_Dce;
    Cmd.cmd_Fence_Dce.Irq = FENCE_DCE_IRQ_NOP;
    Cmd.cmd_Fence_Dce.Fence_Type = FENCE_DCE_FENCE_TYPE_INTERNAL;
    Cmd.cmd_Fence_Dce.Slot_Id = Slot;
    Cmd.cmd_Fence_Dce.Route_Id = Route; // only valid for BLC.
    Cmd.cmd_Fence_Dce.Sub_Route_Id = SubRout;
    Cmd.cmd_Fence_Dce.Fence_Update_Mode = FENCE_DCE_FENCE_UPDATE_MODE_COPY;
    Cmd.cmd_Fence_Dce.Dwc = 1;

    return (uint32_t)Cmd.uint;
}

// Internal Write Fence Value
static __inline uint32_t SEND_INTERNAL_FENCE_VALUE_DCE(uint32_t FenceId)
{
    Cmd_Fence_Dce_Internal_Dword1   Cmd = { 0 };
    Cmd.Update_Value = (FenceId & 0xFFFF);

    return *(uint32_t*)&Cmd;
```

这里使用 COPY 模式，意思是将指定值写入 slot，不是给 slot 自增。DCE 接口定义内部 slot 保存 16 位值；当前代码定义了 8 个 slot。

### 4.2 DCE 提交尾部的完整内部同步

源码：[hw_blocks/arise_dce.c:624](hw_blocks/arise_dce.c#L624)（节选）。

```c
unsigned int *arise_dce_add_internal_dce_fence_wait(struct arise_device *arise_device, unsigned int *pCmdBuf)
{
    *pCmdBuf++ = SEND_INTERNAL_WRITEFENCE_DCE(FENCE_DCE_ROUTE_ID_DCE_FENCE, 0, DCE_FENCE_SLOT_DCE_BLT_DATA);
    *pCmdBuf++ = SEND_INTERNAL_FENCE_VALUE_DCE(DCE_FENCE_VALUE_KMD_BLT);
    *pCmdBuf++ = SEND_INTERNAL_WAIT_DCE_CHIP(arise_device->device_info.chip_id, DCE_FENCE_SLOT_DCE_BLT_DATA, WAIT_DCE_METHOD_EQUAL, DCE_FENCE_VALUE_KMD_BLT);

    *pCmdBuf++ = SEND_INTERNAL_WRITEFENCE_DCE(FENCE_DCE_ROUTE_ID_DCE_FENCE, 0, DCE_FENCE_SLOT_DCE_BLT_DATA);
    *pCmdBuf++ = SEND_INTERNAL_FENCE_VALUE_DCE(DCE_FENCE_VALUE_KMD_RESET);
    *pCmdBuf++ = SEND_INTERNAL_WAIT_DCE_CHIP(arise_device->device_info.chip_id, DCE_FENCE_SLOT_DCE_BLT_DATA, WAIT_DCE_METHOD_EQUAL, DCE_FENCE_VALUE_KMD_RESET);

    return pCmdBuf;
```

这段使用 `DCE_FENCE_SLOT_DCE_BLT_DATA`，即 slot 0；之前页表写入同步的 `arise_dce_update_ptes_sync()` 使用的是 `DCE_FENCE_SLOT_KMD`，即 slot 7。两处模式相似，但 slot 不同。

当前常量：`DCE_FENCE_VALUE_KMD_BLT = 1`，`DCE_FENCE_VALUE_KMD_CNU = 2`，`DCE_FENCE_VALUE_KMD_RESET = 0xFFFF`。源码前部旧注释曾写复位到 0，解释本段行为应以实际常量和命令为准。

上面的六个 DWORD 包含四条命令：

```text
WRITEFENCE：指定 DCE 路径，完成后将 slot 0 写成 1
WAIT：      等 slot 0 == 1
WRITEFENCE：指定 DCE 路径，完成后将 slot 0 写成 0xFFFF
WAIT：      等 slot 0 == 0xFFFF
```

普通 Arise2 的 WAIT 编码如下；调用处通过 CHIP 包装函数选择对应代际的编码。

源码：[../../chip/RegistersWrapper/Arise2/arise2DceRegisterCmd.h:118](../../chip/RegistersWrapper/Arise2/arise2DceRegisterCmd.h#L118)（节选）。

```c
static __inline uint32_t SEND_INTERNAL_WAIT_DCE(uint32_t Slot, uint32_t WaitMethod, uint32_t WaitValue)
{
    Dce_Opcode_Cmd    Cmd = { 0 };

    Cmd.cmd_Wait_Dce.Major_Opcode = DCE_OPCODE_Wait_Dce;
    Cmd.cmd_Wait_Dce.Slot_Id = Slot;
    Cmd.cmd_Wait_Dce.Wait_Mode = WAIT_DCE_WAIT_MODE_NORMAL_WAIT;
    Cmd.cmd_Wait_Dce.Method = WaitMethod;
    Cmd.cmd_Wait_Dce.Wait_Value = WaitValue;

    return (uint32_t)Cmd.uint;
}
```

### 4.3 为什么 BLT 在 WRITEFENCE 之前，而不是放在 WRITEFENCE 与 WAIT 之间

这里的 WRITEFENCE 是排在前序工作之后的完成标记，不是“初始化 fence、然后启动工作”。命令解析和实际执行可以并行推进，发出命令不等于工作完成。

硬件接口对 DCE 路径的注释直接说明了保证目标：

源码：[../../chip/HwInterface/Arise2/DCE_OPCODE.h:101](../../chip/HwInterface/Arise2/DCE_OPCODE.h#L101)（节选）。

```c
FENCE_DCE_ROUTE_ID_DCE_FENCE                            = 0, // BlockId=DCE, path: DCE->MAI, to ensure the write data all written into memory.
FENCE_DCE_ROUTE_ID_CNU_FENCE                            = 8, // BlockID=CNU; path: DCE->CNU, to ensure the TLB invalidate/ TTBR reg setting/ MAI register setting is done.
FENCE_DCE_ROUTE_ID_BLC_FENCE                            = 9, // BlockID=BLC; There are 5 BLC in Arise2, path: DCE->CNU->BLC->CNU-DCE to ensure the BLC flush/invalidate is done.
```

据此可以用下面的硬件模型理解；具体反馈电路与 slot 的物理更新位置，驱动源码不能确定。

```text
命令解析端                         执行／存储通路

发出 BLT ────────────────────────→ 执行 BLT 写操作
发出 WRITEFENCE(slot 0, 1) ───────→ 完成标记跟在前序工作之后
解析到 WAIT(slot 0 == 1)，等待       前序写操作达到规定完成点
                                   完成反馈使 slot 0 = 1
WAIT 条件满足，继续
```

后面复位到 `0xFFFF` 并再次 WAIT，合理解释是确保固定值 `1` 能安全复用，避免下一轮 WAIT 被旧的 `1` 提前满足。这一目的由命令模式推断；源码没有提供 RTL 证明。

### 4.4 “等空闲”的范围

`arise_dce_ring_post_dma()` 先追加上述内部同步，再追加 external / RB 完成标记。CPU 调用这个函数时只是在写命令，不在此处等待；GPU 后续执行到 WAIT 时才等待。

它确认的是所选路径上的前序工作完成。DCE 路径用于确认前序写入完成，CNU 路径用于确认 TLB 失效／页表根相关设置完成，BLC 路径用于确认相关缓存操作完成。不能由此推导整个 GPU 的所有引擎都空闲。

## 5. RB fence：把本 ring 的进度交给其他 ring

### 5.1 发送端

DCE 在提交尾部把自己的任务编号复制到对应 CNU slot。

源码：[hw_blocks/arise_dce.c:658](hw_blocks/arise_dce.c#L658)（节选）。

```c
/* rb Fence send */
if(arise_device->device_info.rb_fence_enable)
{
    dce_fence.Dwc = 2;
    dce_fence.Fence_Type = FENCE_DCE_FENCE_TYPE_RB_FENCE;
    dce_fence.Irq = FENCE_DCE_IRQ_NOP;
    dce_fence.Slot_Id = ring->misc_info.rb_slot_id;
    dce_fence.Fence_Update_Mode = FENCE_DCE_FENCE_UPDATE_MODE_COPY;
    //dce_fence.Route_Id //useless for rb fence, it's only route is from current engine to CNU
    *rb++ = dce_fence.uint;
    *rb++ = (FenceId & 0xFFFFFFFF);
    *rb++ = ((FenceId >> 32)& 0xFFFFFFFF);
```

硬件接口把 RB slot 描述为 CNU 中的 64 位计数存储。这里 `Slot_Id` 标识进度属于哪条 ring，值标识进度到达哪项任务。

external fence 与 RB fence 是两条独立命令：前者写 BO，后者更新 CNU slot。本任务使用相同 `FenceId`，不意味着两个位置会在同一瞬间更新。

### 5.2 等待端

GFX 在任务前部按依赖关系插入 RB WAIT。

源码：[hw_blocks/arise_gfx.c:1982](hw_blocks/arise_gfx.c#L1982)（节选）。

```c
/* rb fence wait for page table set */
if(arise_device->device_info.rb_fence_enable && misc_info->last_rb_fence_to_wait != 0)
{
    wait_rb_fence.Major_Opcode = CSP_OPCODE_Wait;
    wait_rb_fence.Wait_Mode    = WAIT_WAIT_MODE_WAIT_RB_SYNC;
    wait_rb_fence.Dwc          = 2;
    wait_rb_fence.Slot_Id = dma_task->rb_wait_slot_id;
    *rb++ = *(unsigned int*)&wait_rb_fence;
    *rb++ = (unsigned int)(misc_info->last_rb_fence_to_wait & 0xFFFFFFFF);
    *rb++ = (unsigned int)((misc_info->last_rb_fence_to_wait >> 32) & 0xFFFFFFFF);
}
```

这段是等待页表相关任务的进度。不要把 `NORMAL_WAIT` 的 16 位内部 slot 比较规则直接套到 `WAIT_RB_SYNC` 上：它是另一种 WAIT 模式，携带 64 位目标值；精确的硬件比较与反馈实现应以硬件规范为准。

### 5.3 编号如何产生

源码：[arise_sched.c:323](arise_sched.c#L323)（节选）。

```c
unsigned long long arise_inc_send_fence_id(struct arise_sched *sched, int dec_prepare_num)
{
    unsigned long long fence_id;

    arise_spin_lock_bh(sched->fence_lock);

    sched->last_send_fence_id++;

    sched->uncomplete_task_num = sched->last_send_fence_id - sched->returned_fence_id;

    fence_id = sched->last_send_fence_id;

    arise_spin_unlock_bh(sched->fence_lock);

    return fence_id;
}
```

因此编号按各自 sched 递增，不是所有 engine 共用一个全局编号。不同任务类型只要共用 sched，也共用这条编号序列。

```text
任务 A，位于 DCE：自己的 external/RB 完成编号均为 41
任务 B，位于 GFX：等待 DCE slot 的 41；自己的 external/RB 完成编号均为 100
```

“前置完成值”和“自身完成值”不是同一语义；即使不同 sched 的数字偶然相同，也不能说明是同一个完成点。

## 6. 软件提交检查和 GPU 的 WAIT 有什么区别

### 6.1 软件层检查 BO / syncobj 依赖，以及队列容量

`arise_render_parse_dependency()` 收集 BO、syncobj 等依赖，并可能组成一个 `wait_dma_fence`。`arise_can_submit_task()` 检查硬件未完成数量，并检查该依赖是否已完成。

源码：[arise_submit.c:96](arise_submit.c#L96)（节选）。

```c
if (sched->uncomplete_task_num < sched->hw_queue_size)
{
    if(task->type == task_type_render)
    {
        task_dma_t *dma_task = (task_dma_t*)task;
        dma_fence_t *sync_fence = NULL;

        /*check bo fences dependency firstly */
        if(dma_task->wait_dma_fence)
        {
            can = arise_dma_fence_is_signaled(dma_task->wait_dma_fence);
            if(can)
            {
                arise_dma_fence_release_cb(dma_task->wait_dma_fence);//correspond to arise_batch_parser_t.wait_dma_fence init value dma_fence_get
                dma_task->wait_dma_fence = NULL;
            }
        }
```

若条件不满足，worker 暂不提交该任务，后续继续调度。这与向 GPU 下发 WAIT 命令不同。另一个容易混淆的位置是 `arise_task_queue_add()` 的 `down_interruptible(q->sema)`：它等的是软件队列空位，不是任务 fence 完成。

### 6.2 页表依赖可以等 scheduled，也可以等 finished

| 软件状态 | 含义 |
| --- | --- |
| `scheduled` | 依赖任务已经提交；不等于硬件执行完成 |
| `finished` | 依赖任务已经完成 |
| `invalidated` | 本驱动页表依赖传递中的软件阶段标记；启用 RB fence 时不应直接解读为 TLB 已在硬件上失效完成 |

启用 RB fence 时，部分路径的软件依赖只需等到前置任务已经提交，再由 GPU WAIT 保证真正的执行顺序。

源码：[arise_vm.c:1990](arise_vm.c#L1990)（节选）。

```c
/* add page table set fence dependency to render task */
/* in order to fix jira-16276 in new vm mapping, page_table_set_task related to command bo need use finished fence */
if (!need_set_root_page_table && arise_device->device_info.rb_fence_enable && !task_desc->need_vm_update_cmd_bo)
    arise_target_task_add_dependency(task_desc, &page_table_set_task->desc.s_fence->scheduled, NULL);
else
    arise_target_task_add_dependency(task_desc, &page_table_set_task->desc.s_fence->finished, NULL);
```

这里只有在不需要设置页表根、启用 RB fence、且不涉及命令 BO 的 VM 更新时，才选择 `scheduled`；其他情况选择 `finished`。不能简化为“启用 RB fence 后软件永远不等完成”。

`arise_submit_dma_task()` 检查这些软件依赖，若仍有未满足项则返回 `-EBUSY`，让任务后续重新调度。

源码：[arise_submit.c:248](arise_submit.c#L248)（节选）。

```c
if(arise_sync_peek_fence(&dma_task->desc.sync, NULL))
{
    arise_mutex_unlock(sched->sched_lock);

    if(arise_device->hangdump_mgr->hang_dump_mode)
    {
        arise_mutex_unlock(arise_device->hangdump_mgr->hang_dump_lock);
    }

    return -EBUSY;
}
```

典型时间关系：

```text
CPU：提交页表任务 A → A 的 scheduled 满足 → 提交 render B
GPU：A 仍可能在执行；B 停在 WAIT A → A 完成 → B 继续
```

`arise_submit_page_table_set_task()` 在提交硬件命令后记录目标任务的 RB 等待值，并 signal 目标任务的 `invalidated` 软件 fence：

源码：[arise_submit.c:521](arise_submit.c#L521)（节选）。

```c
if(arise_device->device_info.rb_fence_enable)
{
    target_task_desc->s_fence->rb_value = page_table_set_task->desc.fence_id;
    target_task_desc->s_fence->invalidate_finished = &page_table_set_task->desc.s_fence->finished;

    dma_fence_get(target_task_desc->s_fence->invalidate_finished);

    arise_sched_fence_signal(target_task_desc->s_fence, SCHED_FENCE_INVALIDATED);
```

这里 signal 的时机是软件提交路径，不应把 `SCHED_FENCE_INVALIDATED` 这个名字直接理解为 GPU 已完成 TLB 失效。需要硬件完成状态时，应区分 `finished`、`invalidate_finished` 和实际 RB 完成点。

## 7. render 的完整页表依赖链

### 7.1 常见三阶段

```text
VM update：写 PTE
    ↓
page_table_set：设置页表根／使 TLB 失效
    ↓
render：restore → 执行用户 DMA → cacheflush/save → 完成标记
```

这是条件满足时的依赖链，不是每次 submit 固定产生三个任务。映射没变化时可以没有 VM update；不需要设置页表根且没有 TLB dirty 时可以没有 page_table_set；VM 更新量较大时还可能拆成多个 VM update 任务。

paging 负责数据工作，是按需发生的另外一种任务，不是上述三阶段中 page_table_set 的另一个名字。

### 7.2 VM update 到 page_table_set

`arise_handle_vm_update_task_dependency()` 在跨 ring 时选择 VM update 的软件依赖：

源码：[arise_vm.c:1607](arise_vm.c#L1607)（节选）。

```c
if(!arise_device->device_info.pt_set_same_ring_flag)
{
    if (target_task->s_fence->vm_update_fence)
        dma_fence_put(target_task->s_fence->vm_update_fence);

    if (arise_device->device_info.rb_fence_enable)
        target_task->s_fence->vm_update_fence = &update_vm_task->desc.s_fence->scheduled;
    else
        target_task->s_fence->vm_update_fence = &update_vm_task->desc.s_fence->finished;

    dma_fence_get(target_task->s_fence->vm_update_fence);
```

`arise_vm_update_root_page_table()` 再把该依赖及其 RB 值传给 page_table_set。page_table_set 对应的硬件命令，在需要时先等 `vm_update_rb_slot`，然后设置页表根／使 TLB 失效，最后报告自己的完成编号。

例如 DCE 设置页表根路径的前置 RB WAIT：

源码：[hw_blocks/arise_dce.c:791](hw_blocks/arise_dce.c#L791)（节选）。

```c
if(arise_device->device_info.rb_fence_enable && rb_wait_value)
{
    *rb++ = SEND_RB_WAIT_DCE_CHIP(arise_device->device_info.chip_id, arise_device->hw_interface->vm_update_rb_slot);
    *rb++ = (unsigned int)(rb_wait_value & 0xFFFFFFFF);
    *rb++ = (unsigned int)((rb_wait_value >> 32) & 0xFFFFFFFF);
}
```

### 7.3 page_table_set 到 render

页表任务自己的完成 ID 经 `target_task_desc->s_fence->rb_value` 交给 render；render 在提交时取出该值，并选择 `root_pt_rb_slot`。

源码：[arise_submit.c:260](arise_submit.c#L260)（节选）。

```c
fence_id = arise_inc_send_fence_id(sched, FALSE);
dma_task->desc.fence_id = fence_id;

/* 中间代码略 */

if (arise_device->device_info.rb_fence_enable)
{
    sched->last_rb_fence_to_wait = dma_task->desc.s_fence->rb_value;

    dma_task->rb_wait_slot_id = arise_device->hw_interface->root_pt_rb_slot;
    rb_wait_sched = arise_device->hw_interface->root_pt_sched;
}

arise_get_nsecs(&dma_task->desc.timestamp);

arise_sched_ring_schedule(arise_device, rb_wait_sched, sched, dma_task);
```

两组字段不要混淆：

| 字段 | 含义 |
| --- | --- |
| `dma_task->desc.fence_id` | 本 render 任务自己的完成编号 |
| `dma_task->desc.s_fence->rb_value` | 前置页表任务的完成编号 |
| `sched->last_rb_fence_to_wait` | 本次提交要等待的前置编号 |
| `dma_task->rb_wait_slot_id` | 前置进度所在的 CNU slot |

CPU 若已观察到前置任务完成，会省略硬件 WAIT：

源码：[arise_sched.c:419](arise_sched.c#L419)（节选）。

```c
if (rb_wait_sched)
{
    arise_sched_update_fence_id(rb_wait_sched, &returned_rb_fence_value);

    if (sched->last_rb_fence_to_wait > returned_rb_fence_value)
        misc_info->last_rb_fence_to_wait = sched->last_rb_fence_to_wait;
    else
        misc_info->last_rb_fence_to_wait = 0;
}
else
{
    misc_info->last_rb_fence_to_wait = 0;
```

这里检查的是前置 sched 的内存完成进度，用它判断是否还需要生成 RB WAIT；这不代表 GPU 的 RB WAIT 在读取 fence BO。

### 7.4 编号示例：同一次 render 不共用所有辅助任务的编号

以下示例假定 DCE 负责 VM update 与 page_table_set，GFX 负责 render，且该 render 允许先提交再由硬件等待。

```text
DCE ring：
  VM update，自己的 ID = 40
    写 PTE → 内部同步 → external 写 40 → RB 写 40
  page_table_set，自己的 ID = 41（本例只需使 TLB 失效）
    使 TLB 失效 → 内部同步 → external 写 41 → RB 写 41

GFX ring：
  render，自己的 ID = 100
    WAIT DCE slot 的目标值 41
    → restore → 用户 DMA → cacheflush/save
    → external 向 GFX fence BO 写 100
    → RB 向 GFX 对应 CNU slot 写 100
```

示例中 VM update 和 page_table_set 位于同一 ring，它们之间可以利用 ring 顺序衔接；若跨 ring，再添加对应的软件依赖与 RB WAIT。允许哪些辅助工作先提交、哪些必须先等 `finished`，仍由前述条件分支决定。

## 8. paging 也可能有前置步骤，但不是每次都走 render 三阶段

### 8.1 调用方准备映射，再提交数据搬运

例如 paging-in 的调用方先提交搬运所需的 VM update；跨 ring 时，启用 RB fence 则传递等待编号，否则 CPU 等 VM update 完成。

源码：[arise_paging.c:521](arise_paging.c#L521)（节选）。

```c
arise_submit_vm_update_task(arise_device, update_vm_task);

if (!arise_device->device_info.paging_same_ring_flag)
{
    if (arise_device->device_info.rb_fence_enable)
        paging_task->desc.s_fence->rb_value = update_vm_task->desc.s_fence->rb_value;
    else
        arise_wait_fence_back(arise_device, arise_device->hw_interface->vm_update_context->rb_index, update_vm_task->desc.fence_id, 1);
}

arise_submit_paging_task(arise_device, paging_task);

/* skip wait_fence_back when save_restore, use bo attach fence above instead */
if (!save_restore || wait_restore)
{
    arise_wait_fence_back(arise_device, paging_task->desc.sched->ring->rb_idx, paging_task->desc.fence_id, TRUE);
```

对应依赖关系：

```text
VM update：建立搬运源／目标所需的映射，自己的完成编号 A
    ↓
paging：需要时等待 VM update 的 A
    → 执行搬运
    → external / RB 报告 paging 自己的完成编号 B
```

同 ring 时，调用方使用 `paging_same_ring_flag` 分支依靠该 ring 的执行顺序。`arise_bo_clear()` 等路径也会按需生成映射准备与 paging/fill 任务；不是所有 paging 都必须有 VM update。

### 8.2 paging 自身如何提交

`arise_submit_paging_task()` 为本任务分配编号，将其包装为临时 `task_dma`，交给公共 ring 提交流程。

源码：[arise_submit.c:358](arise_submit.c#L358)（节选）。

```c
fence_id = arise_inc_send_fence_id(sched, FALSE);

paging_task->desc.fence_id = fence_id;
paging_task->desc.cmd_size = paging_task->dma->command_length;

vm_id_obj = arise_vm_id_mgr_choose_vm_id(arise_device->vm_id_mgr, context->device, context->rb_index);
arise_vm_id_add_sync(arise_device->vm_id_mgr, vm_id_obj->vm_id, fence_id, context->rb_index);
paging_task->desc.vm_id = vm_id_obj->vm_id;
arise_vm_update_root_page_table(arise_device, &paging_task->desc, vm_id_obj);

task_dma.desc.fence_id     = fence_id;

/* 中间代码略 */

if (arise_device->device_info.rb_fence_enable && paging_task->desc.s_fence->rb_value)
{
    sched->last_rb_fence_to_wait = paging_task->desc.s_fence->rb_value;

    task_dma.rb_wait_slot_id = arise_device->hw_interface->vm_update_rb_slot;
    rb_wait_sched = arise_device->hw_interface->vm_update_sched;
}

arise_get_nsecs(&paging_task->desc.timestamp);

arise_sched_ring_schedule(arise_device, rb_wait_sched, sched, &task_dma);
```

| 项目 | render | paging |
| --- | --- | --- |
| 前置 RB slot | `root_pt_rb_slot` | 需要时使用 `vm_update_rb_slot` |
| 前置等待值 | `desc.s_fence->rb_value` | `desc.s_fence->rb_value` |
| 自身完成值 | 自己分配的 `desc.fence_id` | 自己分配的 `desc.fence_id` |
| 完成命令生成 | 公共 ring 路径及对应 engine 的 post 函数 | 相同公共机制 |

因此 paging 在 DCE 上执行时，同样会在尾部做 internal fence + WAIT，然后发出 external fence，并在启用时发出 RB fence；两种完成命令使用 paging 自己的 ID。

### 8.3 paging 是否再创建 page_table_set

该提交函数也调用 `arise_vm_update_root_page_table()`，但正常 paging 使用驱动的 reserved context，其 device 为 `reserved_device`。

源码：[arise_ctx.c:404](arise_ctx.c#L404)（节选）。

```c
/* use the reserved contexts to do high priority tasks like bo clear, vm update, page table set */
create.priority = ARISE_CONTEXT_PRIO_HIGH;
create.type = CONTEXT_NORMAL_RENDER;
create.engine_index = RB_INDEX_DCE;
context = arise_create_context(arise_device->reserved_device, &create);
```

源码：[arise_vm.c:1955](arise_vm.c#L1955)（节选）。

```c
if (device != arise_device->reserved_device)
{
    task_page_table_set_t *page_table_set_task = NULL;

    /* No need to do set root page table and invalidate tlb */
    if (!need_set_root_page_table && !task_desc->rtlb_dirty.dirty && !task_desc->utlb_dirty.dirty && !task_desc->dtlb_dirty.dirty)
        return;
```

这个 guard 表明正常 reserved paging 路径不会在此另建 page_table_set 任务。因此不能仅凭函数名，就认为 paging 每次也会生成与用户 render 完全相同的三阶段。

本节描述有实际 DMA 命令的正常硬件路径。`command_length == 0` 的 paging 会走 fake-submitted 分支，不应套用正常命令序列；软件 DCE 配置也可能禁用 RB fence。

## 9. 一次 submit 的多个 BO 为什么挂同一个 fence

这里指旧 BO list 路径 `parser->bo_list` 的显式挂接。代码创建一个软件 fence，然后把同一个对象挂到本次列表中的多个 BO。

源码：[arise_task.c:682](arise_task.c#L682)（节选）。

```c
dma_fence = arise_dma_fence_create(arise_device->fence_drv, parser->dma_task->desc.sched->ring, 0xffffffffffffffffULL);
if (!dma_fence)
{
    arise_error("create arise_dma_fence fail in post dependency\n");
    return -ENOMEM;
}

if(parser->bo_cnt)
{
    for(i=0; i<parser->bo_cnt; i++)
        arise_dma_fence_attach_bo(parser->bo_list[i]->gem, dma_fence, parser->bo_write_op_list[i] ? 0 : 1);
}
```

```text
本次 submit：读取 A、读取 B、写入 C

BO A ─┐
BO B ─┼──→ 同一个软件 dma_fence F → 代表本次任务完成
BO C ─┘
```

- 本次新增的是同一个 fence 对象，不只是 ID 数字恰巧相同。
- 对读 BO 挂 shared fence，对写 BO 挂 exclusive fence，具体调用见 `arise_dma_fence_attach_bo()`。
- BO 还可能保留其他提交的依赖；不能说所有 BO 上的全部 fence 都相同。
- “挂 fence”是向 BO 的同步元数据保存引用，不是把 ID 写入这些业务 BO 的数据内容。
- 新 resident list / immediate_mode 等路径还有其他记录机制，不能把这一循环泛化为所有 API 提交路径。

创建时传入 `0xffffffffffffffffULL` 是待更新的初始硬件值，不是本次已经分配到的真实完成 ID。硬件提交阶段会更新同一个对象：

源码：[arise_sched.c:452](arise_sched.c#L452)（节选）。

```c

```

源码：[arise_fence.c:202](arise_fence.c#L202)（节选）。

```c
void arise_dma_fence_update_value(void *fence_, unsigned long long value)
{
    struct arise_dma_fence *fence = fence_;
    struct arise_dma_fence_driver *driver = fence->driver;

    spin_lock(&driver->lock);
    fence->value = value;
    spin_unlock(&driver->lock);
}
```

这个 `fence->value` 与内核 `dma_fence` 自身的 `context/seqno` 是不同字段。软件对象初始值 `~0ULL` 也不同于专用 fence BO 的内存初始值 `0`。

## 10. GFX 模板、restore/save 与 cache flush/invalidate

### 10.1 `SEND_EXTERNAL_FENCE(0)` 只初始化命令头

源码：[hw_blocks/arise_gfx.c:2209](hw_blocks/arise_gfx.c#L2209)（节选）。

```c
*(unsigned int*)(&rb_cmd_template->rb_cmd_part3.fence)         = SEND_EXTERNAL_FENCE(0);
```

`Cmd_Fence` 是带位域和 `.uint` 成员的联合体，因此这行可以直观理解为：

```c
/* 等价理解，不是对原源码的修改 */
rb_cmd_template->rb_cmd_part3.fence.uint = SEND_EXTERNAL_FENCE(0);
```

`SEND_EXTERNAL_FENCE()` 是内联函数，参数为中断类型；`0` 表示不请求中断，不是要写的 fence 值为 0。

源码：[../../chip/RegistersWrapper/Arise2/arise2Graphics2dRegisterCmd.h:330](../../chip/RegistersWrapper/Arise2/arise2Graphics2dRegisterCmd.h#L330)（节选）。

```c
static __inline uint32_t SEND_EXTERNAL_FENCE(uint32_t IrqType)
{
    Csp_Opcode_Cmd   Cmd = { 0 };

    Cmd.cmd_Fence.Major_Opcode = CSP_OPCODE_Fence;
    Cmd.cmd_Fence.Fence_Type = FENCE_FENCE_TYPE_EXTERNAL64;
    Cmd.cmd_Fence.Irq = IrqType;
    Cmd.cmd_Fence.Dwc = 4;
    return (uint32_t)Cmd.uint;
}
```

### 10.2 每次任务复制模板，填入地址、值和中断要求

源码：[hw_blocks/arise_gfx.c:2072](hw_blocks/arise_gfx.c#L2072)（节选）。

```c
arise_memcpy(&part3, &rb_cmd_template->rb_cmd_part3, sizeof(arise_submit_rb_cmd_part3_t));

/* 中间代码略 */

part3.fence_addr_l = (unsigned int)(misc_info->fence_buffer_gpu_va & 0xFFFFFFFF);
part3.fence_addr_h = (unsigned int)((misc_info->fence_buffer_gpu_va >> 32) & 0xFFFFFFFF);
part3.fence_data_l = (unsigned int)(dma_task->desc.fence_id & 0xFFFFFFFF);
part3.fence_data_h = (unsigned int)((dma_task->desc.fence_id >> 32) & 0xFFFFFFFF);

if (dma_task->desc.need_send_irq)
{
    *(unsigned int*)(&part3.fence)         = SEND_EXTERNAL_FENCE(FENCE_IRQ_INTERRUPT_CPU);
}

arise_memcpy(rb, &part3, sizeof(arise_submit_rb_cmd_part3_t));
rb += sizeof(arise_submit_rb_cmd_part3_t) >> 2;
```

修改的是局部 `part3` 副本，不是把模板永久改为每次任务的状态。随后追加的 RB fence 也使用 `dma_task->desc.fence_id`。

`arise_sched_ring_dma_schedule()` 的公共顺序是：申请 RB 空间 → pre_dma → emit_dma → 更新本任务 fence 信息 → post_dma → kickoff。`arise_ring_kickoff()` 写硬件 ring tail，通知 GPU 有新命令。

### 10.3 restore/save 的内容由 UMD 生成，KMD 仍负责引用执行

当前 Gallium 源码创建 restore/save/cacheflush DMA 缓冲区，在创建 context 时把 GPU 地址与长度传给 KMD；KMD 保存这些字段，在提交前后填入 DMA 地址与长度。它不等于“KMD 已完全不提交 restore/save”。

源码：[../../external/gf_gallium/src/gallium/winsys/glenfly/linux/gf_winsys_drm.c:96](../../external/gf_gallium/src/gallium/winsys/glenfly/linux/gf_winsys_drm.c#L96)（节选）。

```c
/* Pass UMD create restore/save hw ctx, cacheflush dma to KMD ringbuffer use */
create_context.restore_hw_context_gpu_va = create_ctx->restore_dma_gpu_va;
create_context.restore_hw_context_size = create_ctx->restore_dma_size;
create_context.save_hw_context_gpu_va = create_ctx->save_dma_gpu_va;
create_context.save_hw_context_size = create_ctx->save_dma_size;
create_context.cache_flush_gpu_va = create_ctx->cacheflush_dma_gpu_va;
create_context.cache_flush_size = create_ctx->cacheflush_dma_size;
```

源码：[hw_blocks/arise_gfx.c:2017](hw_blocks/arise_gfx.c#L2017)（节选）。

```c
part1.restore.restore_dma_addr_l = (unsigned int)(context->restore_hw_context_gpu_va & 0xFFFFFFFF);
part1.restore.restore_dma_addr_h.Address_High8 = (context->restore_hw_context_gpu_va >> 32) & 0xFF;
part1.restore.restore_dma.Dw_Num = context->restore_hw_context_size >> 2;

/* 中间代码略 */

part3.save.save_dma_addr_l = (unsigned int)(context->save_hw_context_gpu_va & 0xFFFFFFFF);
part3.save.save_dma_addr_h.Address_High8 = (context->save_hw_context_gpu_va >> 32) & 0xFF;
part3.save.save_dma.Dw_Num = context->save_hw_context_size >> 2;
```

对应 size 为 0 时，KMD 会清零对应模板区域；有非零 size 时才引用提供的命令缓冲区。这里说的是当前 checkout 的 Gallium 路径，不代表已确认机器上实际加载的 UMD 版本。

### 10.4 为什么 KMD 里只看到 cacheflush，没有独立的 invalidate

flush 通常指把缓存中的修改写到下一级存储；invalidate 指使缓存旧内容失效。具体作用到哪些缓存、是否组合执行，由具体硬件命令决定。

invalidate 已经包含在 UMD 生成的命令缓冲区中。restore DMA 中有 EU/TU 等缓存的 invalidate：

源码：[../../external/gf_gallium/src/gallium/drivers/arise/arise_op_r2.cpp:1619](../../external/gf_gallium/src/gallium/drivers/arise/arise_op_r2.cpp#L1619)（节选）。

```c
// invalidate eu/tu/cc/hc.
restore_dma->EUFSL1Invalidate.uint = SEND_FS_L1I_INVALIDATE_COMMAND_ARISE();
restore_dma->EUPSL1Invalidate.uint = SEND_PS_L1I_INVALIDATE_COMMAND_ARISE();
restore_dma->TUFEL1Invalidate.uint = SEND_TUFE_L1CACHE_INVALIDATE_COMMAND_ARISE();
restore_dma->TUBEL1Invalidate.uint = SEND_TUBE_L1CACHE_INVALIDATE_COMMAND_ARISE();
restore_dma->EUAllL1CInvalidate.uint = SEND_ALL_L1C_INVALIDATE_COMMAND_ARISE();
//Arise2 HW Limitation,https://jira.glenfly.com/browse/ARISE2-4350 invalid FE or BE independently may be invalid。
restore_dma->EUAllL1HInvalidate.uint = SEND_ALL_L1H_INVALIDATE_COMMAND_ARISE();
```

名为 cacheflush 的 DMA 内也同时包含 flush 与 invalidate，不是只有 flush：

源码：[../../external/gf_gallium/src/gallium/drivers/arise/arise_op_r2.cpp:1705](../../external/gf_gallium/src/gallium/drivers/arise/arise_op_r2.cpp#L1705)（节选）。

```c
cache_flush->DZS_Flush.Type = BLOCK_COMMAND_TEMPLATE_TYPE_FLUSH;
cache_flush->DZS_Flush.Target = BLOCK_COMMAND_FLUSH_TARGET_ALL_C;
cache_flush->DZS_Flush.Block_Id = FF_BLOCK;
cache_flush->DZS_Flush.Major_Opcode = CSP_OPCODE_Block_Command_Flush;

cache_flush->DZS_Invalidate.Type = BLOCK_COMMAND_TEMPLATE_TYPE_INVALIDATE_CACHE;
cache_flush->DZS_Invalidate.Target = BLOCK_COMMAND_FLUSH_TARGET_ALL_C;
cache_flush->DZS_Invalidate.Block_Id = FF_BLOCK;
cache_flush->DZS_Invalidate.Major_Opcode = CSP_OPCODE_Block_Command_Flush;

cache_flush->UAVFE_Flush.uint = SEND_UCACHE_3DFE_FLUSH_COMMAND_ARISE();
cache_flush->UAVFE_Invalidate.uint = SEND_UCACHE_3DFE_INVALIDATE_COMMAND_ARISE();
```

KMD 在 `arise_gfx_ring_post_dma_r2()` 中填入 `context->cache_flush_gpu_va` 和 `cache_flush_size`，引用执行这整段命令。不能仅根据 `cacheflush_cmd` 的变量名判断缓存操作范围。

另外，本文这里的 EU/TU 等 cache invalidate 与页表路径的 TLB invalidate 是不同对象的失效操作，不能混为一谈。

## 11. 阅读代码时的对应关系

| 问题 | 应查看的字段／路径 |
| --- | --- |
| 本任务完成时写多少 | `task->fence_id` |
| 本任务执行前等多少 | `task->s_fence->rb_value` / `last_rb_fence_to_wait` |
| 等哪个硬件进度 | `rb_wait_slot_id`，如 `root_pt_rb_slot` / `vm_update_rb_slot` |
| 本 ring 向哪里报告硬件进度 | `ring->misc_info.rb_slot_id` |
| CPU 从哪里读完成进度 | `sched->fence_buffer_cpu_va` |
| GPU 向哪里写内存完成值 | `misc_info->fence_buffer_gpu_va` |
| 软件依赖有没有满足 | `wait_dma_fence` / `arise_sync_peek_fence()` |
| 已提交还是已完成 | `scheduled` 与 `finished`，不要只看“fence”这个名字 |
| internal WAIT 是谁执行 | CPU 生成命令，GPU 后续执行 WAIT |
| 是否每个任务都要 paging／更新页表 | 看驻留状态、映射变化、dirty 标记及配置，不是固定步骤 |

最重要的编号关系：

```text
等待前置任务：使用前置 ring 的 slot ＋ 前置任务的完成编号
报告自身完成：external 与 RB 使用本任务自己的完成编号
```

两种完成命令的值相同，不代表前置任务、paging、页表任务、render 全部共用一个 ID；同一业务提交可能触发多个辅助任务，每个实际提交的任务从其 sched 分配自己的编号。
