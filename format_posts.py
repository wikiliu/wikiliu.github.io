import os
import datetime

target_dir = r"d:\Github\wikiliu.github.io\_posts"

files_to_process = [
    "gpu_page_table_guide.md",
    "mutter_scanout_analysis.md",
    "novnc + vncserver实现浏览器访问远程桌面.md",
    "rm避免删除git目录.md",
    "spin_lock在gpu-driver的使用.md",
    "window商店联网.md"
]

for filename in files_to_process:
    filepath = os.path.join(target_dir, filename)
    if not os.path.exists(filepath):
        print(f"Skipping {filename}, not found.")
        continue
    
    mtime = os.path.getmtime(filepath)
    dt = datetime.datetime.fromtimestamp(mtime)
    
    date_str = dt.strftime("%Y-%m-%d")
    # Local time is +09:00 based on context, but let's just use a simple time formatting
    # The prompt timezone says 2026-08-05T12:17:54+09:00
    frontmatter_date = dt.strftime("%Y-%m-%dT%H:%M:%S+09:00")
    
    title = filename[:-3]
    
    frontmatter = f"""---
title: "{title}"
date: {frontmatter_date}
classes: wide
categories:
  - 帖子
tags:
  - 帖子
---

"""
    
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    if not content.startswith("---"):
        content = frontmatter + content
    
    # Ensure title is safely encoded if needed, but since we use utf-8 it's fine.
    # Also handle some edge cases if the filename already has 帖子 etc.
    new_filename = f"{date_str}-帖子-{title}.md"
    new_filepath = os.path.join(target_dir, new_filename)
    
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
        
    os.rename(filepath, new_filepath)
    print(f"Processed: {filename} -> {new_filename}")
