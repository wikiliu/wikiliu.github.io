# Linux 图形驱动 / 系统软件代码开发 Prompt 模板（短版）

你是资深 Linux GPU Driver / Mesa / Kernel 工程师。

## 任务

有两个地方可以调频率，一个是pmu一个是ccp，现在想在arise_clk.c中引入ccp的调频，仍然用sysfs中调频的接口，当发现dvfs_mode为0时就走ccp来调，调频的表仍然用dvfs_table_default

## 背景

http://gerrit.glenfly.com/c/zhaoxin/sw/Arise2/soc/toolchains/+/118758：这个change是通过mmio直接读写的方式设置clk值，现在想通过driver来做，可以用这个change拿到ccp的地址，然后把table中的值写进去，当然暂时只考虑clk而不管voltage，这个change有很多定义的规则，你可以了解但可能用不到，git fetch "ssh://rickliu@gerrit.glenfly.com:29418/zhaoxin/sw/Arise2/soc/toolchains" refs/changes/58/118758/5 && git format-patch -1 --stdout FETCH_HEAD 命令可以直接拿,重点关注gpu_freq/set_gpu_pll.sh文件的configure_pll函数

https://jira.glenfly.com/browse/ARISE2-19999 包含arise2 linux kmd 支持对某些不支持dvfs的模块来实现频率调整 你不用下载这个网页，没实质性内容
当前ccp和pmu调频的方式类似，都是设置P M S还有divider几个值，具体的行为可以看http://gerrit.glenfly.com/c/zhaoxin/sw/Arise2/soc/toolchains/+/118758

## 代码

arise_pmu.c/arise_sysfs.c/arise_clk.c这三个文件，主要在arise_clk.c文件中加，作为arise_clk_funcs的新函数叫做 arise_ccp_adjust_clk_command_mode
sysfs中或者pmu中仅对DVFS_COMMAND_MODE_ONLY_CLK走ccp，其他的mode先不管(之后会有计划加如voltage的调节 加一个todo)

## 期望

能用ccp单独控制clk，验证方式为http://gerrit.glenfly.com/c/internal/sw/gfx_drv/+/118351中的arise_gcu.c改动的函数，也可以用git fetch "ssh://rickliu@gerrit.glenfly.com:29418/internal/sw/gfx_drv" refs/changes/51/118351/1 && git format-patch -1 --stdout FETCH_HEAD，测试函数不用进去，但应该可以通过sysfs实现by ccp的clock调整，并基于验证方式打印table中对应的clk值，例如300 400 500Mhz，测试函数可以先保留，不用提交代码仓库
代码和函数风格符合clk.c pmu.c的风格，保持一致性

## 限制

除非必要，不要添加注释，尽量用接口函数而不是external函数

---

## 请完成以下工作

1. 先分析当前代码和数据流。
2. 判断最合理的修改位置。
3. 给最小化、可 review 的实际 diff，不要无关重构。
4. 解释关键代码为什么这么写，不要只解释语法。
5. 给可直接执行的测试方法。
6. 最后以 reviewer 角度指出 patch 最大风险。
