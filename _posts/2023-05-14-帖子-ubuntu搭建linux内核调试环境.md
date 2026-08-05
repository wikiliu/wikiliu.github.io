---
title: "帖子: Ubuntu搭建Linux 2.6.24内核调试环境"
last_modified_at: 2023-05-14
classes: wide
categories:
    - 收藏
tags:
    - 收藏
    - 代码
    - LINUX
toc: true
toc_sticky: true
---


最近在读《深入Linux内核架构》，搭建了一下Linux 2.6.24的内核调试环境。由于该内核较老，目前找不到任何还在维护的发行版，所以采用qemu运行32位的内核。


## 基础环境

>*虚拟机镜像：ubuntu-14.04.6-desktop-amd64.iso

>*gcc版本：4.4 “sudo apt install gcc-4.4”

>*都在root环境下执行，能省去不少麻烦 “su”

## 安装插件

```
apt-get install -y libncurses5-dev build-essential
apt-get install -y lib32readline-gplv2-dev # 编译32位系统
apt-get install -y wget vim gdb
apt-get install -y qemu-system
```

## 编译内核`（gcc4.4环境下非常简单，不需要更改源文件）`

```
wget --no-check-certificate https://mirror.bjtu.edu.cn/kernel/linux/kernel/v2.6/linux-2.6.24.tar.xz
tar xvJf linux-2.6.24.tar.xz
cd linux-2.6.24
make ARCH=i386 defconfig
make ARCH=i386 menuconfig
# 选择以下编译选项，使用空格键选择。然后退出
<span class="has-inline-color has-light-green-cyan-color">Kernel hacking  --->
    [*] Compile the kernel with debug info
    [*] KGDB: kernel debugging with remote gdb  ---> </span>
make ARCH=i386 -j4
#可能会出现寄存器错误 用vim打开报错文件在命令模式下输入
<span class="has-inline-color has-pale-cyan-blue-color">%s/"=r"/"=q"g</span>
```

## 制作文件系统`（使用busybox制作32位根文件系统）`

```
# 1. <strong>就在linux-2.6.24目录下下载busybox</strong>
wget --no-check-certificate https://busybox.net/downloads/busybox-1.21.1.tar.bz2
tar jxvf busybox-1.21.1.tar.bz2
cd busybox-1.21.1

<strong><span class="has-inline-color has-vivid-red-color"># 2. 修改Makefile，在292行最后加上-m32</span></strong>  非常重要 64位会报错

vim Makefile
<span class="has-inline-color has-pale-cyan-blue-color">CC = $(CROSS_COMPILE)gcc -m32</span>

# 3. 设置busybox编译选项。注意使用静态链接，关闭Job Control
make defconfig
make menuconfig
<span class="has-inline-color has-light-green-cyan-color">Busybox Settings  --->
      Build Options  --->
            [*] Build BusyBox as a static binary (no shared libs)
Shells  --->
      [ ]   Job control  </span>

# 4. 制作initrd.img   先回到上一级目录

cd ..
dd if=/dev/zero of=initrd.img count=1024 bs=4096
mkfs.ext2 initrd.img
mkdir rootfs
mount -o loop initrd.img rootfs

# 5. 编译busybox
cd busybox-1.21.1
make -j4
make CONFIG_PREFIX=/rootfs install

# 6. 安装完成，补充一些必要的文件和目录
cd /rootfs
mkdir etc proc dev home mnt tmp sys
mkdir etc/init.d

cat > etc/fstab << EOF
proc        /proc           proc         defaults        0        0
tmpfs       /tmp            tmpfs        defaults        0        0
none        /tmp            ramfs        defaults        0        0
sysfs       /sys            sysfs        defaults        0        0
EOF

cat > etc/init.d/rcS << EOF
#!/bin/sh
/bin/mount -a
mount -o remount,rw /
mkdir -p /dev/pts
mount -t devpts devpts /dev/pts
EOF

cat > etc/inittab << EOF
::sysinit:/etc/init.d/rcS
::respawn:-/bin/sh
::askfirst:-/bin/sh
::ctrlaltdel:/bin/umount -a -r
EOF

cd dev
mknod null c 1 3
mknod console c 5 1
mknod ram b 1 0

# 7. 卸载rootfs
cd ..
chmod -R 777 rootfs/
umount ./rootfs
```

## 启动内核

```
qemu-system-x86_64 -kernel ./arch/x86/boot/bzImage -initrd ./initrd.img -append "root=/dev/ram"
当然，也可以使用
<kbd>-nographi</kbd>c参数，在tty0启动内核
qemu-system-x86_64 -kernel ./arch/x86/boot/bzImage -initrd ./initrd.img -append "root=/dev/ram console=ttyS0" -nographic
```

>这篇文章参考<https://juejin.cn/post/7160349299401277476>，但是在gcc版本上做了修改，避免了对改源码。另外，这个文件目录是我唯一成功的一次，源码文件夹下保存着rootrf
