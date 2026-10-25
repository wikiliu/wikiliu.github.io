import os
import re

target_dir = r"d:\Github\wikiliu.github.io\_posts"

def clean_html(text):
    # Convert <strong> to **
    text = re.sub(r'<strong>\s*', '**', text)
    text = re.sub(r'\s*</strong>', '**', text)
    
    # Convert <kbd> to `
    text = re.sub(r'<kbd>\s*', '`', text)
    text = re.sub(r'\s*</kbd>', '`', text)
    
    # Strip span tags (e.g. <span class="has-inline-color has-vivid-red-color">)
    text = re.sub(r'<span[^>]*>', '', text)
    text = re.sub(r'</span>', '', text)
    
    return text

def process_frontmatter_safe(content):
    if not content.startswith("---"):
        return content
        
    parts = content.split("---", 2)
    if len(parts) < 3:
        return content
        
    frontmatter = parts[1]
    body = parts[2]
    
    # Add classes: wide if not exists
    if 'classes:' not in frontmatter:
        frontmatter += "classes: wide\n"
    
    # Add toc: true if not exists
    if 'toc:' not in frontmatter:
        frontmatter += "toc: true\n"
        
    if 'toc_sticky:' not in frontmatter:
        frontmatter += "toc_sticky: true\n"
        
    return f"---{frontmatter}---{body}"

for filename in os.listdir(target_dir):
    if not filename.endswith(".md"):
        continue
        
    filepath = os.path.join(target_dir, filename)
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
        
    # Clean HTML
    new_content = clean_html(content)
    
    # Standardize Frontmatter
    new_content = process_frontmatter_safe(new_content)
    
    if content != new_content:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(new_content)
        print(f"Updated: {filename}")
