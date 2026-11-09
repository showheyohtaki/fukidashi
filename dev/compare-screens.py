#!/usr/bin/env python3
"""Left: approved canvas, right: actual extension. No generated substitute screenshots."""
from PIL import Image, ImageDraw
from pathlib import Path
import sys
root=Path(__file__).resolve().parent.parent
folder=Path(sys.argv[1]).resolve()
for actual in folder.glob('*.actual.png'):
    name=actual.name.replace('.actual.png','')
    reference=root/'docs'/'design'/'png'/(name+'.png')
    if not reference.exists():continue
    a=Image.open(reference).convert('RGB');b=Image.open(actual).convert('RGB')
    out=Image.new('RGB',(a.width+b.width+24,max(a.height,b.height)+48),'#d7d7d7')
    out.paste(a,(0,48));out.paste(b,(a.width+24,48))
    draw=ImageDraw.Draw(out);draw.text((12,16),'CANVAS / '+name,fill='black');draw.text((a.width+36,16),'IMPLEMENTATION',fill='black')
    out.save(folder/(name+'.compare.png'))
