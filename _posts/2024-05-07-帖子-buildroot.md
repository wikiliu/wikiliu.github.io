---
title: "Buildroot intro"
date: 2024-05-07T15:47:30-04:00
classes: wide
categories:
  - 收藏
tags:
  - LINUX
  - EMBEDDED
---

buildroot可以编一个精简操作系统或者交叉编译binary

详细文档见[bootlin](httpsi://bootlin.com/doc/training/buildroot/buildroot-slides.pdf)

## 系统结构

一个最小系统应该包括 bootloader kernel rootfs toolchain

rootfs除了文件系统还有工具包，例如busybox

## 文件目录

buildroot file tree：

1. arch 架构依赖
2. toolchain 交叉编译工具
3. system rootfs框架skeleton
4. linux kenrel
5. package user-space 包，应该是放在target里面的
6. boot bootloader工具包，uboot grub etc
7. configs 常用配置
8. board 补丁，板子依赖

output file tree：

1. build 拷贝的解码的源码文件目录
2. host 当前主机需要的tool和交叉编译的依赖（头文件 包）
3. target 要打在生成精简操作系统的文件系统
4. image 最终生成 包括.dtb--boot zImage--kernel rootfs.tar rootfs.ubi (格式不一样而已)


## 库的功能

* libbsd.so 提供了对一些常见的网络、文件系统和系统功能的访问，这些功能可能在标准 C 库中不易使用或不可用
* libXdmcp.so X Window 系统中用于远程登录和显示管理的协议
* libXau.so 控制用户如何访问 X 服务器，以确保安全性和权限管理
* libxshmfence.so 用于同步共享内存访问的机制
* libxcb.so 用于与 X 服务器进行底层通信，以实现图形显示和用户交互
* librt.so 表明这个库主要用于支持实时操作系统的特性
