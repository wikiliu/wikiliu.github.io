
modifers 的更新 
drm_universal_plane_init 对应init_kms_caps config->allow_fb_modifiers = true
->drm_object_attach_property ->create_in_format_blob 
->drm_object_attach_property(&plane->base, config->modifiers_property,blob->base.id) 第二个参数是给定的对应的 你想添加哪个就传哪个这个 property name = "IN_FORMATS"
s
所以对应关系是 例如 primary_plane 自带 property 最后把 blob绑到plane上

