# generate_marian.py — odpalane co 5 minut przez GitHub Actions.
# Generuje marian.m3u na podstawie aktualnej godziny (czasu polskiego).

import os
import random
from datetime import datetime, timedelta

# ---- KONFIGURACJA ----

BASE_URL = "https://kotmruk.github.io/marian-tv"
MEDIA_DIR = os.path.join(os.path.dirname(__file__), "media")
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "marian.m3u")

# Bloki programowe: (godzina, minuta, dlugosc_w_minutach) — czas POLSKI (CET/CEST)!
# GitHub Actions dziala w UTC, Polska to UTC+1 (zima) / UTC+2 (lato).
# Ta wartosc jest automatycznie dostosowywana do aktualnego czasu letniego/zimowego.
TZ_OFFSET_HOURS = 1  # Bedzie dynamicznie dostosowana w kodzie

BLOCKS = [
    (10, 0, 45),   # 10:00 - 10:45
    (14, 0, 45),   # 14:00 - 14:45
    (18, 0, 60),   # 18:00 - 19:00
    (21, 0, 45),   # 21:00 - 21:45
]

ADS_PER_ROUND = 2
PLANSZA_FILE = "plansza.mp4"

# ---- KONIEC KONFIGURACJI ----


def get_tz_offset():
    """Dynamicznie okresla offset do czasu polskiego (uwzglednia czas letni/zimowy)."""
    now_utc = datetime.utcnow()
    # Przyblizona heurystyka: czas letni ~ pazdziernik - marzec
    # W rzeczywistosci lepiej by bylo uzywac pytz, ale tu bez dodatkowych zaleznosci
    if 3 <= now_utc.month <= 10:
        return 2  # CEST (czas letni)
    else:
        return 1  # CET (czas zimowy)


def local_now():
    offset = get_tz_offset()
    return datetime.utcnow() + timedelta(hours=offset)


def list_media(subfolder):
    path = os.path.join(MEDIA_DIR, subfolder)
    if not os.path.isdir(path):
        return []
    return [f for f in os.listdir(path) if f.lower().endswith((".mp4", ".mkv", ".ts"))]


def current_block():
    now = local_now()
    for h, m, dur in BLOCKS:
        start = now.replace(hour=h, minute=m, second=0, microsecond=0)
        end = start + timedelta(minutes=dur)
        if start <= now < end:
            return start, end
    return None


def next_block_start():
    now = local_now()
    candidates = []
    for h, m, dur in BLOCKS:
        start = now.replace(hour=h, minute=m, second=0, microsecond=0)
        if start <= now:
            start += timedelta(days=1)
        candidates.append(start)
    return min(candidates)


def build_m3u(entries):
    lines = ["#EXTM3U"]
    for title, url in entries:
        lines.append(f"#EXTINF:-1,{title}")
        lines.append(url)
    return "\n".join(lines) + "\n"


def main():
    block = current_block()
    media_url = BASE_URL + "/media"

    if block is None:
        wroc_o = next_block_start().strftime("%H:%M")
        entries = [
            (f"KANAL NIEDOSTEPNY - WROC O {wroc_o}", f"{media_url}/{PLANSZA_FILE}")
        ]
        content = build_m3u(entries)
    else:
        start, end = block
        filmy = list_media("filmy")
        reklamy = list_media("reklamy")

        if not filmy or not reklamy:
            content = "#EXTM3U\n#EXTINF:-1,BRAK MATERIALOW W media/filmy lub media/reklamy\n"
        else:
            random.shuffle(filmy)
            random.shuffle(reklamy)

            entries = []
            minutes_left = (end - local_now()).total_seconds() / 60
            round_minutes = ADS_PER_ROUND * 0.5 + 2
            rounds = max(1, int(minutes_left / round_minutes))

            fi, ri = 0, 0
            for _ in range(rounds):
                for _ in range(ADS_PER_ROUND):
                    r = reklamy[ri % len(reklamy)]
                    entries.append((f"REKLAMA: {r}", f"{media_url}/reklamy/{r}"))
                    ri += 1
                f = filmy[fi % len(filmy)]
                entries.append((f"FILM: {f}", f"{media_url}/filmy/{f}"))
                fi += 1

            content = build_m3u(entries)

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        f.write(content)
    print(content)


if __name__ == "__main__":
    main()
