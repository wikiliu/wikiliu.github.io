---
title: "Firefox leak：重复共享 GEM handle 与 winsys handle 表"
date: 2026-10-24T00:00:00+09:00
classes: wide
categories:
  - 帖子
tags:
  - GPU
  - Firefox
  - DRM
  - BO
toc: true
toc_sticky: true
---

## 问题：已经导入的 handle，在同一进程内又被共享

这次 Firefox leak 的触发场景是：一个 BO 的 handle 已经导入，后面又在同一个进程内经过共享路径，重复执行 FD → handle 转换。本次关注的是 `screen_ws->fd != dev->fd` 的分支，通常出现在同一个进程内多个线程使用不同 screen/ws，并分别打开 DRM 设备的场景。

按本次排查结果，这条驱动路径又走了一次 Open/import 逻辑，而 `buf->mgr` 在最终释放时只会执行一次 `DRM_IOCTL_GEM_CLOSE`，重复打开与最终释放没有配平，于是出现 leak。

```text
BO 已导入，已有 handle
  → 同一进程内再次共享
  → get_handle 再走 FD → handle
  → 本次驱动路径重复 Open/import
  → buf->mgr 最终只 GEM_CLOSE 一次
  → 引用没有配平，产生 leak
```

这里需要区分通用 DRM 语义与本次驱动的问题：**不能把每次 `drmPrimeFDToHandle()` 都理解成创建一个必须额外 close 的新 GEM handle。** 同一 DRM file description 下，同一内存对象重复导入可以返回已有 handle；用户态负责去重并管理其生命周期。这一点见 [Linux DRM UAPI：GEM_CLOSE](https://www.kernel.org/doc/html/v6.12/gpu/drm-uapi.html#drm-ioctl-gem-close) 和 [PRIME_FD_TO_HANDLE](https://www.kernel.org/doc/html/v6.12/gpu/drm-uapi.html#drm-ioctl-prime-fd-to-handle)。

因此，本次修复是在用户态避免重复进入转换和 Open 路径，不能用“重复导入几次，就对同一个 handle 多 close 几次”来处理。

## 前提：只有经过 get_handle 的 BO 才按需加入表

`screen_ws->fd != dev->fd` 表示当前 screen/ws 使用的 fd 与设备级 `dev` 保存的 fd 不同。在上述多线程场景中，设备级对象可以复用，而各 screen/ws 使用各自的 DRM 打开实例，因此需要取得目标 `screen_ws->fd` 下的 handle。

多线程本身不意味着 fd 一定不同；线程也可以共享同一个 fd。这里的判断依据是实际的 `screen_ws->fd` 与 `dev->fd`，不是线程数量。

给每个 ws 增加 handle 表，但**不是 BO 一创建或一导入，就把它加入所有 ws 的列表**。

登记发生在 `gf_buffer_get_handle()` 中：某个 ws 真正请求了这个 BO 的 handle，才按需建立对应映射。截图中的实现使用 `screen_ws->kms_handles` 哈希表，可以理解成该 ws 已经取得的 KMS handle 列表。

```text
BO 创建 / 导入
  → 不因此加入 kms_handles

get_handle（KMS 类型）
  ├─ screen_ws->fd == dev->fd
  │   → 使用 BO 原有 GEM handle
  │   → 截图中的 is_shared 分支直接返回
  │
  └─ screen_ws->fd != dev->fd
      → 查当前 ws 的 kms_handles
          ├─ 已存在：返回缓存 handle
          └─ 不存在：FD → handle 成功后插入表
```

也就是说，**经过 `get_handle` 是入表的前提；当前截图中，实际插表发生在不同 fd 的转换分支成功之后。** 同 fd 分支复用原有 handle，不需要为它重复建立跨 fd 映射。

## get_handle：先查表，命中后直接返回

每个 ws 的表记录：

```text
screen_ws->kms_handles
  key   = wsbo
  value = 这个 BO 在 screen_ws->fd 下对应的 GEM handle
```

截图中新增的关键逻辑是：

```c
simple_mtx_lock(&dev->sws_list_lock);
entry = _mesa_hash_table_search(screen_ws->kms_handles, wsbo);
simple_mtx_unlock(&dev->sws_list_lock);

if (entry) {
    whandle->handle = (uintptr_t)entry->data;
    return GF_RET_SUCCESS;
}
```

命中后直接返回，避免再次 `bo_get_fd()`、`drmPrimeFDToHandle()`，也就避免再次进入本次导致引用不配平的 Open 路径。

未命中时，才执行原来的转换：

```c
status = drm_interface->bo_get_fd(zxbo, &dma_fd);
if (status)
    return GF_RET_FAIL;

status = drmPrimeFDToHandle(screen_ws->fd, dma_fd,
                            &whandle->handle);
close(dma_fd);

if (status)
    return GF_RET_FAIL;
```

转换成功后，把结果登记到当前 ws：

```c
simple_mtx_lock(&dev->sws_list_lock);
_mesa_hash_table_insert_pre_hashed(
    screen_ws->kms_handles,
    gf_get_gem_handle_from_bo_ptr(wsbo->bo_handle),
    wsbo,
    (void *)(uintptr_t)whandle->handle);
simple_mtx_unlock(&dev->sws_list_lock);
```

这里 `close(dma_fd)` 关闭的是临时 DMA-BUF fd，缓存下来的 GEM handle 另有生命周期，两者不能混为一次释放。

另外，“同一个进程”只是本次触发场景。GEM handle 的有效范围是 **DRM file description**，同一进程里的不同 DRM 打开实例不能直接混用 handle，所以映射放在各自的 ws 下。

## destroy：先清理 handle 表，再释放 zxbo

截图中的另一个修改，是把 `bo_unreference(zxbo)` 从清理表之前移到清理之后。

原来的顺序：

```text
bo_unreference(zxbo)
  → 遍历各 ws
  → 用 wsbo 查 kms_handles
  → GEM_CLOSE 并删除表项
```

问题在于：**`zxbo` 中的原始 handle 后续还要用于查表，不能提前关掉或释放。** 表项的 key 虽然是 `wsbo`，但插入时的预计算 hash 来自 `gf_get_gem_handle_from_bo_ptr(wsbo->bo_handle)`；查找、删除期间仍需要保证底层对象及其 handle 有效。提前 `bo_unreference()` 会破坏这个生命周期前提。

修改后的顺序是：

```c
/* zxbo 此时仍然有效。 */
simple_mtx_lock(&dev->sws_list_lock);
for (sws_iter = dev->sws_list; sws_iter;
     sws_iter = sws_iter->next) {
    if (!sws_iter->kms_handles)
        continue;

    entry = _mesa_hash_table_search(sws_iter->kms_handles, wsbo);
    if (entry) {
        struct drm_gem_close args = {
            .handle = (uintptr_t)entry->data
        };

        drmIoctl(sws_iter->fd, DRM_IOCTL_GEM_CLOSE, &args);
        _mesa_hash_table_remove(sws_iter->kms_handles, entry);
    }
}
simple_mtx_unlock(&dev->sws_list_lock);

/* 所有依赖原始 handle 的查表、删除操作结束后，再释放。 */
drm_interface->bo_unreference(zxbo);
```

销毁时遍历各 ws，只处理实际存在的表项：在对应 fd 上关闭缓存的 handle，并从表中删除。没有通过 `get_handle` 建立映射的 ws，没有对应表项，也就没有这份额外 handle 需要清理。

本次修改的两个关键点是：重复获取时复用当前 ws 已缓存的 handle；销毁时保留 `zxbo` 到所有依赖它的查表和清理操作结束。
