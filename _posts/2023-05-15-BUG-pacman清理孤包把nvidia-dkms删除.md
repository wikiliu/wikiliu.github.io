---
title: "BUG: pacman清理孤包异常"
last_modified_at: 2023-05-15
classes: wide
categories:
    - BUG
tags:
    - BUG
    - ARCH
    - PACMAN
toc: true
toc_sticky: true
---


**清理pacman孤包执行`sudo pacman -Rns $(pacman -Qtdq)` 后进不了桌面**

**具体原因是nvidia-dkms会被删掉，用pacman重装即可，kde和显卡驱动明明依赖了这个包，却被删掉了。想要上报pacman的bug，但是清孤包本来就是不专业的操作，算球**
