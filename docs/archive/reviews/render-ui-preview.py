# Render current ANSI samples using system libcairo; no extra Python packages.
# Run from the repository root after node docs/reviews/ui-audit.mjs.
import ctypes as C, ctypes.util, json, re, unicodedata
lib=C.CDLL(ctypes.util.find_library('cairo'))
def api(name,restype,args):
 f=getattr(lib,'cairo_'+name);f.restype=restype;f.argtypes=args;return f
ptr=C.c_void_p;I=C.c_int;D=C.c_double;S=C.c_char_p
surface=api('image_surface_create',ptr,[I,I,I])(0,1340,1400)
ctx=api('create',ptr,[ptr])(surface)
rgb=api('set_source_rgb',None,[ptr,D,D,D]);move=api('move_to',None,[ptr,D,D]);text=api('show_text',None,[ptr,S]);size=api('set_font_size',None,[ptr,D]);rect=api('rectangle',None,[ptr,D,D,D,D]);fill=api('fill',None,[ptr]);font=api('select_font_face',None,[ptr,S,I,I])
def color(hex):
 v=hex.lstrip('#');rgb(ctx,*[int(v[i:i+2],16)/255 for i in (0,2,4)])
def box(x,y,w,h,hex):color(hex);rect(ctx,x,y,w,h);fill(ctx)
def label(x,y,s,sz=16):size(ctx,sz);color('cdd6f4');move(ctx,x,y);text(ctx,s.encode())
box(0,0,1340,1400,'11111b');font(ctx,b'DejaVu Sans Mono',0,0)
label(20,28,'Current HUD renderer / synthetic data / illustrative terminal colors',17)
samples=json.load(open('docs/reviews/ui-audit/samples.json'))
base={'31':'f38ba8','32':'a6e3a1','33':'f9e2af','35':'cba6f7','36':'89dceb','96':'89b4fa'}
def drawline(s,x,y):
 fg='cdd6f4';bg=None;inverse=False;dim=False;parts=re.split(r'(\x1b\[[0-9;]*m)',s)
 for p in parts:
  if p.startswith('\x1b['):
   codes=p[2:-1].split(';');i=0
   while i<len(codes):
    n=codes[i]
    if n=='0':fg='cdd6f4';bg=None;inverse=False;dim=False
    elif n=='2':dim=True
    elif n=='7':inverse=True
    elif n=='27':inverse=False
    elif n=='48' and i+4<len(codes) and codes[i+1]=='2':bg=''.join(f'{int(v):02x}' for v in codes[i+2:i+5]);i+=4
    elif n=='39':fg='cdd6f4'
    elif n=='38' and i+4<len(codes) and codes[i+1]=='2':fg=''.join(f'{int(v):02x}' for v in codes[i+2:i+5]);i+=4
    elif n in base:fg=base[n]
    i+=1
   continue
  ink=(bg or '1e1e2e') if inverse else fg
  paper=fg if inverse else bg
  v=[int(ink[j:j+2],16)/255 for j in (0,2,4)]
  if dim:v=[a*.6+b*.4 for a,b in zip(v,[30/255,30/255,46/255])]
  rgb(ctx,*v)
  for ch in p:
   advance=10*(0 if unicodedata.combining(ch) or ch=='\ufe0f' else 2 if unicodedata.east_asian_width(ch) in ('W','F') else 1)
   if paper:box(x,y-16,advance,21,paper)
   rgb(ctx,*v);move(ctx,x,y);text(ctx,ch.encode());x+=advance
def card(kind,w,x,y):
 s=next(s for s in samples if s['kind']==kind and s['width']==w and s['theme']=='terminal')
 label(x,y+22,f'{"Tree" if kind == "default" else kind} / {w} cols')
 box(x,y+34,w*10+20,24*21+20,'1e1e2e');size(ctx,16)
 for i,line in enumerate(s['lines']):drawline(line,x+10,y+60+i*21)
card('default',16,20,45);card('default',30,220,45);card('default',45,560,45)
card('inspector',45,20,650);card('settings',30,510,650);card('diff-zoom',45,850,650)
label(20,1260,'Status bar / 120 columns / cache warning at 25 minutes')
box(20,1275,1230,48,'1e1e2e');size(ctx,16)
s=next(s for s in samples if s['kind']=='bar' and s['width']==120);drawline(s['lines'][0],30,1306)
label(20,1365,'Current renderer output after UI fixes. Full samples: preview.html',14)
api('surface_write_to_png',I,[ptr,S])(surface,b'docs/reviews/ui-audit/overview.png')
api('destroy',None,[ptr])(ctx);api('surface_destroy',None,[ptr])(surface)
