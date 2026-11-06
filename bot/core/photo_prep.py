"""«Сканер после снимка» — предобработка фото перед распознаванием (core/vision.py).

Сами делаем то, что сделал бы экран-сканер: находим на снимке белую наклейку,
вырезаем её крупно, подтягиваем контраст и резкость; размытый кадр бракуем
до списания дневной квоты («Фото размыто — снимите ещё раз»).

Только numpy + Pillow (оба и так в venv бота и на сервере) — без OpenCV,
чтобы не тянуть тяжёлую зависимость на VPS.
"""
import io

import numpy as np
from PIL import Image, ImageOps, ImageFilter

ANALYSIS_SIDE = 1000     # размер для проверки резкости (не зависит от мегапикселей)
DETECT_SIDE = 480        # размер копии для поиска наклейки — доли кадра от размера не зависят
MIN_LABEL_FRACTION = 0.012   # наклейка меньше ~1% кадра — не считаем её наклейкой
MAX_LABEL_FRACTION = 0.90    # белое почти на весь кадр — это не наклейка, кадрирование не нужно
FILL_RATIO_MIN = 0.60        # «наклейка» должна заполнять свой прямоугольник (связная, не клякса)
MARGIN_FRACTION = 0.05       # оставляем чуть фона вокруг наклейки
TARGET_MIN_SIDE = 1100       # мелкую наклейку увеличиваем — модели проще читать мелкий текст
JPEG_QUALITY = 90

# ниже порога кадр считается смазанным; калибровка на реальных фото: годные кадры
# дают от ~50 (вырезка) и выше, сильная «шевелёнка» — ниже 15. Порог берём с запасом
# в сторону пропуска: хуже попросить переснять явный брак, чем отвергнуть годное фото.
BLUR_THRESHOLD = 28.0


class BlurryPhoto(Exception):
    """Кадр смазан — распознавать бессмысленно, просим переснять (квота не тратится)."""

    def __init__(self, blur_var: float):
        self.blur_var = blur_var
        super().__init__(f"размытое фото (резкость {blur_var:.1f} < {BLUR_THRESHOLD})")


class Prepared:
    def __init__(self, data: bytes, label_found: bool, blur_var: float):
        self.data = data              # JPEG на вход распознавания
        self.label_found = label_found
        self.blur_var = blur_var


def _laplacian_var(gray: np.ndarray) -> float:
    """Дисперсия лапласиана — стандартная мера резкости (чем меньше, тем сильнее смаз)."""
    g = gray.astype(np.float32)
    lap = (-4.0 * g
           + np.roll(g, 1, 0) + np.roll(g, -1, 0)
           + np.roll(g, 1, 1) + np.roll(g, -1, 1))
    lap[0, :] = lap[-1, :] = lap[:, 0] = lap[:, -1] = 0   # края без заворота
    return float(lap.var())


def _largest_white_box(rgb: np.ndarray):
    """Самый правдоподобный прямоугольник белой наклейки (x0, y0, x1, y1) или None.

    Наклейка должна быть «пятном» внутри кадра: полка, стена или блик протягиваются
    до края снимка, поэтому касающиеся края кандидаты отбрасываем — лучше отдать
    модели целое фото, чем вырезать случайный белый фон.
    """
    h, w, _ = rgb.shape
    v = rgb.max(axis=2).astype(np.int16)
    sat = v - rgb.min(axis=2).astype(np.int16)
    # белое: яркое и малонасыщенное — тень/блик отфильтровывает насыщенность
    mask = (v > 185) & (sat < 55)

    # сшиваем разорванное текстом: три расширения маски
    m = mask.copy()
    for _ in range(3):
        m = m | np.roll(m, 1, 0) | np.roll(m, -1, 0) | np.roll(m, 1, 1) | np.roll(m, -1, 1)
        m[0, :] = m[-1, :] = False
        m[:, 0] = m[:, -1] = False

    visited = np.zeros_like(m, dtype=bool)
    best = None
    frame = h * w
    for sy in range(0, h, 3):
        for sx in np.flatnonzero(m[sy] & ~visited[sy]):
            if visited[sy, sx]:
                continue
            # заливка связной области (BFS); кадр маленький, python-цикл быстр
            stack = [(int(sy), int(sx))]
            visited[sy, sx] = True
            area, x0, x1, y0, y1 = 0, sx, sx, sy, sy
            while stack:
                y, x = stack.pop()
                area += 1
                if x < x0: x0 = x
                if x > x1: x1 = x
                if y < y0: y0 = y
                if y > y1: y1 = y
                for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                    if 0 <= ny < h and 0 <= nx < w and m[ny, nx] and not visited[ny, nx]:
                        visited[ny, nx] = True
                        stack.append((ny, nx))
            frac = area / frame
            if not (MIN_LABEL_FRACTION <= frac <= MAX_LABEL_FRACTION):
                continue
            if x0 <= 1 or y0 <= 1 or x1 >= w - 2 or y1 >= h - 2:   # полка/стена/блик — до края кадра
                continue
            bw, bh = x1 - x0 + 1, y1 - y0 + 1
            if area / (bw * bh) < FILL_RATIO_MIN:
                continue
            if not (0.25 <= bw / bh <= 4.0):
                continue
            # внутри наклейки есть тёмные знаки (текст, штрихкод) — иначе это просто белое
            dark = int((v[y0:y1 + 1, x0:x1 + 1] < 110).sum())
            if not (0.015 * bw * bh <= dark <= 0.7 * bw * bh):
                continue
            if best is None or area > best[0]:
                best = (area, x0, y0, x1, y1)
    return (best[1], best[2], best[3], best[4]) if best else None


def prepare(photo: bytes) -> Prepared:
    """Готовим фото к распознаванию: наклейка → кадр, резкость, контраст → JPEG.

    Бросает BlurryPhoto, если кадр смазан; при любом сбое разбора возвращает
    исходные байты — пусть модель смотрит на фото как раньше, а не падает.
    """
    try:
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(photo))).convert("RGB")
    except Exception:
        return Prepared(photo, False, -1.0)

    # ищем наклейку на уменьшенной копии, координаты переносим на полный размер
    det = img.copy()
    det.thumbnail((DETECT_SIDE, DETECT_SIDE))
    box = _largest_white_box(np.asarray(det))
    if box:
        sh, sw = det.height, det.width
        kx, ky = img.width / sw, img.height / sh
        mx = int(img.width * MARGIN_FRACTION) + 8
        my = int(img.height * MARGIN_FRACTION) + 8
        x0 = max(0, int(box[0] * kx) - mx)
        y0 = max(0, int(box[1] * ky) - my)
        x1 = min(img.width, int(box[2] * kx) + 1 + mx)
        y1 = min(img.height, int(box[3] * ky) + 1 + my)
        if x1 - x0 > 40 and y1 - y0 > 40:
            img = img.crop((x0, y0, x1, y1))

    # резкость меряем по кадру в исходном разрешении — апскейл мелкой наклейки
    # не должен превращаться в ложный «брак»
    work = img.copy()
    work.thumbnail((ANALYSIS_SIDE, ANALYSIS_SIDE))
    blur_var = _laplacian_var(np.asarray(work.convert("L")))
    if blur_var < BLUR_THRESHOLD:
        raise BlurryPhoto(blur_var)

    # мелкая наклейка — растягиваем до читаемого размера
    min_side = min(img.size)
    if min_side < TARGET_MIN_SIDE:
        k = TARGET_MIN_SIDE / min_side
        img = img.resize((round(img.width * k), round(img.height * k)), Image.LANCZOS)

    # лёгкая подтяжка контраста и резкости — вырезанная этикетка часто блёклая
    img = ImageOps.autocontrast(img, cutoff=1)
    img = img.filter(ImageFilter.UnsharpMask(radius=2, percent=70, threshold=2))

    out = io.BytesIO()
    img.save(out, "JPEG", quality=JPEG_QUALITY)
    return Prepared(out.getvalue(), bool(box), blur_var)
