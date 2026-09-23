#!/usr/bin/env python3
"""
Fabrique `public/favicon.png` à partir du logo, sans retoucher le logo.

Les sept pages réclamaient `/favicon.png` depuis toujours ; le fichier
n'existait pas. Elles chargeaient donc un 404 chacune et l'onglet restait
vierge.

Ce qu'on y met : le « U » du logo lui-même, découpé dans `public/logo.png` —
pas une lettre retypographiée, le glyphe exact, avec son antialiasing. Il y est
déjà blanc, puisque le logo est dessiné pour fond sombre ; il suffit donc de le
poser sur une tuile --teal-ink, sans rien repeindre.

Le pictogramme du foret aurait été le choix évident — c'est lui qui raconte le
métier. Il est dessiné au trait fin : réduit à 16 px il ne reste qu'une tache
verte. Testé, écarté.

Usage :  python3 scripts/derive-favicon.py
Requiert Pillow. Le fichier produit est versionné : on ne relance ce script que
si le logo change.
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
MASTER = ROOT / "public" / "logo.png"
OUT = ROOT / "public" / "favicon.png"

TEAL_INK = (0x07, 0x79, 0x6A)  # --teal-ink : blanc dessus tient le contraste,
                               # ce que --teal ne ferait pas.
SIZE = 256
RADIUS = 0.22                  # proportion du côté. La pastille du logo est
                               # entièrement arrondie ; une tuile ne peut pas
                               # l'être sans devenir un disque.
GLYPH_HEIGHT = 0.46            # proportion de la tuile


def crop_u(a: np.ndarray) -> Image.Image:
    """Découpe le « U » : le premier bloc blanc du logo (U, s, i, puis foret).

    Le tri se fait sur la teinte — vert nettement au-dessus du rouge — et pas
    sur une liste de couleurs : le PNG est indexé, ses bords antialiasés
    portent des dizaines de valeurs intermédiaires.
    """
    white = (a[..., 1] <= a[..., 0] + 12) & (a[..., 3] > 40)
    cols = white.any(axis=0)
    runs, start = [], None
    for x, on in enumerate(cols):
        if on and start is None:
            start = x
        elif not on and start is not None:
            runs.append((start, x - 1))
            start = None
    if start is not None:
        runs.append((start, len(cols) - 1))

    x0, x1 = runs[0]
    rows = np.where(white[:, x0 : x1 + 1].any(axis=1))[0]
    return Image.fromarray(a[rows.min() : rows.max() + 1, x0 : x1 + 1].astype("uint8"))


def main() -> None:
    a = np.array(Image.open(MASTER).convert("RGBA")).astype(int)

    ss = 4  # supersampling, pour que les coins arrondis ne crénelent pas
    tile = Image.new("RGBA", (SIZE * ss, SIZE * ss), (0, 0, 0, 0))
    ImageDraw.Draw(tile).rounded_rectangle(
        [0, 0, SIZE * ss - 1, SIZE * ss - 1],
        radius=int(SIZE * ss * RADIUS),
        fill=TEAL_INK + (255,),
    )
    tile = tile.resize((SIZE, SIZE), Image.LANCZOS)

    glyph = crop_u(a)
    h = int(SIZE * GLYPH_HEIGHT)
    w = max(1, round(glyph.width * h / glyph.height))
    glyph = glyph.resize((w, h), Image.LANCZOS)
    tile.alpha_composite(glyph, ((SIZE - w) // 2, (SIZE - h) // 2))

    tile.save(OUT)
    print(f"{OUT.relative_to(ROOT)}  {tile.width}x{tile.height}")


if __name__ == "__main__":
    main()
