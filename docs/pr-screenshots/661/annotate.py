#!/usr/bin/env python3
"""Add route captions, red marks, and close views to real app screenshots.

This script uses ImageMagick for all image work. Source screenshots are in raw/.
"""

import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
FONT = "/System/Library/Fonts/Geneva.ttf"
RED = "#ff4141"


def run(args):
    subprocess.run(args, check=True)


def desktop(name, title, route, boxes, crop):
    source = RAW / f"{name}.png"
    marked = ROOT / f".{name}-marked.png"
    close = ROOT / f".{name}-close.png"
    box_args = []
    for x1, y1, x2, y2 in boxes:
        box_args += ["-draw", f"rectangle {x1},{y1} {x2},{y2}"]
    run(["magick", str(source), "-stroke", RED, "-strokewidth", "10",
         "-fill", "none", *box_args, str(marked)])
    x, y, w, h = crop
    run(["magick", str(source), "-crop", f"{w}x{h}+{x}+{y}", "+repage",
         "-resize", "1100x1100", "-bordercolor", RED, "-border", "5", str(close)])
    run(["magick", "-size", "4230x2100", "xc:#111318",
         str(marked), "-geometry", "+20+170", "-composite",
         str(close), "-geometry", "+3100+235", "-composite",
         "-font", FONT, "-fill", "white", "-pointsize", "56",
         "-annotate", "+42+75", title,
         "-fill", "#bfc5cf", "-pointsize", "36",
         "-annotate", "+42+132", route,
         "-fill", "white", "-pointsize", "34",
         "-annotate", "+3100+210", "CLOSE VIEW",
         str(ROOT / f"{name}.png")])
    marked.unlink()
    close.unlink()


def mobile(name, title, boxes, crop):
    source = RAW / f"{name}.png"
    marked = ROOT / f".{name}-marked.png"
    close = ROOT / f".{name}-close.png"
    box_args = []
    for x1, y1, x2, y2 in boxes:
        box_args += ["-draw", f"rectangle {x1},{y1} {x2},{y2}"]
    run(["magick", str(source), "-stroke", RED, "-strokewidth", "4",
         "-fill", "none", *box_args, str(marked)])
    x, y, w, h = crop
    run(["magick", str(source), "-crop", f"{w}x{h}+{x}+{y}", "+repage",
         "-resize", "700x700", "-bordercolor", RED, "-border", "4", str(close)])
    run(["magick", "-size", "1200x830", "xc:#111318",
         str(marked), "-geometry", "+30+110", "-composite",
         str(close), "-geometry", "+465+155", "-composite",
         "-font", FONT, "-fill", "white", "-pointsize", "42",
         "-annotate", "+30+64", title,
         "-fill", "#bfc5cf", "-pointsize", "27",
         "-annotate", "+30+98", "Tasks > task > Agent Transcript",
         "-fill", "white",
         "-pointsize", "28", "-annotate", "+465+137", "CLOSE VIEW",
         str(ROOT / f"{name}.png")])
    marked.unlink()
    close.unlink()


desktop("01-task-flow", "1. Task flow evidence", "Tasks > Review invoice 104 > Details",
        [(1045, 840, 2585, 1215)], (1050, 835, 1525, 390))
desktop("02-skill-save", "2. Save a skill edit", "Skills > invoice-review > Save",
        [(1345, 745, 2300, 1875)], (1340, 745, 970, 1130))
desktop("03-skill-draft", "3. Review the staged draft", "Skills > Skill drafts for review > Approve",
        [(1400, 80, 2230, 600)], (1390, 80, 850, 535))
desktop("04-skill-approved", "4. The approved skill is version 2", "Skills > invoice-review",
        [(85, 380, 605, 510), (650, 430, 730, 490)], (80, 365, 665, 160))
desktop("05-system-skill", "5. System skill is read only", "Skills > self-improving-workflows",
        [(650, 425, 1220, 490), (1340, 665, 2290, 840)], (640, 415, 630, 150))
desktop("06-desktop-before", "6. Choose a button in task chat", "Tasks > Find an invoice reminder > transcript",
        [(670, 250, 2890, 535)], (675, 255, 1300, 285))
desktop("07-desktop-after", "7. Button sends a user message", "Tasks > same task > transcript",
        [(670, 250, 2890, 535), (2610, 575, 2930, 730)], (2580, 560, 380, 190))
mobile("08-mobile-before", "8. Mobile: choose a button", [(25, 190, 372, 350)], (25, 190, 350, 165))
mobile("09-mobile-after", "9. Mobile: message sent", [(25, 190, 372, 350), (215, 358, 393, 425)],
       (25, 185, 370, 245))
