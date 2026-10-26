# 驱动中 semaphore 与 spinlock 的典型用法

以本驱动的任务提交队列为例：提交线程是生产者，worker 内核线程是消费者。

## 两者分别解决什么问题

| 机制 | 本例中的用途 | 等待方式 |
| --- | --- | --- |
| semaphore（计数信号量）`q->sema` | 限制待处理任务数量，每个名额允许一个任务进入 | 名额不足时可睡眠 |
| spinlock（自旋锁）`q->lock` | 保护共享任务链表及计数的短时修改 | 竞争时自旋，持锁期间不能睡眠 |

队列通过 `arise_task_queue_alloc()` 创建，信号量初值为 `max_num`；当前队列容量为 16。
信号量限制容量，但不能代替保护链表的锁；自旋锁保护修改，但不能代替等待空位的信号量。

## 为什么提交时 `intr = 1`

`arise_submit.c` 的 `arise_handle_dma_task()` 在启用 worker 时调用：

```c
ret = arise_add_task_to_pending_queue(sched, &dma_task->desc, 1);
```

`intr` 表示等待信号量是否允许被 Linux 信号打断，与 GPU 硬件中断开关无关。
它传到 `arise_task_queue_add()` 后决定：

```c
if (intr)
    ret = arise_down_interruptible(q->sema); /* down_interruptible() */
else
    arise_down(q->sema);                    /* down() */
```

- `intr = 1`：队列没有空位时睡眠等待；等待期间若有待处理信号，可返回 `-EINTR`，本次任务不会入队。
- `intr = 0`：同样会睡眠，但信号不能打断这次等待，需要等到拿到名额。

这条渲染提交路径来自用户进程的 `arise_ioctl_submit()`。选择 `1`，使等待队列空位的提交线程能响应信号，
避免队列长期不被消费时，仅因这个等待就无法响应终止请求。错误沿提交调用链返回给上层。
它只控制取得名额时的等待，不会撤销已经入队或正在 GPU 上执行的任务，也不是超时机制。

因此，`1` 是这条用户提交路径的可中断等待策略，并非信号量 API 强制要求。
对照之下，驱动内部的页表更新、显存搬运等任务多传 `0`；例如 `arise_vm_pt.c` 的页表更新入队后没有检查返回值，
后续逻辑依赖该任务已入队，不能直接改成可中断等待而不处理失败路径。

## 生产者与消费者如何配合

1. **生产者先取名额**：在自旋锁外执行 `down_interruptible()`；被信号打断则直接返回。
2. **准备任务**：取得名额后处理依赖等工作；准备失败时用 `up()` 归还名额。
3. **短时加锁入队**：持有 `q->lock`，将任务加入 `q->task_list` 并增加 `q->task_num`，随后解锁并唤醒 worker。
4. **消费者取任务**：worker 持有同一把锁，把共享链表移到局部链表，然后解锁，在锁外尝试提交任务。
5. **成功处理后归还名额**：worker 判定 `submitted` 成立后执行 `up(q->sema)`；暂时不能提交的任务放回队列，不归还名额。
6. **加锁合并剩余任务并更新计数**：worker 再次持锁更新共享队列，随后解锁。

这里的名额限制软件待处理任务。归还名额发生在 worker 成功提交/处理任务后，**不需要等待 GPU 执行完成**。
把任务暂时移到局部链表时也没有归还名额。

关键顺序是：**可睡眠的等待和任务处理放在自旋锁外，仅把共享数据的短时修改放在锁内**。
如果持有 `q->lock` 再等待队列名额，就违反持自旋锁不能睡眠的要求，也会阻碍消费者拿锁推进队列。

## 源码入口

- [arise_submit.c](arise_submit.c)：`arise_handle_dma_task()`，渲染提交传入 `intr = 1`。
- [arise_workerthread.c](arise_workerthread.c)：`arise_task_queue_alloc()`、`arise_task_queue_add()`、`arise_try_submit_task_queue_first_task()`。
- [os_interface.c](os_interface.c)：驱动封装与 Linux `sema_init()`、`down_interruptible()`、`up()`、`spin_lock()` 的对应关系。



1. KMS Handle只有get image采用，aws背后只有一个winsys，sws的bo也会创建在aws上，所以必须export。由于是用一个进程只会destory一次，所以get fd会增加一次引用计数。只有两次open card才会出现，一般都是dup
2. age reversed age表示page变动，vma age也需要变，所以vma age通常小于 reversed，做完vm update才相等
3. 线程调度每个rb index一个sheduler，每个sheduler管三个优先级task pool，context往对应的task pool上copy task，然后调度到hw ring上
4. internal fence在一个ring的多个dma之间，这是隐式的；rb fence没怎么用，不同ring之间；externel是显示fence，但是ring里面每次submit都会自己添加external fence.