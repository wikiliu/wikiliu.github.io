---
title: "mutter_scanout_analysis"
date: 2026-08-05T12:14:50+09:00
classes: wide
categories:
  - 帖子
tags:
  - 帖子
toc: true
toc_sticky: true
---

# Mutter KMS/Scanout 能力演进分析

## 版本发布历史

| 版本   | 发布日期 | GNOME 版本 |
| ------ | -------- | ---------- |
| 3.36.0 | 2020-03  | GNOME 3.36 |
| 3.38.0 | 2020-09  | GNOME 3.38 |
| 40.0   | 2021-03  | GNOME 40   |
| 41.0   | 2021-09  | GNOME 41   |
| 42.0   | 2022-03  | GNOME 42   |
| 43.0   | 2022-09  | GNOME 43   |
| 44.0   | 2023-03  | GNOME 44   |
| 45.0   | 2023-09  | GNOME 45   |
| 46.0   | 2024-03  | GNOME 46   |
| 47.0   | 2024-09  | GNOME 47   |

---

## Feature 支持矩阵

| Feature                                        | 3.36        | 40      | 42      | 43/44         | 45+      |
| ---------------------------------------------- | ----------- | ------- | ------- | ------------- | -------- |
| **Legacy KMS** (`meta-kms-impl-simple`)        | ✅          | ✅      | ✅      | ✅            | ✅       |
| **Atomic KMS** (`meta-kms-impl-device-atomic`) | ❌          | ✅      | ✅      | ✅            | ✅       |
| **KMS Modifiers** (`use_modifiers`)            | 实验性      | ✅ 默认 | ✅      | ✅            | ✅       |
| **GBM surface with modifiers**                 | ❌ (实验性) | ✅      | ✅      | ✅            | ✅       |
| **Plane IN_FORMATS 解析**                      | ✅          | ✅      | ✅      | ✅            | ✅       |
| **`drmModeAddFB2WithModifiers`**               | ❌ (实验性) | ✅      | ✅      | ✅            | ✅       |
| **Client Buffer Direct Scanout**               | ❌          | ❌      | ✅ 初版 | ✅ 完善       | ✅       |
| **`zwp_linux_dmabuf_feedback_v1`**             | ❌          | ❌      | ✅      | ✅            | ✅       |
| **TEST_ONLY atomic 预检**                      | ❌          | ❌      | ✅      | ✅            | ✅       |
| **Compositor buffer scanout 预检**             | ❌          | ❌      | ❌      | ✅            | ✅       |
| **Async scanout failure 处理**                 | ❌          | ❌      | ❌      | ✅ (MR !2854) | ✅       |
| **Opaque format 替换直出**                     | ❌          | ❌      | ❌      | ❌            | ✅ (49+) |

---

## 关键 Commit / MR

| 版本 | Commit / MR                | 内容                                                                              |
| ---- | -------------------------- | --------------------------------------------------------------------------------- |
| 3.36 | -                          | Legacy KMS 唯一实现，`use_modifiers` 需 `META_EXPERIMENTAL_FEATURE_KMS_MODIFIERS` |
| 40.0 | `1818d21da56` MR !1488     | **Atomic mode setting** 首次引入 (`meta-kms-impl-device-atomic.c`)                |
| 42.0 | MR !1488 (完善) + MR !1864 | **Direct scanout** 初版, `zwp_linux_dmabuf_feedback_v1`                           |
| 42.0 | `c9960850c` MR !2417       | Direct scanout 测试用例 (VKMS)                                                    |
| 43.0 | `50396fc00` MR !2546       | `META_KMS_DEVICE_FLAG_HAS_ADDFB2` 标志位拆分                                      |
| 44.0 | `b9fe9c736`                | `onscreen/native: Add API to check whether buffer is scanout compatible`          |
| 44.0 | MR !2854                   | **Async scanout failure** — TEST_ONLY 通过但实际 commit 失败的异步处理            |
| 44.0 | `f037c9df`                 | wayland/dma-buf: 无 modifier 支持时也能发送 scanout tranche                       |
| 44.0 | `e6109cfc`                 | renderer-native: Fall back to non-modifier GBM surfaces                           |
| 46.0 | 多个 MR                    | 支持 cropped/scaled surfaces 的 direct scanout                                    |

---

## 路径 1: 旧版 Legacy KMS Page Flip (mutter 3.36)

### 调用栈

```
meta_onscreen_native_swap_buffers_with_damage()          [meta-renderer-native.c:2058]
  │
  ├─ meta_drm_buffer_gbm_new(gpu, surface, use_modifiers=FALSE)
  │    │                                                  [meta-drm-buffer-gbm.c:112]
  │    ├─ gbm_surface_lock_front_buffer(surface)
  │    │    └─ 获得 bo, gbm_bo_get_modifier() → TILED (但会被忽略)
  │    └─ meta_gpu_kms_add_fb(gpu, use_modifiers=FALSE)
  │         │                                            [meta-gpu-kms.c:68]
  │         └─ drmModeAddFB2(fd, format, handles, strides)
  │              └─ FB 创建时 modifier=0 (DRM_FORMAT_MOD_NONE)
  │
  ├─ meta_onscreen_native_flip_crtcs()
  │    └─ meta_onscreen_native_flip_crtc()
  │         ├─ meta_crtc_kms_assign_primary_plane(crtc, fb_id)
  │         │    └─ 只有坐标设置, 无 format/modifier 检查
  │         └─ meta_crtc_kms_page_flip(crtc, feedback, kms_update)
  │
  └─ post_pending_update(kms)
       └─ meta_kms_impl_simple_process_update()           [meta-kms-impl-simple.c:916]
            │
            ├─ process_mode_set()
            │    └─ drmModeSetCrtc(fd, crtc, fb_id, connectors, mode)
            │
            ├─ process_cursor_plane_assignment()
            │    └─ drmModeSetCursor / drmModeMoveCursor
            │
            └─ process_page_flip()                        [meta-kms-impl-simple.c:620]
                 └─ drmModePageFlip(fd, crtc, fb_id, DRM_MODE_PAGE_FLIP_EVENT, data)
```

### 失败路径 (process_page_flip)

```
drmModePageFlip() 返回值:
  ├─ 0         → 成功
  ├─ -EBUSY    → schedule_retry_page_flip() — 用相同 fb_id 延迟重试
  ├─ -EINVAL   → mode_set_fallback()           [meta-kms-impl-simple.c:693]
  │               └─ drmModeSetCrtc(fd, crtc, **同样的 fb_id**, ...)
  │                    ├─ 成功 → frame 显示 (buffer 未变)
  │                    └─ 失败 → return FALSE → discard_page_flips → 帧丢弃
  └─ 其他错误   → return FALSE → discard_page_flips → 帧丢弃

错误最终处理:
  post_pending_update()
    └─ g_warning("Failed to post KMS update: %s", error->message)
         // 帧丢弃, 无 blit, 无重分配, 无 fallback buffer
```

---

## 路径 2: 新版 Atomic KMS (mutter 40+)

### 调用栈 — Compositor Buffer Flip（无变化, 路径 1 的 atomic 版本）

```
meta_onscreen_native_swap_buffers_with_damage()
  │
  ├─ meta_drm_buffer_gbm_new(gpu, surface, use_modifiers=TRUE)
  │    │
  │    ├─ gbm_surface_lock_front_buffer(surface)
  │    │    └─ bo modifier = LINEAR (surface 用 gbm_surface_create_with_modifiers 创建)
  │    └─ meta_gpu_kms_add_fb(gpu, use_modifiers=TRUE)
  │         └─ drmModeAddFB2WithModifiers(fd, format, modifier=LINEAR, &fb_id)
  │
  └─ meta_kms_impl_device_atomic_process_update()         [meta-kms-impl-device-atomic.c]
       │
       ├─ 构建 atomic request:
       │    drmModeAtomicAddProperty(req, plane_id, "FB_ID", fb_id)
       │    drmModeAtomicAddProperty(req, plane_id, "CRTC_ID", crtc_id)
       │    drmModeAtomicAddProperty(req, plane_id, "SRC_X/Y/W/H", ...)
       │    drmModeAtomicAddProperty(req, plane_id, "CRTC_X/Y/W/H", ...)
       │    drmModeAtomicAddProperty(req, crtc_id, "MODE_ID", mode_blob)
       │    drmModeAtomicAddProperty(req, crtc_id, "ACTIVE", 1)
       │
       └─ drmModeAtomicCommit(fd, req, DRM_MODE_ATOMIC_NONBLOCK | DRM_MODE_PAGE_FLIP_EVENT, cookie)
            │
            ▼ kernel
            drm_mode_atomic_ioctl()
              └─ drm_atomic_commit()
                   ├─ drm_atomic_check_only()
                   │    ├─ drm_atomic_plane_check()
                   │    │    └─ drm_plane_check_pixel_format()
                   │    │         └─ arise_plane_format_mod_supported(format, modifier)
                   │    │              ├─ LINEAR → 在 plane->modifiers[] 中 → true ✅
                   │    │              └─ TILED  → 不在 plane->modifiers[] 中 → false ❌
                   │    └─ drm_atomic_crtc_check() ...
                   └─ drm_atomic_helper_commit_tail()
                        └─ drm_atomic_helper_commit_planes()
                             └─ 写硬件寄存器
```

### 失败路径 (Compositor Buffer)

```
drmModeAtomicCommit() 失败:
  process_update()
    ├─ 收集失败的 plane assignments → failed_planes list
    ├─ discard_page_flips() — 丢弃所有 page flip
    └─ return feedback_failed(failed_planes, error)
         └─ post_pending_update() → g_warning(...) → 帧丢弃
             // 同样: 无 blit, 无重分配, 无 fallback
```

---

## 路径 3: 新版 Client Buffer Direct Scanout (mutter 42+)

### 调用栈 — 直出检测 (TEST_ONLY)

```
meta_wayland_surface_commit()                            [wayland/meta-wayland-surface.c]
  │
  └─ meta_wayland_surface_try_acquire_scanout(buffer, crtc)
       │                                                 [wayland/meta-wayland-buffer.c]
       │
       ├─ 1. 前置条件检查:
       │    ├─ window is fullscreen?
       │    ├─ no overlay/dialog on top?
       │    ├─ no transform (rotation/mirror)?
       │    ├─ no color management LUT?
       │    └─ buffer has scanout handler? (CoglScanout interface)
       │
       ├─ 2. format 检查:
       │    meta_crtc_kms_supports_format(crtc, drm_format)
       │     │                                          [meta-crtc-kms.c:245]
       │     └─ meta_kms_plane_is_format_supported(primary_plane, format)
       │          └─ g_hash_table_lookup(plane->formats_modifiers, GUINT_TO_POINTER(format))
       │               // 从 kernel IN_FORMATS blob 解析的数据
       │
       ├─ 3. modifier 列表获取:
       │    meta_kms_plane_get_modifiers_for_format(primary_plane, format)
       │     └─ 返回 GArray of uint64_t modifiers (e.g. [DRM_FORMAT_MOD_LINEAR])
       │
       └─ 4. TEST_ONLY atomic 提交:
            cogl_scanout_acquire(buffer, modifiers)       [cogl/cogl-scanout.c]
              └─ meta_drm_buffer_gbm_scanout_acquire()    [meta-drm-buffer-gbm.c]
                   │
                   ├─ import client dma-buf:
                   │    gbm_bo_import(GBM_BO_IMPORT_FD, client_dmabuf_fd)
                   │    meta_gpu_kms_add_fb(gpu, use_modifiers=TRUE)
                   │      └─ drmModeAddFB2WithModifiers(fd, format, modifier=TILED, &fb_id)
                   │
                   └─ meta_kms_impl_device_atomic_process_update()
                        │
                        ├─ 构建 atomic request (fb=client_fb_id)
                        └─ drmModeAtomicCommit(fd, req,
                              DRM_MODE_ATOMIC_TEST_ONLY  ← 关键!!!
                              | DRM_MODE_ATOMIC_NONBLOCK,
                              NULL)
                             │
                             ▼ kernel
                             drm_mode_atomic_ioctl()
                               └─ drm_atomic_commit(TEST_ONLY)
                                    └─ drm_atomic_check_only()
                                         └─ drm_plane_check_pixel_format()
                                              └─ arise_plane_format_mod_supported(fmt, TILED)
                                                   ├─ TILED 在 plane->modifiers[] 中? → false ❌
                                                   └─ TEST_ONLY 失败 → kernel 不真正 flip
```

### 调用栈 — 直出成功 (真正 commit)

```
继续上面 cogl_scanout_acquire() 成功后的渲染主循环:

render()
  │
  ├─ paint_stage()
  │    └─ 如果 scanout_buffer 有效:
  │        跳过 GPU compositing (不合成该全屏窗口)
  │
  └─ cogl_onscreen_swap_buffers_with_damage()
       │
       └─ meta_kms_impl_device_atomic_process_update()
            │
            ├─ 构建 atomic request:
            │    plane_assignment.fb_id = **client_buffer_fb_id**  ← 直接扫 client buffer!
            │    (不是 compositor 的 GBM surface buffer)
            │
            └─ drmModeAtomicCommit(fd, req,
                  DRM_MODE_ATOMIC_NONBLOCK |
                  DRM_MODE_PAGE_FLIP_EVENT,
                  cookie)
                 │
                 ▼ kernel
                 真正 flip → 硬件直接扫描 mpv 的 buffer
                 零 GPU 合成开销
```

### 调用栈 — 直出失败回退 compositing

```
try_acquire_scanout() 返回失败后:

paint_stage()
  │
  ├─ meta_shaped_texture_paint()                         [compositor/meta-shaped-texture.c]
  │    └─ cogl_egl_texture_2d_new_from_image(client_dmabuf)
  │         └─ GPU 将 TILED client buffer 作为纹理采样
  │              └─ shader 渲染到 compositor 的 framebuffer (LINEAR gbm_surface)
  │
  └─ cogl_onscreen_swap_buffers_with_damage()
       └─ meta_drm_buffer_gbm_new(surface, use_modifiers=TRUE)
            └─ modifier = LINEAR
            └─ drmModeAtomicCommit(fd, compositor_fb, ...)  ← flip compositor 的 LINEAR buffer
```

### 失败处理对比

| 场景                                        | TEST_ONLY 结果 | 实际行为                                    |
| ------------------------------------------- | -------------- | ------------------------------------------- |
| Client buffer TILED, plane 只支持 LINEAR    | ❌ 失败        | compositing 合成到 compositor FB            |
| Client buffer LINEAR, plane 支持 LINEAR     | ✅ 通过        | drmModeAtomicCommit 真正直出                |
| TEST_ONLY 通过但实际 commit 失败 (MR !2854) | ✅→❌          | 异步标记 buffer 无效, 下帧 full damage 回退 |
| `zwp_linux_dmabuf_feedback_v1` 通知 client  | —              | client 重建 LINEAR buffer, 下次直出通过     |

---

## `zwp_linux_dmabuf_feedback_v1` 协议流程

```
Compositor (mutter)                          Client (mpv/video player)
     │                                                │
     │  bind zwp_linux_dmabuf_feedback_v1             │
     │  ═══════════════════════════════════            │
     │  main_device: /dev/dri/card0                    │
     │                                                │
     │  tranche: render (device=cpu)                   │
     │    {XRGB8888, [TILED, LINEAR, COMPRESS]}       │  ← 渲染用的 modifiers
     │                                                │
     │  tranche: scanout (device=/dev/dri/card0)       │
     │    {XRGB8888, [LINEAR]}                         │  ← 直出用的 modifiers
     │    {XBGR8888, [LINEAR]}                         │
     │────────────────────────────────────────────────>│
     │                                                │
     │                                     mpv 全屏时检查 scanout tranche:
     │                                     重新分配 buffer (
     │                                       format=XRGB8888,
     │                                       modifier=LINEAR)
     │                                     重新渲染到新 buffer
     │                                                │
     │  wl_surface.attach(linear_buffer)              │
     │<────────────────────────────────────────────────│
     │                                                │
     │  TEST_ONLY → 通过                              │
     │  drmModeAtomicCommit → 直出                     │
```

---

## Kernel 侧: 你的驱动 (arise2_drm_kmd) 的 Check Chain

### `drmModePageFlip` (legacy, 但驱动内部转 atomic)

```
drmModePageFlip(fd, crtc_id, fb_id, DRM_MODE_PAGE_FLIP_EVENT, data)
  │
  ▼ kernel
  drm_mode_page_flip_ioctl()
    └─ crtc->funcs->page_flip() = drm_atomic_helper_page_flip()  [arise_crtc.c:449]
         └─ drm_atomic_state_alloc()
         └─ 设置 plane state (fb_id, crtc, src/dst)
         └─ drm_atomic_commit()
              ├─ drm_atomic_check_only()
              │    └─ drm_atomic_plane_check()
              │         ├─ arise_plane_atomic_check()              [arise_plane.c:297]
              │         │    └─ 只检查: src/dst 尺寸约束, 缩放能力
              │         │       ⚠️ 不检查 format/modifier!
              │         └─ drm_plane_check_pixel_format()          [DRM core]
              │              └─ arise_plane_format_mod_supported() [arise_plane.c:571]
              │                   │
              │                   ├─ DRM_FORMAT_MOD_NONE        → true (Bug!)
              │                   ├─ DRM_FORMAT_MOD_ARISE_*     → true (Bug!)
              │                   └─ 查 plane->modifiers[] = {LINEAR, INVALID}
              │                        ├─ LINEAR → true  ✅
              │                        ├─ INVALID → true ✅
              │                        └─ 其他   → false ❌
              └─ drm_atomic_helper_commit_tail()
                   └─ arise_atomic_helper_commit_tail()           [arise_atomic.c:109]
```

### `drmModeAtomicCommit`

```
drmModeAtomicCommit(fd, req, flags, cookie)
  │
  ▼ kernel
  drm_mode_atomic_ioctl()
    └─ drm_atomic_commit(state, flags)
         └─ config->funcs->atomic_commit() = drm_atomic_helper_commit()  [arise_disp.c:44]
              ├─ drm_atomic_helper_check() = drm_atomic_helper_check()    [arise_disp.c:43]
              │    ├─ CRTC:  arise_crtc_helper_check()
              │    ├─ Plane: drm_atomic_plane_check()
              │    │    └─ (同上, 走相同的 arise_plane_format_mod_supported)
              │    └─ Connector: drm_atomic_helper_check_modeset()
              │
              └─ drm_atomic_helper_commit_tail() = arise_atomic_helper_commit_tail()
                                                                          [arise_disp.c:52]
                   ├─ drm_atomic_helper_commit_modeset_disables()
                   ├─ drm_atomic_helper_commit_modeset_enables()
                   ├─ drm_atomic_helper_commit_planes()
                   │    └─ arise_plane_atomic_update()  → 写硬件寄存器
                   ├─ drm_atomic_helper_commit_hw_done()
                   └─ drm_atomic_helper_wait_for_flip_done()
```

### `arise_plane_format_mod_supported` 的两个 Bug

```c
// arise_plane.c:571-612
static bool arise_plane_format_mod_supported(struct drm_plane *plane,
                                              uint32_t format, uint64_t modifier)
{
    switch(modifier) {
    case DRM_FORMAT_MOD_NONE:              // = 0, mutter drmModeAddFB2 不带 modifier 时
    case DRM_FORMAT_MOD_ARISE_DISPLAY:     // 自定义 tiled modifier
    case DRM_FORMAT_MOD_ARISE_COMPRESS:    // 压缩 modifier
    case DRM_FORMAT_MOD_ARISE_POOL_LOCAL:
    case DRM_FORMAT_MOD_ARISE_POOL_NONLOCAL:
    case DRM_FORMAT_MOD_ARISE_CACHABLE:
    case DRM_FORMAT_MOD_ARISE_UNCACHABLE:
        ret = true;                        // ← Bug: 无硬件能力检查直接返回 true
        goto check_done;

    // plane 只广告了 LINEAR + INVALID:
    // static uint64_t chx_modifiers[] = {DRM_FORMAT_MOD_LINEAR, DRM_FORMAT_MOD_INVALID};
    }
    // 后面的查表逻辑 (plane->modifiers[]) 只有非 vendor modifier 才能走到
}
```

---

## 总结: 你的场景的修复建议

```
环境: mutter 3.36 + 老 kernel + 自定义 GPU 驱动 (scanout 只支持 LINEAR)

问题链:
  GBM surface 创建 (GBM_BO_USE_SCANOUT, 无 LINEAR 强制)
    → GBM 驱动 (PIPE_BIND_SCANOUT 已移除) → 分配 TILED buffer
    → drmModeAddFB2(无 modifier) → kernel FB: modifier=DRM_FORMAT_MOD_NONE
    → drmModePageFlip()
    → kernel: drm_atomic_helper_page_flip() → arise_plane_format_mod_supported(NONE) → true
    → flip "成功" 但硬件 scanout 花屏

修复 (二选一或多选):

  方案 A — mutter (一行 patch):
    meta-renderer-native.c:2340:
      加 GBM_BO_USE_LINEAR 到 GBM surface flags
    ✅ 最简单, 从源头保证 buffer 是 LINEAR

  方案 B — kernel 驱动:
    arise_plane.c:578:
      DRM_FORMAT_MOD_NONE 不直接返回 true
      改为检查是否在 plane->modifiers[] 列表中
    ⚠️ 但只修这个会导致每帧 flip 失败(帧丢弃), 需配合方案 A

  方案 C — mesa 驱动:
    恢复 PIPE_BIND_SCANOUT 对 GBM_BO_USE_SCANOUT 的响应
    或在 GBM_BO_USE_LINEAR 时强制分配 LINEAR buffer
```

---

## DRIVER_ATOMIC 与 KMS 实现选择 (mutter 40+)

### 决策入口: `meta_create_kms_impl_device()`

```c
// meta-kms-device.c:365-420
static MetaKmsImplDevice *
meta_create_kms_impl_device (MetaKmsDevice *device, MetaKmsImpl *impl,
                              const char *path, MetaKmsDeviceFlag flags,
                              GError **error)
{
    GType impl_device_types[] = {
        META_TYPE_KMS_IMPL_DEVICE_ATOMIC,   // 先试 atomic
        META_TYPE_KMS_IMPL_DEVICE_SIMPLE,   // 失败则试 simple
    };

    for (i = 0; i < G_N_ELEMENTS (impl_device_types); i++) {
        impl_device = g_initable_new (impl_device_types[i], ...);
        //                   ↑ 调用 GInitable 接口的 init() 函数

        if (impl_device)
            return impl_device;  // 第一个成功的实现

        // 失败 → 继续尝试下一个
    }

    g_set_error (error, ..., "No suitable mode setting backend found");
    return NULL;
}
```

### Atomic 实现初始化: 检查 `DRM_CLIENT_CAP_ATOMIC`

```c
// meta-kms-impl-device-atomic.c:1204-1237
static gboolean
meta_kms_impl_device_atomic_initable_init (GInitable *initable, ...)
{
    // 1. 检查环境变量 MUTTER_DEBUG_ENABLE_ATOMIC_KMS
    if (env == "0")
        return FALSE;  // 用户禁用

    // 2. 调用父类 init (打开 DRM fd 等)
    if (!initable_parent_iface->init (initable, ...))
        return FALSE;

    // 3. 检查 driver deny list (qxl/vmwgfx/vboxvideo/nvidia-drm/virtio_gpu/xlnx)
    if (!is_atomic_allowed (driver_name))
        return FALSE;

    // 4. 初始化 mode setting → 在里面调用:
    //    meta_kms_impl_device_init_mode_setting()
    ────────────────────────────────────────────────────
    // meta-kms-impl-device-atomic.c:1172-1174
    static MetaDeviceFile *
    ensure_device_file_for_atomic (...)
    {
        fd = meta_device_file_get_fd (device_file);

        if (drmSetClientCap (fd, DRM_CLIENT_CAP_ATOMIC, 1) != 0)
        {
            g_set_error (error, META_KMS_ERROR, META_KMS_ERROR_NOT_SUPPORTED,
                         "DRM_CLIENT_CAP_ATOMIC not supported");
            return NULL;  // ← 这里返回 NULL → init 失败 → 退回 simple
        }
    }
    ────────────────────────────────────────────────────

    return TRUE;  // atomic 初始化成功
}
```

### `DRM_CLIENT_CAP_ATOMIC` 成功的条件

```
drmSetClientCap(fd, DRM_CLIENT_CAP_ATOMIC, 1) 成功:
  │
  ▼ kernel
  drm_setclientcap()
    └─ case DRM_CLIENT_CAP_ATOMIC:
         if (dev->driver->driver_features & DRIVER_ATOMIC)    ← kernel 检查!
              file_priv->atomic = 1;  // 成功
         else
              return -EOPNOTSUPP;      // 失败
```

**所以**:

- kernel 驱动设置 `DRIVER_ATOMIC` → `drmSetClientCap(ATOMIC)` 成功 → `META_TYPE_KMS_IMPL_DEVICE_ATOMIC` init 成功 → 使用 atomic 路径
- kernel 驱动**没有** `DRIVER_ATOMIC` → `drmSetClientCap(ATOMIC)` 返回 `-EOPNOTSUPP` → init 返回 FALSE → `meta_create_kms_impl_device()` 继续尝试下一个 → `META_TYPE_KMS_IMPL_DEVICE_SIMPLE` init 成功 → 使用 simple 路径

### 两种实现的 `process_update` 对比

```
         ┌─ meta_kms_impl_device_process_update()
         │         (flags 包含 META_KMS_UPDATE_FLAG_TEST_ONLY)
         │
         └─ klass->process_update(impl_device, update, flags)
              │
      ┌───────┴──────────────────────────────────┐
      │                                          │
  [Atomic]                                  [Simple]
  meta-kms-impl-device-atomic.c:908         meta-kms-impl-device-simple.c:1467
      │                                          │
      │  if (TEST_ONLY)                           │  if (TEST_ONLY)
      │    commit_flags |=                        │    return perform_update_test()
      │      DRM_MODE_ATOMIC_TEST_ONLY;           │         │
      │                                          │    ┌────┘
      │  drmModeAtomicCommit(fd, req,            │    │
      │    commit_flags, impl_device)             │    ▼
      │      │                                   │    for each plane_assignment:
      │      ▼ kernel                            │      buffer->width    vs cached->width
      │  drm_atomic_plane_check()                │      buffer->height   vs cached->height
      │    └─ drm_plane_check_pixel_format()     │      buffer->stride   vs cached->stride
      │         └─ format_mod_supported()        │      buffer->format   vs cached->format
      │              ↑                           │      buffer->modifier vs cached->modifier
      │         kernel 驱动回调                   │           ↑
      │                                          │      mismatched → FAIL
      │  成功: feedback_passed                   │      all pass   → PASS
      │  失败: feedback_failed                   │
```

### 无 `DRIVER_ATOMIC` 时 direct scanout 完整流程

```
meta_wayland_surface_commit()
  └─ meta_wayland_buffer_try_acquire_scanout()
       │
       ├─ gbm_bo_import(client_buffer, GBM_BO_USE_SCANOUT)
       ├─ meta_drm_buffer_gbm_new_take(bo, flags)
       │
       └─ meta_onscreen_native_is_buffer_scanout_compatible(onscreen, fb)
            │                                   [meta-onscreen-native.c:1223]
            │
            ├─ meta_crtc_kms_assign_primary_plane(crtc, fb, test_update)
            │
            └─ meta_kms_post_test_update_sync(kms, test_update)
                 │                              [meta-kms.c:309]
                 │
                 └─ meta_kms_device_process_update_sync(device, update, TEST_ONLY)
                      │                         [meta-kms-device.c:305]
                      │
                      └─ meta_kms_impl_device_process_update()
                           │                   [meta-kms-impl-device.c:812]
                           │
                           └─ [Simple path] process_update(TEST_ONLY)
                                │              [meta-kms-impl-device-simple.c:1478]
                                │
                                └─ perform_update_test()     [line 1402]
                                     │
                                     └─ 逐项对比 client buffer vs CachedModeSet:
                                          format   != cached->format?   → FAIL
                                          modifier != cached->modifier? → FAIL
                                          width    != cached->width?    → FAIL
                                          height   != cached->height?   → FAIL
                                          stride   != cached->stride?   → FAIL
                                          全部通过 → feedback_passed → scanout 可用
```

### `CachedModeSet` 的来源

```c
// meta-kms-impl-device-simple.c:40-50
typedef struct _CachedModeSet {
    GList *connectors;
    drmModeModeInfo *drm_mode;
    int width;
    int height;
    int stride;
    uint32_t format;
    uint64_t modifier;    // ← compositor 自己的 buffer modifier
} CachedModeSet;

// 首次 mode set 时填入 (meta-kms-impl-device-simple.c:473-479):
// drmModeSetCrtc 成功后:
cached_mode_set_new (mode_set->connectors, drm_mode, buffer)
    .width    = meta_drm_buffer_get_width(buffer),    // compositor gbm surface
    .height   = meta_drm_buffer_get_height(buffer),
    .stride   = meta_drm_buffer_get_stride(buffer),
    .format   = meta_drm_buffer_get_format(buffer),   // e.g. XRGB8888
    .modifier = meta_drm_buffer_get_modifier(buffer); // e.g. LINEAR
```

### 结论

```
┌────────────────────────────────────────────────────────────────────────┐
│                    DRIVER_ATOMIC 的作用总结                              │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  kernel 有 DRIVER_ATOMIC:                                              │
│    → mutter 用 META_TYPE_KMS_IMPL_DEVICE_ATOMIC                        │
│    → process_update(TEST_ONLY) → drmModeAtomicCommit(TEST_ONLY)        │
│    → kernel 走 drm_atomic_plane_check() → format_mod_supported()       │
│    → 在 kernel 侧验证 format+modifier 兼容性                            │
│                                                                        │
│  kernel 没有 DRIVER_ATOMIC:                                            │
│    → mutter 用 META_TYPE_KMS_IMPL_DEVICE_SIMPLE                        │
│    → process_update(TEST_ONLY) → perform_update_test()                 │
│    → 在用户态逐项对比 client buffer vs compositor 自己的 buffer         │
│    → 靠 CachedModeSet 中存的 compositor buffer 参数做"金标准"          │
│                                                                        │
│  无论哪种路径，只要 compositor 的 gbm surface 是 LINEAR 的，tiled       │
│  client buffer 的 direct scanout 都会被拒绝。区别只是 rejected by:      │
│    - kernel atomic check (format_mod_supported)                        │
│    - 或 mutter perform_update_test (modifier mismatch)                 │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```
