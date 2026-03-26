#!/usr/bin/env python3
"""A chaotic little terminal pet that bounces around and does weird stuff.
Run solo or connect to friends with --name and --server flags."""

import sys, os, time, random, math, shutil, signal, argparse, uuid, json, threading

# Terminal colors (256-color)
def color(fg, text):
    return f"\033[38;5;{fg}m{text}\033[0m"

def bg_color(bg, fg, text):
    return f"\033[48;5;{bg}m\033[38;5;{fg}m{text}\033[0m"

# Hide/show cursor, alternate screen
def setup():
    sys.stdout.write("\033[?25l")
    sys.stdout.write("\033[?1049h")
    sys.stdout.flush()

def cleanup(*_):
    sys.stdout.write("\033[?25l")
    sys.stdout.write("\033[?1049l")
    sys.stdout.write("\033[?25h")
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

# Smaller sprites for friend pets so they don't overwhelm
MINI_CAT = [" /\\_/\\", "( o.o)", " > < "]
MINI_MOODS = {
    "idle":    [" /\\_/\\", "( o.o)", " > < "],
    "happy":   [" /\\_/\\", "( ^.^)", " > < "],
    "sleepy":  [" /\\_/\\", "( -.-)","  zZz "],
    "excited": [" /\\_/\\", "( O.O)", " > < "],
    "love":    [" /\\_/\\", "( ^.^)", "  ♥♥  "],
    "dizzy":   [" /\\_/\\", "( @.@)", " > < "],
    "dance":   [" /\\_/\\", "( ^o^)", "  ♪♪  "],
    "eat":     [" /\\_/\\", "( o.o)", " ~🐟 "],
    "pounce":  [" /\\_/\\", "( >.<)", " /> <\\"],
    "spin":    [" /\\_/\\", "( o.o)", " > < "],
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

# Assign each friend a consistent color from a nice palette
FRIEND_COLORS = [196, 46, 51, 226, 201, 208, 87, 213, 118, 141, 203, 39, 228, 197, 159]


class Network:
    """Handles WebSocket connection to the relay server in a background thread."""

    def __init__(self, server_url, name, room):
        self.server_url = server_url
        self.name = name
        self.room = room
        self.client_id = str(uuid.uuid4())[:8]
        self.peers = {}  # id -> state dict
        self.roster = {}  # id -> name
        self.emotes = []  # [(from_name, emote, expire_tick)]
        self.connected = False
        self.ws = None
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        import asyncio
        asyncio.run(self._async_run())

    async def _async_run(self):
        try:
            from websockets.asyncio.client import connect
        except ImportError:
            return

        while True:
            try:
                async with connect(self.server_url) as ws:
                    self.ws = ws
                    self.connected = True
                    # join
                    await ws.send(json.dumps({
                        "type": "join",
                        "id": self.client_id,
                        "name": self.name,
                        "room": self.room,
                    }))

                    async for raw in ws:
                        msg = json.loads(raw)
                        with self._lock:
                            if msg["type"] == "states":
                                self.peers = msg.get("peers", {})
                            elif msg["type"] == "roster":
                                self.roster = msg.get("players", {})
                            elif msg["type"] == "emote":
                                self.emotes.append((msg["from"], msg["emote"], time.time() + 3))

            except Exception:
                self.connected = False
                self.ws = None
                time.sleep(2)  # reconnect

    def send_state(self, state):
        if not self.connected or not self.ws:
            return
        import asyncio
        try:
            # fire-and-forget via the ws's event loop
            loop = self.ws.protocol  # hack: get at the underlying connection
        except Exception:
            pass
        # Use a thread-safe approach
        self._send_queue = getattr(self, '_send_queue', None)
        if self._send_queue is None:
            import queue
            self._send_queue = queue.Queue()
            t = threading.Thread(target=self._sender_loop, daemon=True)
            t.start()
        self._send_queue.put(json.dumps({"type": "state", "data": state}))

    def _sender_loop(self):
        import asyncio
        loop = asyncio.new_event_loop()
        while True:
            msg = self._send_queue.get()
            if self.ws:
                try:
                    loop.run_until_complete(self.ws.send(msg))
                except Exception:
                    pass

    def send_emote(self, emote):
        if not self.connected:
            return
        self._send_queue = getattr(self, '_send_queue', None)
        if self._send_queue:
            self._send_queue.put(json.dumps({"type": "emote", "emote": emote}))

    def get_peers(self):
        with self._lock:
            return dict(self.peers)

    def get_roster(self):
        with self._lock:
            return dict(self.roster)

    def get_emotes(self):
        now = time.time()
        with self._lock:
            self.emotes = [(f, e, t) for f, e, t in self.emotes if t > now]
            return list(self.emotes)


class Pet:
    def __init__(self, name="cat", network=None):
        self.name = name
        self.network = network
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
        self._friend_colors = {}
        self._color_idx = 0
        self._net_tick = 0

    def _get_friend_color(self, friend_id):
        if friend_id not in self._friend_colors:
            self._friend_colors[friend_id] = FRIEND_COLORS[self._color_idx % len(FRIEND_COLORS)]
            self._color_idx += 1
        return self._friend_colors[friend_id]

    def update_size(self):
        self.cols, self.rows = shutil.get_terminal_size()

    def pick_mood(self):
        moods = list(CATS.keys())
        weights = [3, 3, 2, 2, 1, 1, 3, 2, 1, 2]
        self.mood = random.choices(moods, weights=weights)[0]
        self.mood_timer = random.randint(20, 80)
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
                self.vy = random.uniform(-2, -1)

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

        # mirror pet appears/disappears (only in solo mode)
        if not self.network:
            if random.random() < 0.003:
                if self.mirror_pet is None:
                    self.mirror_pet = {"timer": random.randint(30, 80)}
                else:
                    self.mirror_pet = None

        # network: send state every 3 ticks
        self._net_tick += 1
        if self.network and self._net_tick % 3 == 0:
            # normalize position to 0-1 range so different terminal sizes work
            self.network.send_state({
                "name": self.name,
                "x": self.x / max(self.cols, 1),
                "y": self.y / max(self.rows, 1),
                "mood": self.mood,
                "color": self.color_fg,
                "frame": self.frame,
            })

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

        # draw friend pets from network
        if self.network:
            peers = self.network.get_peers()
            roster = self.network.get_roster()
            for pid, state in peers.items():
                # map normalized coords to our terminal size
                fx = int(state.get("x", 0.5) * self.cols)
                fy = int(state.get("y", 0.5) * self.rows)
                fmood = state.get("mood", "idle")
                fname = state.get("name", roster.get(pid, "???"))
                fc = self._get_friend_color(pid)

                sprite = MINI_MOODS.get(fmood, MINI_CAT)
                for i, line in enumerate(sprite):
                    row = fy + i
                    if 0 < row < self.rows - 1 and 0 < fx < self.cols - len(line):
                        buf.append(f"\033[{row};{fx}H{color(fc, line)}")
                # name tag above friend
                tag = f" {fname} "
                tag_x = fx
                tag_y = fy - 1
                if 0 < tag_y < self.rows and 0 < tag_x < self.cols - len(tag):
                    buf.append(f"\033[{tag_y};{tag_x}H{color(fc, tag)}")

            # draw emotes (floating text that fades)
            emotes = self.network.get_emotes()
            for i, (efrom, echar, _) in enumerate(emotes[-5:]):
                ey = 2 + i
                etxt = f" {efrom}: {echar} "
                ex = self.cols // 2 - len(etxt) // 2
                if 0 < ey < self.rows:
                    buf.append(f"\033[{ey};{ex}H{color(228, etxt)}")

        # draw own pet
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

        # name tag for own pet
        if self.network:
            name_tag = f" {self.name} (you) "
            nx = ix
            ny = iy - 1
            if 0 < ny < self.rows:
                buf.append(f"\033[{ny};{nx}H{color(255, name_tag)}")

        # thought bubble
        if self.thought:
            tx = ix + 10
            ty = iy - 2
            if self.network:
                ty -= 1  # shift up to not overlap name tag
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

        # mirror pet (solo mode only)
        if self.mirror_pet and not self.network:
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
        ]
        if self.network:
            roster = self.network.get_roster()
            n = len(roster)
            names = ", ".join(roster.values())
            conn = "🟢" if self.network.connected else "🔴"
            status_items.append(f"{conn} {n} online: {names}")
        elif self.mirror_pet:
            status_items.append("👥 mirror")

        status = "  ".join(s for s in status_items if s)
        buf.append(f"\033[{self.rows};1H{color(240, status[:self.cols-1])}")

        sys.stdout.write("".join(buf))
        sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(description="Terminal pet — solo or multiplayer!")
    parser.add_argument("--name", "-n", default=None, help="Your pet's name (enables multiplayer)")
    parser.add_argument("--server", "-s", default=None, help="WebSocket server URL (e.g. ws://host:8765)")
    parser.add_argument("--room", "-r", default="default", help="Room to join (default: 'default')")
    args = parser.parse_args()

    network = None
    name = args.name or "cat"

    if args.server:
        try:
            import websockets  # noqa: F401
        except ImportError:
            print("Multiplayer requires websockets: pip install websockets")
            sys.exit(1)
        network = Network(args.server, name, args.room)
        # give it a moment to connect
        time.sleep(0.5)

    setup()
    pet = Pet(name=name, network=network)
    try:
        while True:
            pet.update()
            pet.render()
            time.sleep(0.08)
    except Exception:
        cleanup()

if __name__ == "__main__":
    main()
