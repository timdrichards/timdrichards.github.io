#!/usr/bin/env python3
"""
Markdown to HTML converter for Tim Richards' website.
Converts markdown files to HTML with the custom theme styling.
"""

import re
import sys
from pathlib import Path
from typing import Dict, Optional


def parse_frontmatter(content: str) -> tuple[Dict[str, str], str]:
    """Extract YAML frontmatter from markdown content."""
    frontmatter = {}
    body = content
    
    if content.startswith('---\n'):
        parts = content.split('---\n', 2)
        if len(parts) >= 3:
            frontmatter_text = parts[1]
            body = parts[2]
            
            for line in frontmatter_text.strip().split('\n'):
                if ':' in line:
                    key, value = line.split(':', 1)
                    frontmatter[key.strip()] = value.strip()
    
    return frontmatter, body


def process_attributes(line: str) -> tuple[str, Optional[str]]:
    """Extract and process attribute syntax {: .class}."""
    attr_pattern = r'\{:\s*\.([^}]+)\}'
    match = re.search(attr_pattern, line)
    
    if match:
        class_name = match.group(1)
        line = re.sub(attr_pattern, '', line).strip()
        return line, class_name
    
    return line, None


def convert_markdown_to_html(md_content: str) -> str:
    """Convert markdown content to HTML with custom styling."""
    frontmatter, body = parse_frontmatter(md_content)
    
    lines = body.strip().split('\n')
    html_lines = []
    in_list = False
    list_items = []
    
    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        
        # Skip empty lines outside of lists
        if not line and not in_list:
            i += 1
            continue
        
        # Check for attribute on next line
        next_line_attr = None
        if i + 1 < len(lines):
            next_line = lines[i + 1].strip()
            if next_line.startswith('{:'):
                _, next_line_attr = process_attributes(next_line)
                i += 1  # Skip the attribute line
        
        # Handle headings
        if line.startswith('# '):
            text = line[2:].strip()
            if frontmatter.get('subtitle'):
                html_lines.append(f'<h1>{text}</h1>')
                html_lines.append(f'<div class="semester">{frontmatter["subtitle"]}</div>')
            else:
                html_lines.append(f'<h1>{text}</h1>')
        
        elif line.startswith('## '):
            text = line[3:].strip()
            html_lines.append(f'<div class="section-title">{text}</div>')
            html_lines.append('<div class="description" style="text-align: center">')
        
        # Handle dividers
        elif line.startswith('<div class="divider">'):
            html_lines.append(line)
        
        # Handle blockquotes (status boxes)
        elif line.startswith('> '):
            text = line[2:].strip()
            if next_line_attr == 'status':
                html_lines.append(f'<div class="status">{text}</div>')
            else:
                html_lines.append(f'<blockquote>{text}</blockquote>')
        
        # Handle lists
        elif line.startswith('- '):
            if not in_list:
                in_list = True
                list_items = []
            
            # Process list item
            item_text = line[2:].strip()
            
            # Convert markdown links to HTML
            link_pattern = r'\[([^\]]+)\]\(([^)]+)\)'
            item_html = re.sub(
                link_pattern,
                r'<a href="\2" style="color: #8fbc8f; text-decoration: none; border-bottom: 1px solid rgba(143, 188, 143, 0.3);">\1</a>',
                item_text
            )
            
            list_items.append(f'''          <li
            style="
              margin-bottom: 0.75rem;
              padding-left: 1.5rem;
              position: relative;
            "
          >
            <span style="position: absolute; left: 0; color: #8fbc8f">▸</span>
            {item_html}
          </li>''')
        
        # Handle links with special classes
        elif line.startswith('[') and '(' in line:
            link_pattern = r'\[([^\]]+)\]\(([^)]+)\)'
            match = re.search(link_pattern, line)
            
            if match and next_line_attr == 'centered-link':
                text, url = match.groups()
                html_lines.append(f'''        <p style="text-align: center; margin-bottom: 1.5rem">
          <a
            href="{url}"
            style="
              color: #8fbc8f;
              text-decoration: none;
              border-bottom: 1px solid rgba(143, 188, 143, 0.3);
              transition: all 0.3s;
            "
          >
            {text}
          </a>
        </p>''')
            
            elif match and next_line_attr == 'course-button':
                text, url = match.groups()
                html_lines.append(f'''        <p style="margin-bottom: 1rem">
          <a
            href="{url}"
            style="
              color: #8fbc8f;
              text-decoration: none;
              font-size: 1.1rem;
              border: 2px solid rgba(143, 188, 143, 0.3);
              padding: 0.75rem 1.5rem;
              border-radius: 8px;
              display: inline-block;
              transition: all 0.3s;
              background: rgba(143, 188, 143, 0.05);
            "
          >
            {text}
          </a>
        </p>''')
            else:
                # Regular link
                html = re.sub(
                    link_pattern,
                    r'<a href="\2" style="color: #8fbc8f; text-decoration: none; border-bottom: 1px solid rgba(143, 188, 143, 0.3);">\1</a>',
                    line
                )
                html_lines.append(f'<p>{html}</p>')
        
        # Handle regular paragraphs
        elif line and not line.startswith('{:'):
            # Convert markdown bold
            line = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', line)
            html_lines.append(f'<p>{line}</p>')
        
        # Check if we've ended a list
        if in_list and (i + 1 >= len(lines) or not lines[i + 1].startswith('- ')):
            # Close the list
            html_lines.append('        <ul style="list-style: none; padding: 0; text-align: left">')
            html_lines.extend(list_items)
            html_lines.append('        </ul>')
            html_lines.append('      </div>')  # Close description
            in_list = False
            list_items = []
        
        # Close description divs after Contact section content
        if line.startswith('<p>') and 'Office:' in line:
            html_lines.append('      </div>')
        
        # Close description divs after Teaching section content  
        if 'course-button' in str(next_line_attr):
            # Will be closed after the button
            pass
        
        i += 1
    
    # Close any remaining open description divs
    if html_lines and 'COMPSCI' in html_lines[-1]:
        html_lines.append('      </div>')
    
    return '\n'.join(html_lines)


def create_html_page(md_file: Path, output_file: Path) -> None:
    """Create a complete HTML page from a markdown file."""
    
    # Read markdown content
    md_content = md_file.read_text()
    frontmatter, _ = parse_frontmatter(md_content)
    
    # Convert markdown to HTML
    body_html = convert_markdown_to_html(md_content)
    
    # Create full HTML document
    title = frontmatter.get('title', 'Tim Richards')
    description = frontmatter.get('description', 'Tim Richards - UMass Amherst')
    
    html = f'''<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <meta
      name="description"
      content="{description}"
    />
    <title>{title}</title>
    <link rel="icon" type="image/svg+xml" href="assets/favicon.svg" />
    <link rel="stylesheet" href="assets/styles.css" />
  </head>
  <body>
    <div class="container">
{body_html}
    </div>
  </body>
</html>
'''
    
    # Write output file
    output_file.write_text(html)
    print(f"✓ Generated {output_file} from {md_file}")


def main():
    """Main entry point."""
    if len(sys.argv) > 1:
        # Convert specific file
        md_file = Path(sys.argv[1])
        if not md_file.exists():
            print(f"Error: {md_file} not found")
            sys.exit(1)
        
        # Determine output file
        if len(sys.argv) > 2:
            output_file = Path(sys.argv[2])
        else:
            output_file = md_file.with_suffix('.html')
        
        create_html_page(md_file, output_file)
    else:
        # Convert all .md files in current directory
        current_dir = Path('.')
        md_files = list(current_dir.glob('*.md'))
        
        if not md_files:
            print("No markdown files found in current directory")
            print("\nUsage:")
            print("  python build.py <input.md> [output.html]")
            print("  python build.py  # converts all .md files")
            sys.exit(1)
        
        for md_file in md_files:
            if md_file.name != 'README.md':  # Skip README
                output_file = md_file.with_suffix('.html')
                create_html_page(md_file, output_file)


if __name__ == '__main__':
    main()
