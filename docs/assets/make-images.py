# Logo (512x512) and feature card (965x482) for the commit-live light Marketplace listing. No text in the logo.
from PIL import Image, ImageDraw, ImageFilter

BG = (13, 17, 23)        # GitHub dark
YELLOW = (242, 183, 5)   # lit, as in light-report / action branding yellow
DIM = (48, 54, 61)

def bolt(d, cx, cy, s, fill):
    # lightning bolt polygon in a unit box centered on (cx, cy), scaled by s
    pts = [(0.12, -0.50), (-0.28, 0.06), (-0.02, 0.06), (-0.14, 0.50), (0.30, -0.10), (0.04, -0.10), (0.16, -0.50)]
    d.polygon([(cx + x * s, cy + y * s) for x, y in pts], fill=fill)

def logo(size=512, k=4):
    S = size * k
    img = Image.new('RGBA', (S, S), BG + (255,))
    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([S * 0.14, S * 0.14, S * 0.86, S * 0.86], fill=YELLOW + (70,))
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.06))
    img.alpha_composite(glow)
    d = ImageDraw.Draw(img)
    d.ellipse([S * 0.16, S * 0.16, S * 0.84, S * 0.84], outline=YELLOW, width=int(S * 0.035))
    bolt(d, S / 2, S / 2, S * 0.52, YELLOW)
    return img.resize((size, size), Image.LANCZOS)

def card(w=965, h=482, k=2):
    W, H = w * k, h * k
    img = Image.new('RGBA', (W, H), BG + (255,))
    d = ImageDraw.Draw(img)
    # a row of lamps: lit and dark commits, the one live commit glowing
    n, r = 9, H * 0.055
    for i in range(n):
        x = W * (0.08 + 0.84 * i / (n - 1))
        y = H * 0.80
        lit = i not in (2, 5)
        d.ellipse([x - r, y - r, x + r, y + r], fill=YELLOW if lit else None, outline=YELLOW if lit else DIM, width=int(r * 0.25))
        if i < n - 1:
            d.line([x + r * 1.3, y, x + W * 0.84 / (n - 1) - r * 1.3, y], fill=DIM, width=int(r * 0.2))
    l = logo(int(H * 0.5), 4)
    img.alpha_composite(l, (int(W / 2 - l.width / 2), int(H * 0.12)))
    return img.resize((w, h), Image.LANCZOS)

logo().save('logo.png')
card().convert('RGB').save('feature-card.png')
