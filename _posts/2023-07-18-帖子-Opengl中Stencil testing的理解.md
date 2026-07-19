---
title: "Opengl中Stencil testing的理解"
last_modified_at: 2023-07-18
classes: wide
categories:
    - 帖子
tags:
    - OPENGL
    - GRAPHICS
toc: true
toc_sticky: true
---

在LearnOpenGL中，Stencil testing的部分，但是我在看的时候，发现有那三个函数不是很理解，所以就在这里记录一下。

## 1. Stencil buffer

这一部分很简单，就是一个buffer，用来存储模板值，这个值可以在绘制的时候被修改，然后在绘制的时候，可以根据这个值来决定是否绘制。通常是1绘制，0不绘制。

## 2. glStencilFunc

这个函数是用来设置模板测试的，也就是说，我们可以设置一个模板值，然后在绘制的时候，根据这个模板值来决定是否绘制。

`glStencilFunc(GL_EQUAL, 1, 0xFF)`

这个函数的第一个参数是模板测试的条件，第二个参数是模板值ref，第三个参数是模板掩码，也就是说，我们可以通过掩码来决定哪些位是参与模板测试的，哪些位不参与模板测试。通常都通过模板测试、或都不模板测试。如果没有这个函数，默认是`glStencilFunc(GL_ALWAYS, 1, 0xFF)`，也就是说，所有的片段都会通过模板测试。

## 3. glStencilOp

这个函数是最难理解的，其实就是根据测试结果更新模板参数的值。具体的行为包括:GL_KEEP, GL_ZERO, GL_REPLACE, GL_INCR, GL_INCR_WRAP, GL_DECR, GL_DECR_WRAP, GL_INVERT。这些行为的意思可以参考[这里](https://www.khronos.org/registry/OpenGL-Refpages/gl4/html/glStencilOp.xhtml)。最常用的是未通过测试设置缓冲区点为0，通过测试设置缓冲区点为1。

## 4. glStencilMask

这个函数是用来设置模板缓冲区是否可以写入的，如果设置为false(0x00)，那么就不会写入模板缓冲区。其实就是与glStencilOp(GL_KEEP, GL_KEEP, GL_KEEP)返回的结果相与，决定是否更新模板缓冲区。


>重点是模板缓冲区的值默认是1，如果没有设置glStencilFunc，那么所有的片段都会通过模板测试，然后根据glStencilOp的设置更新模板缓冲区的值。如果设置了glStencilFunc，那么根据glStencilFunc的设置，决定是否通过模板测试，然后根据glStencilOp的设置更新模板缓冲区的值。可以点击链接进入learnopengl的教程，里面有详细的解释。[Stencil testing](https://learnopengl.com/Advanced-OpenGL/Stencil-testing)
