# honzuki dictionaries

Put Yomichan/Yomitan-format dictionary packs (`.zip`) in this folder and
honzuki loads them at startup. Then select a word while reading to look it up.

**The dictionaries themselves are not part of this repository** (licensing) -
only this README is tracked by git. Download the packs yourself from:

**https://github.com/SakiDailene/yomichan-dictionaries**

Recommended packs:

| Pack | What it gives you |
|---|---|
| `[JA-EN] 新和英` | Japanese → English translations |
| `[Pitch] 大辞泉` | Pitch accent, shown as a small badge on the headword |

honzuki also reads dictionaries from `%APPDATA%\honzuki\dicts`; the folder
next to the executable (this one) takes priority when both exist.

Both JSONL and whole-array term banks are accepted, and honzuki keeps entries
from partially corrupt zips instead of skipping them.
