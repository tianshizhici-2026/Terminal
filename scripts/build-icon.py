from PIL import Image, ImageDraw
from pathlib import Path
root=Path(__file__).resolve().parents[1]/'src/Mist.Terminal/Assets'
scale=4
image=Image.new('RGBA',(256*scale,256*scale))
draw=ImageDraw.Draw(image)
def box(coords):return tuple(x*scale for x in coords)
draw.rounded_rectangle(box((16,16,240,240)),radius=52*scale,fill='#3B3E44')
draw.polygon([(x*scale,y*scale) for x,y in [(65,77),(116,128),(65,179),(50,164),(86,128),(50,92)]],fill='#E0E3E7')
draw.rounded_rectangle(box((132,157,195,177)),radius=5*scale,fill='#AEB5BE')
image=image.resize((256,256),Image.Resampling.LANCZOS)
image.save(root/'terminal.png')
image.save(root/'terminal.ico',sizes=[(n,n) for n in [16,20,24,32,40,48,64,128,256]])
with Image.open(root/'terminal.ico') as ico:
 assert len(ico.ico.sizes())==9
print('Icon built: 3 elements, 9 ICO sizes (16–256 px)')
