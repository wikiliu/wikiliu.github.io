# `get_back_bo()` 的阻塞与完整唤醒机制

## 1. 先修正场景

正常同步下，下面两个状态不应该同时成立：

```text
BO1 正在被 CRTC scanout
BO1 对应的旧 render 任务仍未完成
```

KMS 在让 BO1 成为有效 scanout buffer 之前，应当等待 BO1 的 producer render fence。更合理的场景是：

```text
BO1：当前正在 CRTC scanout，Mesa locked=true
BO2：GPU render 尚未完成，准备替换 BO1
BO3：仍在 GPU/KMD 队列中
BO4：也处于 locked 状态

所有 buffer 都是 locked=true
→ get_back_bo() 没有可用 BO
→ glmark2 线程阻塞
```

此时最终让 BO1 可重用的不是“BO1 的 render fence 返回”，而是：

```text
BO2 render fence 完成
→ BO2 成功 flip 到 CRTC
→ BO1 退出 scanout
→ Weston 发送 BO1 的 wl_buffer.release
```

## 2. `get_back_bo()` 阻塞在哪里

相关代码在 `external/gf_gallium/src/egl/drivers/dri2/platform_wayland.c`：

```c
while (dri2_surf->back == NULL) {
    for (int i = 0; i < ARRAY_SIZE(dri2_surf->color_buffers); i++) {
        if (dri2_surf->color_buffers[i].locked)
            continue;

        dri2_surf->back = &dri2_surf->color_buffers[i];
    }

    if (dri2_surf->back)
        break;

    wl_display_roundtrip_queue(dri2_dpy->wl_dpy,
                               dri2_surf->wl_queue);
}
```

这里没有等待 BO fence，也没有使用 BO 专用的 mutex、信号量或 condition variable。

实际阻塞路径是：

```text
get_back_bo()
→ wl_display_roundtrip_queue()
→ wl_display_dispatch_queue()
→ poll/ppoll(Wayland socket, POLLIN)
→ glmark2 线程睡眠
```

### Wayland socket 是文件吗

Wayland 使用 Unix domain socket。当前板上的 socket 路径是：

```text
/run/user/1001/wayland-1
```

它在文件系统中表现为一个 socket 类型的特殊 inode，`ls -l` 通常以 `s` 开头：

```text
srwxr-xr-x ... /run/user/1001/wayland-1
```

但它不是普通文件：

- 不用于保存普通文件数据；
- 不能通过常规读取文件的方式读取协议内容；
- 路径主要用于让客户端找到并连接 Weston；
- 连接后，进程通过 socket fd 收发 Wayland 协议消息。

`poll()` 等待的是进程 fd table 中的 socket fd，不是不断检查 `/run/user/1001/wayland-1` 路径。

连接建立后可以看到类似：

```text
/proc/<glmark2-pid>/fd/<N> -> socket:[123456]
```

其中 `123456` 是内核 socket inode。`poll/ppoll` 本身不会生成新文件。

### `wl_display_roundtrip_queue()` 如何阻塞

它大致执行：

```text
发送 wl_display.sync 请求
→ 注册 sync callback
→ 循环调用 wl_display_dispatch_queue()
→ ppoll(POLLIN) 等 socket 可读
→ 读取并 dispatch Wayland event
→ 收到 sync callback 后返回
```

等待期间如果收到其他事件，例如 `wl_buffer.release`，也会在同一个 event queue 上先被 dispatch。

因此 `get_back_bo()` 的 while 循环不是在一个条件变量上精确等待“某个 BO 变空闲”，而是：

```text
处理已有事件
→ 扫描 buffer pool
→ 没有可用 BO
→ 做一次 Wayland roundtrip
→ 处理 release 等事件
→ 再次扫描 buffer pool
```

## 3. `locked` 的生命周期和同步保护

### 什么时候设置为 `true`

当 Mesa 选出一个 back buffer，并准备把它交给渲染端使用时：

```c
dri2_surf->back->locked = true;
```

此后这个 buffer 不会再次被 `get_back_bo()` 选中。

生命周期大致是：

```text
get_back_bo 选择 BO
→ locked=true
→ GL draw 到 BO
→ eglSwapBuffers
→ wl_surface.attach
→ wl_surface.commit
→ Weston 持有/处理 BO
→ wl_buffer.release
→ locked=false
```

`locked=true` 不仅表示“已经在 Weston 手里”，更准确地说是：

> 该 buffer slot 已经从 Mesa 可用池中取出，在当前渲染、提交和 Weston 持有周期结束前不能再次选择。

### 什么时候设置为 `false`

Mesa 注册了 client-side listener：

```c
static const struct wl_buffer_listener wl_buffer_listener = {
    .release = wl_buffer_release,
};
```

当收到 Wayland release event 时，客户端 callback 执行：

```c
dri2_surf->color_buffers[i].locked = false;
```

### `locked` 有 mutex 保护吗

`locked` 本身不是：

- atomic variable；
- spinlock；
- mutex；
- semaphore；
- kernel 锁。

当前代码依靠线程和事件串行化模型：

1. 同一个 EGLSurface 正常只能绑定并由一个 current context/thread 使用。
2. Wayland buffer event 被投递到该 surface 的专用 `wl_queue`。
3. `wl_buffer_release()` callback 由调用 `wl_display_dispatch_queue()` 的线程同步执行。
4. `eglSwapBuffers()` 在操作 buffer pool 前会 finish glthread，避免 GL unmarshalling thread 与 EGL 线程同时分配或释放 BO。

所以正常模型是：

```text
同一个 EGL/Wayland 事件线程
→ 扫描 locked
→ dispatch release callback
→ 修改 locked=false
→ 再次扫描 locked
```

不是一个线程写 `locked=false`，另一个线程同时等待条件变量。

如果应用违规地在多个线程同时操作同一个 EGLSurface，这个普通 `bool` 本身不足以提供并发保护。

## 4. 从 replacement BO fence 到 `get_back_bo()` 唤醒

假设：

```text
BO1：当前 scanout
BO2：准备替换 BO1，但 render 尚未完成
```

### 阶段一：KMS 等待 BO2 的 render fence

Weston 将 BO2 提交给 overlay plane 后，Arise KMD 在：

```c
arise_prepare_plane_fb()
```

中从 BO2 的 `dma_resv` 取出 producer exclusive fence：

```c
reservation_object_get_excl_rcu(
    arise_gem_resv(arise_fb->obj)
);
```

然后放入：

```c
new_plane_state->fence
```

Weston 一般使用：

```text
DRM_MODE_ATOMIC_NONBLOCK
| DRM_MODE_PAGE_FLIP_EVENT
```

所以：

```text
Weston 的 drmModeAtomicCommit() 返回
KMD atomic commit worker 在内核中等待 BO2 fence
```

KMD 的等待路径是：

```text
drm_atomic_helper_wait_for_fences()
→ dma_fence_wait()
→ arise_dma_fence_wait()
→ dma_fence_default_wait()
```

这里用的是内核 waitqueue，不是 epoll。

### 阶段二：GPU 完成 BO2

Arise GPU 完成相关任务后更新 returned fence ID。fence event thread 检测到 fence 已完成，然后调用：

```c
dma_fence_signal(&fence->base);
```

`dma_fence_signal()` 会：

```text
标记 fence 已完成
→ 执行已注册 dma_fence callback
→ 唤醒 dma_fence waitqueue
→ KMS atomic commit worker 继续运行
```

此时唤醒的是 KMD worker，不是 glmark2 的 `get_back_bo()` 线程。

### 阶段三：BO2 替换 BO1

KMD 继续完成 atomic commit：

```text
drm_atomic_helper_wait_for_fences()
→ arise_atomic_helper_commit_tail()
→ drm_atomic_helper_commit_planes()
→ arise_plane_atomic_update()
→ arise_crtc_atomic_flush()
```

随后 arm page-flip/vblank event：

```c
drm_crtc_arm_vblank_event(crtc, event);
```

显示硬件在 vblank 时将 overlay 从 BO1 切换到 BO2。

### 阶段四：DRM page-flip event 通知 Weston

显示中断进入：

```c
arise_vblank_intrr_handle()
→ drm_crtc_handle_vblank(crtc)
```

DRM core 随后：

```text
把 page-flip event 放入 Weston 对应 drm_file 的 event_list
→ 唤醒 drm_file 的 event_wait
→ /dev/dri/cardX 变成 POLLIN
```

Weston 的 libwayland event loop 使用 epoll 监听 DRM card fd：

```text
epoll_wait()
→ /dev/dri/cardX 可读
→ on_drm_input()
→ drmHandleEvent()
→ atomic_flip_handler()
```

### 阶段五：`drm_output_update_complete()`

`drmHandleEvent()` 读取并解析 DRM page-flip event 后，会在 Weston 同一个 event-loop 线程中直接调用：

```text
atomic_flip_handler()
→ drm_output_update_complete()
```

所以这里既有通知，也有顺序调用：

- “DRM fd 可读/page-flip event”是 KMD 到 Weston 的通知机制。
- 进入 `atomic_flip_handler()` 后，到 `drm_output_update_complete()` 是普通同步函数调用。
- 两者之间没有额外的线程通知、信号量或 eventfd。

对应顺序是：

```text
收到 BO2 的 page-flip completion
→ atomic_flip_handler 确认 BO2 的新 state 生效
→ drm_output_update_complete 标记 current state 完成
→ 释放旧的 state_last
```

旧的 `state_last` 中保存的就是 BO1。

### 阶段六：Weston 发送 BO1 release

Weston 释放旧 plane state：

```text
drm_output_update_complete()
→ drm_output_state_free(state_last)
→ drm_plane_state_free()
→ weston_buffer_reference(..., NULL)
→ BO1 busy_count--
```

当 BO1 的 compositor 引用计数降到 0，Weston 执行 server-side 函数：

```c
wl_buffer_send_release(bo1_resource);
```

这个函数运行在 Weston 进程中。

它不会直接调用 glmark2 代码，而是：

```text
构造 wl_buffer.release 协议消息
→ 放入 Wayland client connection 的发送队列
→ flush 到 Weston 与 glmark2 之间的 Unix socket
```

### 阶段七：Wayland socket 唤醒 glmark2

此时 glmark2 正阻塞在：

```text
ppoll(Wayland socket, POLLIN)
```

Weston 写入 release event 后：

```text
socket 接收缓冲区有数据
→ socket fd 变成 POLLIN
→ 内核唤醒 glmark2 线程
→ ppoll 返回
```

glmark2/Mesa 继续执行：

```text
wl_display_read_events()
→ wl_display_dispatch_queue_pending()
→ 解码 wl_buffer.release 协议事件
→ 调用 client-side wl_buffer_release() callback
```

这里的：

```c
wl_buffer_release(void *data, struct wl_buffer *buffer)
```

运行在 glmark2 进程的 EGL/Mesa 代码中。

因此两个相似名字分别是：

| 函数 | 执行进程 | 作用 |
|---|---|---|
| `wl_buffer_send_release()` | Weston | 发送 Wayland 协议事件 |
| `wl_buffer_release()` | glmark2/Mesa | 收到协议事件后的 client callback |

它们不是一次跨进程的普通函数调用，而是：

```text
Weston: wl_buffer_send_release()
→ Unix socket 中的 Wayland 协议消息
→ glmark2: wl_display_dispatch_queue()
→ Mesa: wl_buffer_release() callback
```

### 阶段八：`get_back_bo()` 继续运行

client-side callback 设置：

```c
color_buffers[bo1].locked = false;
```

之后 `wl_display_roundtrip_queue()` 收到自己的 sync callback 并返回。

`get_back_bo()` 的 while 循环重新扫描：

```c
if (color_buffers[i].locked)
    continue;
```

此时看到：

```text
BO1 locked=false
```

于是：

```text
dri2_surf->back = BO1
→ get_back_bo() 返回
→ glmark2 继续 draw
```

## 5. 完整唤醒关系

```text
BO2 GPU render 完成
    │
    ▼
dma_fence_signal(BO2)
    │
    │ 内核 waitqueue
    ▼
唤醒 KMS atomic commit worker
    │
    ▼
KMD 将 BO2 提交到 overlay plane
    │
    ▼
vblank 时 BO2 替换 BO1
    │
    ▼
DRM page-flip event
    │
    │ /dev/dri/cardX 可读
    ▼
epoll 唤醒 Weston
    │
    ▼
atomic_flip_handler()
    │
    ▼
drm_output_update_complete()
    │
    ▼
释放旧 state 中的 BO1
    │
    ▼
Weston: wl_buffer_send_release(BO1)
    │
    │ Wayland Unix socket
    ▼
glmark2 的 ppoll(POLLIN) 返回
    │
    ▼
wl_display_dispatch_queue()
    │
    ▼
Mesa: wl_buffer_release(BO1)
    │
    ▼
BO1 locked=false
    │
    ▼
get_back_bo() 重新扫描并选中 BO1
```

对应的等待机制分别是：

| 等待位置 | 等待对象 | 机制 |
|---|---|---|
| KMD 等待 BO2 render 完成 | `struct dma_fence` | 内核 waitqueue |
| Weston 等待 page flip | `/dev/dri/cardX` | epoll |
| glmark2 等待 Wayland 事件 | Wayland Unix socket fd | poll/ppoll |
| `get_back_bo()` 判断可用性 | `locked` 普通 bool | dispatch 事件后重新扫描，无条件变量 |

如果某个 BO 从未进入 KMS，只是被后续 `wl_surface.commit` 覆盖，Weston 可以直接发送它的 `wl_buffer.release`。这条短路径不经过 render fence、KMS page flip或vblank，但最后仍然通过 Wayland socket 唤醒 `get_back_bo()` 所在的 glmark2 线程。
