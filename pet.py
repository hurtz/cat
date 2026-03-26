#!/usr/bin/env python3
"""A chaotic little terminal pet that bounces around and does weird stuff."""

import sys, os, time, random, math, shutil, signal

# Terminal colors (256-color)
def color(fg, text):
    return f"\033[38;5;{fg}m{text}\033[0m"

def bg_color(bg, fg, text):
    return f"\033[48;5;{bg}m\033[38;5;{fg}m{text}\033[0m"

# Hide/show cursor, alternate screen
def setup():
    sys.stdout.write("\033[?25l")  # hide cursor
    sys.stdout.write("\033[?1049h")  # alternate screen
    sys.stdout.flush()

def cleanup(*_):
    sys.stdout.write("\033[?25l")
    sys.stdout.write("\033[?1049l")  # restore screen
    sys.stdout.write("\033[?25h")  # show cursor
    sys.stdout.flush()
    sys.exit(0)

signal.signal(signal.SIGINT, cleanup)
signal.signal(signal.SIGTERM, cleanup)

# Pet frames for different moods
CATS = {
    "idle": [
        [" /\\_/\\ ", "( o.o )", " > ^ < "],
        [" /\\_/\\ ", "( o.o )", "  > < "],
    ],
    "happy": [
        [" /\\_/\\ ", "( ^.^ )", " > ^ < "],
        [" /\\_/\\ ", "( ^o^ )", "  > < "],
    ],
    "sleepy": [
        [" /\\_/\\ ", "( -.- )", " > ^ <  z"],
        [" /\\_/\\ ", "( -.- )", " > ^ < zZ"],
        [" /\\_/\\ ", "( -.- )", " > ^ < zZz"],
    ],
    "excited": [
        ["  /\\_/\\", " ( O.O)", "  > ^ <"],
        [" /\\_/\\ ", "(O.O )", " > ^ < "],
    ],
    "love": [
        [" /\\_/\\  ♥", "( ^.^ ) ♥", " > ^ <"],
        [" /\\_/\\ ♥ ", "( ^.^ )♥ ", " > ^ <  "],
    ],
    "dizzy": [
        [" /\\_/\\ ", "( @.@ )", " > ~ < "],
        [" /\\_/\\ ", "( @.@ )", " < ~ > "],
    ],
    "dance": [
        [" /\\_/\\  ♪", "( ^o^ ) ♪", " \\> ^  "],
        ["♪  /\\_/\\ ", "♪ ( ^o^ )", "   ^ </ "],
    ],
    "eat": [
        [" /\\_/\\    ", "( o.o )🐟", " > ^ <   "],
        [" /\\_/\\   ", "( o.o )~ ", " > ^ <  "],
        [" /\\_/\\  ", "( ^.^ ) ", " > ^ < "],
    ],
    "pounce": [
        [" /\\_/\\     ", "( O.O )    ", " />  <\\    "],
        ["     /\\_/\\ ", "    ( >.< )", "    /> <\\  "],
    ],
    "spin": [
        [" /\\_/\\ ", "( o.o )", " > ^ < "],
        [" \\/_\\/ ", "( o.o )", " > ^ < "],
        [" /\\_/\\ ", ") o.o (", " < ^ > "],
        [" /\\_/\\ ", "( o.o )", " > v < "],
    ],
}

THOUGHT_BUBBLES = [
    "thinking about fish...",
    "world domination?",
    "nap time soon...",
    "what's that red dot?!",
    "knock something off a table?",
    "ZOOMIES!!!",
    "if I fits, I sits",
    "hooman is weird",
    "must... catch... tail...",
    "plotting...",
    "*purrrrrr*",
    "why is the floor lava?",
    "3am energy incoming",
    "bird.exe detected",
    "one braincell activated",
    "the audacity...",
    "treat? TREAT??",
    "I see dead mice",
    "*judges you silently*",
    "this box is mine now",
    "chaos mode: ON",
]

TRAILS = ["·", "✦", "★", "♦", "•", "~", "⋆", "✧", "∘", "♪"]

class Pet:
    def __init__(self):
        self.cols, self.rows = shutil.get_terminal_size()
        self.x = self.cols // 2
        self.y = self.rows // 2
        self.vx = random.choice([-2, -1, 1, 2])
        self.vy = random.choice([-1, 1])
        self.mood = "idle"
        self.mood_timer = 0
        self.frame = 0
        self.color_fg = random.randint(1, 231)
        self.color_timer = 0
        self.thought = None
        self.thought_timer = 0
        self.trail = []
        self.trail_on = False
        self.particles = []
        self.tick = 0
        self.rainbow_mode = False
        self.gravity_mode = False
        self.mirror_pet = None
        self.stars = [(random.randint(0, self.cols-1), random.randint(0, self.rows-1)) for _ in range(8)]

    def update_size(self):
        self.cols, self.rows = shutil.get_terminal_size()

    def pick_mood(self):
        moods = list(CATS.keys())
        weights = [3, 3, 2, 2, 1, 1, 3, 2, 1, 2]
        self.mood = random.choices(moods, weights=weights)[0]
        self.mood_timer = random.randint(20, 80)
        # sometimes trigger special effects with moods
        if self.mood == "excited":
            self.vx = random.choice([-3, -2, 2, 3])
            self.vy = random.choice([-2, -1, 1, 2])
        elif self.mood == "sleepy":
            self.vx = 0
            self.vy = 0
        elif self.mood == "dance":
            self.rainbow_mode = True
        elif self.mood == "pounce":
            self.vx = random.choice([-4, 4])
            self.vy = random.choice([-2, 2])

    def add_particles(self, kind="sparkle"):
        for _ in range(random.randint(3, 8)):
            self.particles.append({
                "x": self.x + random.randint(-2, 8),
                "y": self.y + random.randint(-1, 3),
                "vx": random.uniform(-1.5, 1.5),
                "vy": random.uniform(-1.5, 0.5),
                "life": random.randint(5, 15),
                "char": random.choice(["✦", "★", "·", "♥", "✧", "⋆", "♪", "~", "°", "∘"]),
                "color": random.randint(1, 231),
            })

    def update(self):
        self.tick += 1
        self.update_size()

        # mood transitions
        self.mood_timer -= 1
        if self.mood_timer <= 0:
            old_mood = self.mood
            self.pick_mood()
            if old_mood == "dance":
                self.rainbow_mode = False
            if random.random() < 0.3:
                self.add_particles()

        # thought bubbles
        self.thought_timer -= 1
        if self.thought_timer <= 0:
            if random.random() < 0.3:
                self.thought = random.choice(THOUGHT_BUBBLES)
                self.thought_timer = random.randint(25, 60)
            else:
                self.thought = None
                self.thought_timer = random.randint(10, 30)

        # color changes
        self.color_timer -= 1
        if self.color_timer <= 0:
            if self.rainbow_mode:
                self.color_fg = (self.color_fg + 1) % 232
                if self.color_fg == 0: self.color_fg = 1
                self.color_timer = 1
            else:
                self.color_fg = random.randint(1, 231)
                self.color_timer = random.randint(15, 50)

        # trail toggle
        if random.random() < 0.01:
            self.trail_on = not self.trail_on

        # random velocity changes
        if random.random() < 0.08 and self.mood != "sleepy":
            self.vx += random.choice([-1, 0, 1])
            self.vy += random.choice([-1, 0, 1])
            self.vx = max(-4, min(4, self.vx))
            self.vy = max(-2, min(2, self.vy))

        # gravity mode toggle
        if random.random() < 0.005:
            self.gravity_mode = not self.gravity_mode

        if self.gravity_mode and self.mood != "sleepy":
            self.vy += 0.3
            self.vy = min(2, self.vy)

        # movement
        if self.trail_on:
            self.trail.append((int(self.x), int(self.y), random.choice(TRAILS), self.color_fg))
            if len(self.trail) > 30:
                self.trail.pop(0)

        self.x += self.vx
        self.y += self.vy

        # bounce off walls
        pet_w = max(len(line) for line in CATS[self.mood][0])
        pet_h = len(CATS[self.mood][0])

        if self.x <= 1:
            self.x = 1
            self.vx = abs(self.vx) if self.vx != 0 else random.choice([1, 2])
            self.add_particles()
        if self.x >= self.cols - pet_w - 1:
            self.x = self.cols - pet_w - 1
            self.vx = -abs(self.vx) if self.vx != 0 else random.choice([-1, -2])
            self.add_particles()
        if self.y <= 1:
            self.y = 1
            self.vy = abs(self.vy) if self.vy != 0 else 1
        if self.y >= self.rows - pet_h - 1:
            self.y = self.rows - pet_h - 1
            self.vy = -abs(self.vy) if self.vy != 0 else -1
            if self.gravity_mode:
                self.vy = random.uniform(-2, -1)  # bounce!

        # particles
        alive = []
        for p in self.particles:
            p["x"] += p["vx"]
            p["y"] += p["vy"]
            p["life"] -= 1
            if p["life"] > 0:
                alive.append(p)
        self.particles = alive

        # twinkling stars
        if random.random() < 0.1:
            idx = random.randint(0, len(self.stars) - 1)
            self.stars[idx] = (random.randint(0, self.cols-1), random.randint(0, self.rows-1))

        # animation frame
        frames = CATS[self.mood]
        self.frame = (self.frame + 1) % len(frames)

        # mirror pet appears/disappears
        if random.random() < 0.003:
            if self.mirror_pet is None:
                self.mirror_pet = {"timer": random.randint(30, 80)}
            else:
                self.mirror_pet = None

    def render(self):
        buf = []
        buf.append("\033[2J")  # clear screen

        # draw stars
        star_chars = [".", "·", "*", "✦", "⋆"]
        for sx, sy in self.stars:
            if 0 < sx < self.cols and 0 < sy < self.rows:
                c = random.choice([240, 245, 250, 255]) if random.random() < 0.1 else 240
                buf.append(f"\033[{sy};{sx}H{color(c, random.choice(star_chars))}")

        # draw trail
        for i, (tx, ty, tc, tcol) in enumerate(self.trail):
            fade = max(232, 255 - (len(self.trail) - i) * 2)
            if 0 < tx < self.cols and 0 < ty < self.rows:
                buf.append(f"\033[{ty};{tx}H{color(tcol if random.random() < 0.5 else fade, tc)}")

        # draw particles
        for p in self.particles:
            px, py = int(p["x"]), int(p["y"])
            if 0 < px < self.cols and 0 < py < self.rows:
                buf.append(f"\033[{py};{px}H{color(p['color'], p['char'])}")

        # draw pet
        frames = CATS[self.mood]
        frame = frames[self.frame % len(frames)]
        ix, iy = int(self.x), int(self.y)
        for i, line in enumerate(frame):
            if 0 < iy + i < self.rows:
                if self.rainbow_mode:
                    rendered = ""
                    for j, ch in enumerate(line):
                        rc = ((self.tick * 3 + j * 7 + i * 13) % 216) + 16
                        rendered += f"\033[38;5;{rc}m{ch}"
                    rendered += "\033[0m"
                    buf.append(f"\033[{iy + i};{ix}H{rendered}")
                else:
                    buf.append(f"\033[{iy + i};{ix}H{color(self.color_fg, line)}")

        # thought bubble
        if self.thought:
            tx = ix + 10
            ty = iy - 2
            if ty < 1: ty = iy + 4
            if tx + len(self.thought) + 4 > self.cols:
                tx = ix - len(self.thought) - 4
            if tx < 1: tx = 1
            bubble = f"╭{'─' * (len(self.thought) + 2)}╮"
            text   = f"│ {self.thought} │"
            bottom = f"╰{'─' * (len(self.thought) + 2)}╯"
            tc = random.choice([183, 189, 195, 225, 219]) if self.rainbow_mode else 250
            if 0 < ty < self.rows - 3:
                buf.append(f"\033[{ty};{tx}H{color(tc, bubble)}")
                buf.append(f"\033[{ty+1};{tx}H{color(tc, text)}")
                buf.append(f"\033[{ty+2};{tx}H{color(tc, bottom)}")

        # mirror pet (upside down, on opposite side)
        if self.mirror_pet:
            self.mirror_pet["timer"] -= 1
            if self.mirror_pet["timer"] <= 0:
                self.mirror_pet = None
            else:
                mx = self.cols - ix - 8
                my = self.rows - iy - 3
                mc = (self.color_fg + 100) % 232
                if mc == 0: mc = 1
                for i, line in enumerate(reversed(frame)):
                    flipped = line[::-1]
                    if 0 < my + i < self.rows and 0 < mx < self.cols:
                        buf.append(f"\033[{my + i};{mx}H{color(mc, flipped)}")

        # status bar
        status_items = [
            f"mood: {self.mood}",
            f"{'🌈 rainbow' if self.rainbow_mode else ''}",
            f"{'🌍 gravity' if self.gravity_mode else ''}",
            f"{'✨ trail' if self.trail_on else ''}",
            f"{'👥 mirror' if self.mirror_pet else ''}",
        ]
        status = "  ".join(s for s in status_items if s)
        buf.append(f"\033[{self.rows};1H{color(240, status[:self.cols-1])}")

        sys.stdout.write("".join(buf))
        sys.stdout.flush()


def main():
    setup()
    pet = Pet()
    try:
        while True:
            pet.update()
            pet.render()
            time.sleep(0.08)
    except Exception:
        cleanup()

if __name__ == "__main__":
    main()
