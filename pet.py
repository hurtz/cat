#!/usr/bin/env python3
"""A chaotic little terminal pet that bounces around and does weird stuff.
Run solo or connect to friends with --name and --server flags.
Supports multiple characters, personalities, and demo mode."""

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

# ─── CHARACTER SPRITES ───────────────────────────────────────────────────────

CHARACTERS = {
    "cat": {
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
            [" /\\_/\\  \u2665", "( ^.^ ) \u2665", " > ^ <"],
            [" /\\_/\\ \u2665 ", "( ^.^ )\u2665 ", " > ^ <  "],
        ],
        "dizzy": [
            [" /\\_/\\ ", "( @.@ )", " > ~ < "],
            [" /\\_/\\ ", "( @.@ )", " < ~ > "],
        ],
        "dance": [
            [" /\\_/\\  \u266a", "( ^o^ ) \u266a", " \\> ^  "],
            ["\u266a  /\\_/\\ ", "\u266a ( ^o^ )", "   ^ </ "],
        ],
        "eat": [
            [" /\\_/\\    ", "( o.o )\U0001F41F", " > ^ <   "],
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
    },
    "dog": {
        "idle": [
            [" /^ ^\\  ", "( o.o ) ", " ( Y )  "],
            [" /^ ^\\  ", "( o.o ) ", "  (Y)   "],
        ],
        "happy": [
            [" /^ ^\\  ", "( ^.^ ) ", " ( Y )  "],
            [" /^ ^\\  ", "( ^o^ ) ", "  (Y)   "],
        ],
        "sleepy": [
            [" /^ ^\\  ", "( -.- ) ", " ( Y ) z"],
            [" /^ ^\\  ", "( -.- ) ", " ( Y )zZ"],
        ],
        "excited": [
            [" /^ ^\\  ", "( O.O ) ", " ( Y )  "],
            [" /^ ^\\  ", "( O.O ) ", "  (Y)   "],
        ],
        "love": [
            [" /^ ^\\  \u2665", "( ^.^ )  ", " ( Y )   "],
            [" /^ ^\\   ", "( ^.^ ) \u2665", " ( Y )   "],
        ],
        "dizzy": [
            [" /^ ^\\  ", "( @.@ ) ", " ( Y )  "],
            [" /^ ^\\  ", "( @.@ ) ", "  (Y)   "],
        ],
        "dance": [
            [" /^ ^\\  \u266a", "( ^o^ )  ", " \\( Y )  "],
            ["\u266a /^ ^\\  ", " ( ^o^ ) ", "  ( Y )/ "],
        ],
        "eat": [
            [" /^ ^\\   ", "( o.o )~ ", " ( Y )   "],
            [" /^ ^\\  ", "( ^.^ ) ", " ( Y )  "],
        ],
        "pounce": [
            [" /^ ^\\     ", "( O.O )    ", " />   <\\   "],
            ["     /^ ^\\ ", "    ( >.< )", "    /> <\\  "],
        ],
        "spin": [
            [" /^ ^\\  ", "( o.o ) ", " ( Y )  "],
            [" \\^ ^/  ", "( o.o ) ", " ( Y )  "],
            [" /^ ^\\  ", ") o.o ( ", " ( Y )  "],
            [" /^ ^\\  ", "( o.o ) ", " ( Y )  "],
        ],
    },
    "bunny": {
        "idle": [
            [" (\\ /) ", " ( . .)", "c(\")(\")" ],
            [" (\\ /) ", " ( . .)", " (\")(\")" ],
        ],
        "happy": [
            [" (\\ /) ", " ( ^.^)", "c(\")(\")" ],
            [" (\\ /) ", " ( ^o^)", " (\")(\")" ],
        ],
        "sleepy": [
            [" (\\ /) ", " ( -.-)", "c(\")(\") z" ],
            [" (\\ /) ", " ( -.-)", "c(\")(\")zZ" ],
        ],
        "excited": [
            [" (\\ /) ", " ( O.O)", "c(\")(\")" ],
            [" (\\ /) ", " ( O.O)", " (\")(\")" ],
        ],
        "love": [
            [" (\\ /) \u2665", " ( ^.^) ", "c(\")(\") " ],
            [" (\\ /)  ", " ( ^.^)\u2665", "c(\")(\") " ],
        ],
        "dizzy": [
            [" (\\ /) ", " ( @.@)", "c(\")(\")" ],
            [" (\\ /) ", " ( @.@)", " (\")(\")" ],
        ],
        "dance": [
            [" (\\ /) \u266a", " ( ^o^) ", "\\(\")(\")" ],
            ["\u266a(\\ /) ", " ( ^o^)", " (\")(\")/" ],
        ],
        "eat": [
            [" (\\ /) ", " ( o.o)~", "c(\")(\") " ],
            [" (\\ /) ", " ( ^.^) ", "c(\")(\")" ],
        ],
        "pounce": [
            [" (\\ /)    ", " ( O.O)   ", "c(\")(\")   " ],
            ["    (\\ /) ", "   ( >.<) ", "   c(\")(\")" ],
        ],
        "spin": [
            [" (\\ /) ", " ( o.o)", "c(\")(\")" ],
            [" (/ \\) ", "(o.o ) ", "(\")(\")" ],
        ],
    },
    "fox": {
        "idle": [
            [" /\\   /\\", "( o . o )", " >  w  < "],
            [" /\\   /\\", "( o . o )", "  > w <  "],
        ],
        "happy": [
            [" /\\   /\\", "( ^ . ^ )", " >  w  < "],
            [" /\\   /\\", "( ^ . ^ )", "  > w <  "],
        ],
        "sleepy": [
            [" /\\   /\\", "( - . - )", " >  w  < z"],
            [" /\\   /\\", "( - . - )", " >  w  <zZ"],
        ],
        "excited": [
            [" /\\   /\\", "( O . O )", " >  w  < "],
            [" /\\   /\\", "( O . O )", "  > w <  "],
        ],
        "love": [
            [" /\\   /\\ \u2665", "( ^ . ^ )  ", " >  w  <   "],
            [" /\\   /\\  ", "( ^ . ^ ) \u2665", " >  w  <   "],
        ],
        "dizzy": [
            [" /\\   /\\", "( @ . @ )", " >  ~ < "],
            [" /\\   /\\", "( @ . @ )", " < ~  > "],
        ],
        "dance": [
            [" /\\   /\\ \u266a", "( ^ . ^ )  ", " \\> w    "],
            ["\u266a /\\   /\\ ", "  ( ^ . ^ )", "    w </  "],
        ],
        "eat": [
            [" /\\   /\\  ", "( o . o )~", " >  w  <  "],
            [" /\\   /\\ ", "( ^ . ^ )", " >  w  < "],
        ],
        "pounce": [
            [" /\\   /\\     ", "( O . O )    ", " />     <\\   "],
            ["      /\\   /\\", "     ( >.< ) ", "     />  <\\  "],
        ],
        "spin": [
            [" /\\   /\\", "( o . o )", " >  w  < "],
            [" \\/   \\/", "( o . o )", " >  w  < "],
            [" /\\   /\\", ") o . o (", " <  w  > "],
            [" /\\   /\\", "( o . o )", " >  m  < "],
        ],
    },
    "bear": {
        "idle": [
            ["\u0295 \u2022\u1d25\u2022 \u0294", "( . . ) ", " > ~ <  "],
            ["\u0295 \u2022\u1d25\u2022 \u0294", "( . . ) ", "  > <   "],
        ],
        "happy": [
            ["\u0295 \u2022\u1d25\u2022 \u0294", "( ^.^ ) ", " > ~ <  "],
            ["\u0295 \u2022\u1d25\u2022 \u0294", "( ^o^ ) ", "  > <   "],
        ],
        "sleepy": [
            ["\u0295 \u2022\u1d25\u2022 \u0294", "( -.- ) ", " > ~ < z"],
            ["\u0295 \u2022\u1d25\u2022 \u0294", "( -.- ) ", " > ~ <zZ"],
        ],
        "excited": [
            ["\u0295 \u2022\u1d25\u2022 \u0294", "( O.O ) ", " > ~ <  "],
            ["\u0295 \u2022\u1d25\u2022 \u0294", "( O.O ) ", "  > <   "],
        ],
        "love": [
            ["\u0295 \u2022\u1d25\u2022 \u0294\u2665", "( ^.^ )  ", " > ~ <   "],
            ["\u0295 \u2022\u1d25\u2022 \u0294 ", "( ^.^ )\u2665 ", " > ~ <   "],
        ],
        "dizzy": [
            ["\u0295 \u2022\u1d25\u2022 \u0294", "( @.@ ) ", " > ~ <  "],
            ["\u0295 \u2022\u1d25\u2022 \u0294", "( @.@ ) ", "  > <   "],
        ],
        "dance": [
            ["\u0295 \u2022\u1d25\u2022 \u0294\u266a", "( ^o^ )  ", " \\> ~    "],
            ["\u266a\u0295 \u2022\u1d25\u2022 \u0294", "  ( ^o^ )", "    ~ </ "],
        ],
        "eat": [
            ["\u0295 \u2022\u1d25\u2022 \u0294 ", "( o.o )~ ", " > ~ <   "],
            ["\u0295 \u2022\u1d25\u2022 \u0294", "( ^.^ ) ", " > ~ <  "],
        ],
        "pounce": [
            ["\u0295 \u2022\u1d25\u2022 \u0294    ", "( O.O )    ", " />    <\\   "],
            ["    \u0295 \u2022\u1d25\u2022 \u0294", "    ( >.< )", "    /> <\\  "],
        ],
        "spin": [
            ["\u0295 \u2022\u1d25\u2022 \u0294", "( o.o ) ", " > ~ <  "],
            ["\u0294 \u2022\u1d25\u2022 \u0295", "( o.o ) ", " > ~ <  "],
            ["\u0295 \u2022\u1d25\u2022 \u0294", ") o.o ( ", " < ~ >  "],
            ["\u0295 \u2022\u1d25\u2022 \u0294", "( o.o ) ", " > ~ <  "],
        ],
    },
    "ghost": {
        "idle": [
            ["  .-.  ", " (o o) ", " | O | ", "  ^^^  "],
            ["  .-.  ", " (o o) ", " | o | ", "  ^^^  "],
        ],
        "happy": [
            ["  .-.  ", " (^ ^) ", " | O | ", "  ^^^  "],
            ["  .-.  ", " (^ ^) ", " | o | ", "  ^^^  "],
        ],
        "sleepy": [
            ["  .-.  ", " (- -) ", " | o | ", "  ^^^ z"],
            ["  .-.  ", " (- -) ", " | o | ", "  ^^^zZ"],
        ],
        "excited": [
            ["  .-.  ", " (O O) ", " | O | ", "  ^^^  "],
            ["  .-.  ", " (O O) ", " | o | ", "  ^^^  "],
        ],
        "love": [
            ["  .-.  \u2665", " (^ ^)  ", " | O |  ", "  ^^^   "],
            ["  .-.   ", " (^ ^) \u2665", " | O |  ", "  ^^^   "],
        ],
        "dizzy": [
            ["  .-.  ", " (@ @) ", " | ~ | ", "  ^^^  "],
            ["  .-.  ", " (@ @) ", " | ~ | ", "  ^^^  "],
        ],
        "dance": [
            ["  .-. \u266a", " (^ ^) ", "\\| O | ", "  ^^^  "],
            ["\u266a .-.  ", " (^ ^) ", " | O |/", "  ^^^  "],
        ],
        "eat": [
            ["  .-.  ", " (o o) ", " | O |~", "  ^^^  "],
            ["  .-.  ", " (^ ^) ", " | O | ", "  ^^^  "],
        ],
        "pounce": [
            ["  .-.      ", " (O O)     ", " | O |     ", "  ^^^      "],
            ["       .-. ", "      (>.<)", "      | O |", "       ^^^ "],
        ],
        "spin": [
            ["  .-.  ", " (o o) ", " | O | ", "  ^^^  "],
            ["  .-.  ", " (o o) ", " | O | ", "  vvv  "],
            ["  .-.  ", " )o o( ", " | O | ", "  ^^^  "],
            ["  .-.  ", " (o o) ", " | O | ", "  ^^^  "],
        ],
    },
    "robot": {
        "idle": [
            [" [===] ", " |o o| ", " |___| ", "  d b  "],
            [" [===] ", " |o o| ", " |___| ", "  d b  "],
        ],
        "happy": [
            [" [===] ", " |^.^| ", " |___| ", "  d b  "],
            [" [===] ", " |^o^| ", " |___| ", "  d b  "],
        ],
        "sleepy": [
            [" [===] ", " |-.-| ", " |___| ", "  d b z"],
            [" [===] ", " |-.-| ", " |___| ", "  d bzZ"],
        ],
        "excited": [
            [" [===] ", " |O.O| ", " |___| ", "  d b  "],
            [" [===] ", " |O O| ", " |___| ", "  d b  "],
        ],
        "love": [
            [" [===] \u2665", " |^.^|  ", " |___|  ", "  d b   "],
            [" [===]  ", " |^.^| \u2665", " |___|  ", "  d b   "],
        ],
        "dizzy": [
            [" [===] ", " |@.@| ", " |___| ", "  d b  "],
            [" [===] ", " |@.@| ", " |___| ", "  d b  "],
        ],
        "dance": [
            [" [===] \u266a", "\\|^o^|  ", " |___|  ", "  d b   "],
            ["\u266a[===]  ", " |^o^|/ ", " |___|  ", "  d b   "],
        ],
        "eat": [
            [" [===] ", " |o.o|~", " |___| ", "  d b  "],
            [" [===] ", " |^.^| ", " |___| ", "  d b  "],
        ],
        "pounce": [
            [" [===]     ", " |O.O|     ", " |___|     ", "  d b      "],
            ["      [===]", "     |>.<| ", "     |___| ", "      d b  "],
        ],
        "spin": [
            [" [===] ", " |o o| ", " |___| ", "  d b  "],
            [" [===] ", " |o o| ", " |___| ", "  q p  "],
            [" [===] ", " |o o| ", " |___| ", "  d b  "],
            [" [===] ", " |o o| ", " |___| ", "  d b  "],
        ],
    },
}

# ─── MINI SPRITES (for network friend rendering) ────────────────────────────

MINI_SPRITES = {
    "cat": {
        "idle":    [" /\\_/\\", "( o.o)", " > < "],
        "happy":   [" /\\_/\\", "( ^.^)", " > < "],
        "sleepy":  [" /\\_/\\", "( -.-)","  zZz "],
        "excited": [" /\\_/\\", "( O.O)", " > < "],
        "love":    [" /\\_/\\", "( ^.^)", "  \u2665\u2665  "],
        "dizzy":   [" /\\_/\\", "( @.@)", " > < "],
        "dance":   [" /\\_/\\", "( ^o^)", "  \u266a\u266a  "],
        "eat":     [" /\\_/\\", "( o.o)", " ~\U0001F41F "],
        "pounce":  [" /\\_/\\", "( >.<)", " /> <\\"],
        "spin":    [" /\\_/\\", "( o.o)", " > < "],
    },
    "dog": {
        "idle":    [" /^ ^\\", "( o.o)", " (Y) "],
        "happy":   [" /^ ^\\", "( ^.^)", " (Y) "],
        "sleepy":  [" /^ ^\\", "( -.-)", " zZz "],
        "excited": [" /^ ^\\", "( O.O)", " (Y) "],
        "love":    [" /^ ^\\", "( ^.^)", "  \u2665\u2665 "],
        "dizzy":   [" /^ ^\\", "( @.@)", " (Y) "],
        "dance":   [" /^ ^\\", "( ^o^)", "  \u266a\u266a "],
        "eat":     [" /^ ^\\", "( o.o)", " (Y)~"],
        "pounce":  [" /^ ^\\", "( >.<)", " /> <"],
        "spin":    [" /^ ^\\", "( o.o)", " (Y) "],
    },
    "bunny": {
        "idle":    ["(\\ /)", "( . )", "(\")(\")"],
        "happy":   ["(\\ /)", "( ^.^)", "(\")(\")"],
        "sleepy":  ["(\\ /)", "( -.-)", " zZz  "],
        "excited": ["(\\ /)", "( O.O)", "(\")(\")"],
        "love":    ["(\\ /)", "( ^.^)", " \u2665\u2665  "],
        "dizzy":   ["(\\ /)", "( @.@)", "(\")(\")"],
        "dance":   ["(\\ /)", "( ^o^)", " \u266a\u266a  "],
        "eat":     ["(\\ /)", "( o.o)", "(\")~"],
        "pounce":  ["(\\ /)", "( >.<)", "(\")(\")"],
        "spin":    ["(\\ /)", "( o.o)", "(\")(\")"],
    },
    "fox": {
        "idle":    ["/\\  /\\", "( o.o)", "> w < "],
        "happy":   ["/\\  /\\", "( ^.^)", "> w < "],
        "sleepy":  ["/\\  /\\", "( -.-)", " zZz  "],
        "excited": ["/\\  /\\", "( O.O)", "> w < "],
        "love":    ["/\\  /\\", "( ^.^)", " \u2665\u2665  "],
        "dizzy":   ["/\\  /\\", "( @.@)", "> ~ < "],
        "dance":   ["/\\  /\\", "( ^o^)", " \u266a\u266a  "],
        "eat":     ["/\\  /\\", "( o.o)", "> w ~"],
        "pounce":  ["/\\  /\\", "( >.<)", "/> < "],
        "spin":    ["/\\  /\\", "( o.o)", "> w < "],
    },
    "bear": {
        "idle":    ["\u0295\u2022\u1d25\u2022\u0294", "( . .)", "> ~ <"],
        "happy":   ["\u0295\u2022\u1d25\u2022\u0294", "( ^.^)", "> ~ <"],
        "sleepy":  ["\u0295\u2022\u1d25\u2022\u0294", "( -.-)", " zZz "],
        "excited": ["\u0295\u2022\u1d25\u2022\u0294", "( O.O)", "> ~ <"],
        "love":    ["\u0295\u2022\u1d25\u2022\u0294", "( ^.^)", " \u2665\u2665  "],
        "dizzy":   ["\u0295\u2022\u1d25\u2022\u0294", "( @.@)", "> ~ <"],
        "dance":   ["\u0295\u2022\u1d25\u2022\u0294", "( ^o^)", " \u266a\u266a  "],
        "eat":     ["\u0295\u2022\u1d25\u2022\u0294", "( o.o)", "> ~ ~"],
        "pounce":  ["\u0295\u2022\u1d25\u2022\u0294", "( >.<)", "/> < "],
        "spin":    ["\u0295\u2022\u1d25\u2022\u0294", "( o.o)", "> ~ <"],
    },
    "ghost": {
        "idle":    [" .-. ", "(o o)", "| O |", " ^^^ "],
        "happy":   [" .-. ", "(^ ^)", "| O |", " ^^^ "],
        "sleepy":  [" .-. ", "(- -)", "| o |", " zZz "],
        "excited": [" .-. ", "(O O)", "| O |", " ^^^ "],
        "love":    [" .-. ", "(^ ^)", " \u2665\u2665  ", " ^^^ "],
        "dizzy":   [" .-. ", "(@ @)", "| ~ |", " ^^^ "],
        "dance":   [" .-. ", "(^ ^)", "| O |", " \u266a\u266a  "],
        "eat":     [" .-. ", "(o o)", "| O~|", " ^^^ "],
        "pounce":  [" .-. ", "(>.<)", "| O |", " ^^^ "],
        "spin":    [" .-. ", "(o o)", "| O |", " ^^^ "],
    },
    "robot": {
        "idle":    ["[===]", "|o o|", "|___|", " d b "],
        "happy":   ["[===]", "|^.^|", "|___|", " d b "],
        "sleepy":  ["[===]", "|-.-|", "|___|", " zZz "],
        "excited": ["[===]", "|O.O|", "|___|", " d b "],
        "love":    ["[===]", "|^.^|", "| \u2665 |", " d b "],
        "dizzy":   ["[===]", "|@.@|", "|___|", " d b "],
        "dance":   ["[===]", "|^o^|", "|___|", " \u266a\u266a  "],
        "eat":     ["[===]", "|o.o|", "|_~_|", " d b "],
        "pounce":  ["[===]", "|>.<|", "|___|", " d b "],
        "spin":    ["[===]", "|o o|", "|___|", " d b "],
    },
}

# ─── PERSONALITIES ───────────────────────────────────────────────────────────

PERSONALITIES = {
    "default": {
        "energy": 1.0,
        "chaos": 0.5,
        "social": 0.5,
        "sleep_chance": 1.0,
        "dance_chance": 1.0,
        "custom_thoughts": [],
        "mood_weights": None,  # use default weights
    },
    "jason": {
        "energy": 0.8,
        "chaos": 0.6,
        "social": 0.8,
        "sleep_chance": 0.5,
        "dance_chance": 1.2,
        "custom_thoughts": [
            "shipping another app...",
            "bias toward action",
            "just build it",
            "what if I mass-produced this?",
            "claude, handle it",
            "idea factory mode: ON",
            "one more deploy...",
            "the terminal is my canvas",
        ],
        "mood_weights": [3, 4, 1, 3, 2, 1, 4, 2, 2, 2],
    },
    "chill": {
        "energy": 0.4,
        "chaos": 0.2,
        "social": 0.3,
        "sleep_chance": 3.0,
        "dance_chance": 0.5,
        "custom_thoughts": [
            "vibes only...",
            "no rush",
            "peaceful af",
            "just existing",
            "the breeze is nice...",
            "*deep breath*",
        ],
        "mood_weights": [4, 3, 5, 1, 2, 1, 1, 1, 0, 0],
    },
    "chaotic": {
        "energy": 1.5,
        "chaos": 1.0,
        "social": 0.7,
        "sleep_chance": 0.2,
        "dance_chance": 2.0,
        "custom_thoughts": [
            "LEEROY JENKINS",
            "hold my beer",
            "what's the worst that could happen?",
            "yeet!",
            "this is fine \U0001F525",
            "CHAOS REIGNS",
            "no regrets!",
        ],
        "mood_weights": [1, 2, 0, 4, 1, 2, 4, 2, 3, 3],
    },
    "sleepy": {
        "energy": 0.2,
        "chaos": 0.1,
        "social": 0.2,
        "sleep_chance": 5.0,
        "dance_chance": 0.2,
        "custom_thoughts": [
            "five more minutes...",
            "is it bedtime?",
            "*yawns*",
            "dreams of fish...",
            "so... tired...",
            "pillow... need pillow...",
        ],
        "mood_weights": [2, 1, 8, 0, 1, 1, 0, 1, 0, 0],
    },
    "hyper": {
        "energy": 1.8,
        "chaos": 0.8,
        "social": 0.9,
        "sleep_chance": 0.1,
        "dance_chance": 3.0,
        "custom_thoughts": [
            "GOTTA GO FAST",
            "can't stop won't stop",
            "MAXIMUM OVERDRIVE",
            "!!!!!!!!",
            "ZOOM ZOOM ZOOM",
            "MORE SPEED",
            "I AM SPEED",
        ],
        "mood_weights": [1, 3, 0, 5, 1, 1, 5, 1, 3, 3],
    },
    "mysterious": {
        "energy": 0.6,
        "chaos": 0.5,
        "social": 0.2,
        "sleep_chance": 1.0,
        "dance_chance": 0.5,
        "custom_thoughts": [
            "...",
            "you didn't see anything",
            "I know things",
            "*stares into void*",
            "the prophecy...",
            "secrets within secrets",
            "*vanishes briefly*",
            "the shadows whisper...",
        ],
        "mood_weights": [4, 1, 2, 1, 1, 3, 1, 1, 2, 2],
    },
}

# ─── STANDARD THOUGHT BUBBLES ───────────────────────────────────────────────

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

TRAILS = ["\u00b7", "\u2726", "\u2605", "\u2666", "\u2022", "~", "\u22c6", "\u2727", "\u2218", "\u266a"]

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


# ─── HELPER: get sprites for a character ─────────────────────────────────────

def get_character_sprites(character):
    """Return the full sprite dict for a character, falling back to cat."""
    return CHARACTERS.get(character, CHARACTERS["cat"])

def get_mini_sprites(character):
    """Return the mini sprite dict for a character, falling back to cat."""
    return MINI_SPRITES.get(character, MINI_SPRITES["cat"])

def get_sprite_frame(character, mood, frame_idx):
    """Get a specific animation frame, falling back to idle if mood not available."""
    sprites = get_character_sprites(character)
    if mood not in sprites:
        mood = "idle"
    frames = sprites[mood]
    return frames[frame_idx % len(frames)]

def get_personality(name):
    """Return a personality dict, falling back to default."""
    return PERSONALITIES.get(name, PERSONALITIES["default"])


class Pet:
    def __init__(self, name="cat", network=None, character="cat", personality="default"):
        self.name = name
        self.network = network
        self.character = character
        self.personality_name = personality
        self.personality = get_personality(personality)
        self.sprites = get_character_sprites(character)
        self.cols, self.rows = shutil.get_terminal_size()
        self.x = self.cols // 2
        self.y = self.rows // 2
        energy = self.personality["energy"]
        self.vx = random.choice([-1, 1]) * random.uniform(0.6, 1.2) * energy
        self.vy = random.choice([-1, 1]) * random.uniform(0.3, 0.6) * energy
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

    def _get_mood_weights(self):
        """Get mood weights, influenced by personality."""
        p = self.personality
        if p["mood_weights"]:
            return list(p["mood_weights"])
        # default weights: idle, happy, sleepy, excited, love, dizzy, dance, eat, pounce, spin
        base = [3, 3, 2, 2, 1, 1, 3, 2, 1, 2]
        # adjust for personality traits
        base[2] = max(1, int(base[2] * p["sleep_chance"]))   # sleepy
        base[6] = max(1, int(base[6] * p["dance_chance"]))   # dance
        return base

    def pick_mood(self):
        moods = list(self.sprites.keys())
        # ensure we have weights for all moods; use base moods list
        base_moods = ["idle", "happy", "sleepy", "excited", "love", "dizzy", "dance", "eat", "pounce", "spin"]
        weights = self._get_mood_weights()
        # if character is missing some moods, filter
        available_moods = []
        available_weights = []
        for m, w in zip(base_moods, weights):
            if m in self.sprites:
                available_moods.append(m)
                available_weights.append(w)
        if not available_moods:
            available_moods = ["idle"]
            available_weights = [1]
        self.mood = random.choices(available_moods, weights=available_weights)[0]
        self.mood_timer = random.randint(30, 120)

        energy = self.personality["energy"]
        if self.mood == "excited":
            self.vx = random.choice([-1, 1]) * random.uniform(1.2, 1.8) * energy
            self.vy = random.choice([-1, 1]) * random.uniform(0.6, 1.2) * energy
        elif self.mood == "sleepy":
            self.vx = 0
            self.vy = 0
        elif self.mood == "dance":
            self.rainbow_mode = True
        elif self.mood == "pounce":
            self.vx = random.choice([-1, 1]) * random.uniform(1.8, 2.4) * energy
            self.vy = random.choice([-1, 1]) * random.uniform(0.8, 1.2) * energy

    def add_particles(self, kind="sparkle"):
        for _ in range(random.randint(3, 8)):
            self.particles.append({
                "x": self.x + random.randint(-2, 8),
                "y": self.y + random.randint(-1, 3),
                "vx": random.uniform(-0.9, 0.9),
                "vy": random.uniform(-0.9, 0.3),
                "life": random.randint(5, 15),
                "char": random.choice(["\u2726", "\u2605", "\u00b7", "\u2665", "\u2727", "\u22c6", "\u266a", "~", "\u00b0", "\u2218"]),
                "color": random.randint(1, 231),
            })

    def _get_thoughts(self):
        """Return combined thought list: standard + personality-specific."""
        thoughts = list(THOUGHT_BUBBLES)
        thoughts.extend(self.personality["custom_thoughts"])
        return thoughts

    def update(self):
        self.tick += 1
        self.update_size()
        energy = self.personality["energy"]
        chaos = self.personality["chaos"]

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
                self.thought = random.choice(self._get_thoughts())
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

        # trail toggle (chaos-influenced)
        if random.random() < 0.01 * chaos:
            self.trail_on = not self.trail_on

        # random velocity changes (chaos-influenced)
        if random.random() < 0.05 * chaos and self.mood != "sleepy":
            self.vx += random.choice([-0.6, 0, 0.6]) * energy
            self.vy += random.choice([-0.3, 0, 0.3]) * energy
            self.vx = max(-2.4 * energy, min(2.4 * energy, self.vx))
            self.vy = max(-1.2 * energy, min(1.2 * energy, self.vy))

        # gravity mode toggle (chaos-influenced)
        if random.random() < 0.005 * chaos:
            self.gravity_mode = not self.gravity_mode

        if self.gravity_mode and self.mood != "sleepy":
            self.vy += 0.18
            self.vy = min(1.2 * energy, self.vy)

        # movement
        if self.trail_on:
            self.trail.append((int(self.x), int(self.y), random.choice(TRAILS), self.color_fg))
            if len(self.trail) > 30:
                self.trail.pop(0)

        self.x += self.vx
        self.y += self.vy

        # bounce off walls
        cur_frame = get_sprite_frame(self.character, self.mood, self.frame)
        pet_w = max(len(line) for line in cur_frame)
        pet_h = len(cur_frame)

        if self.x <= 1:
            self.x = 1
            self.vx = abs(self.vx) if self.vx != 0 else random.uniform(0.6, 1.2) * energy
            self.add_particles()
        if self.x >= self.cols - pet_w - 1:
            self.x = self.cols - pet_w - 1
            self.vx = -abs(self.vx) if self.vx != 0 else random.uniform(-1.2, -0.6) * energy
            self.add_particles()
        if self.y <= 1:
            self.y = 1
            self.vy = abs(self.vy) if self.vy != 0 else random.uniform(0.3, 0.6) * energy
        if self.y >= self.rows - pet_h - 1:
            self.y = self.rows - pet_h - 1
            self.vy = -abs(self.vy) if self.vy != 0 else random.uniform(-0.6, -0.3) * energy
            if self.gravity_mode:
                self.vy = random.uniform(-1.2, -0.6) * energy

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
        frames = self.sprites.get(self.mood, self.sprites["idle"])
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
                "character": self.character,
                "personality": self.personality_name,
            })

    def render(self, buf=None):
        own_buf = buf is None
        if own_buf:
            buf = []
            buf.append("\033[2J")  # clear screen

        # draw stars (only if we own the buffer)
        if own_buf:
            star_chars = [".", "\u00b7", "*", "\u2726", "\u22c6"]
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
                fchar = state.get("character", "cat")

                mini = get_mini_sprites(fchar)
                sprite = mini.get(fmood, mini.get("idle", mini[list(mini.keys())[0]]))
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
        frame = get_sprite_frame(self.character, self.mood, self.frame)
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
            self._render_thought(buf, ix, iy)

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

        # status bar (only if we own the buffer)
        if own_buf:
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

    def _render_thought(self, buf, ix, iy, offset_y=0):
        """Render a thought bubble for this pet."""
        tx = ix + 10
        ty = iy - 2 + offset_y
        if self.network:
            ty -= 1
        if ty < 1: ty = iy + 4
        thought_text = self.thought
        if tx + len(thought_text) + 4 > self.cols:
            tx = ix - len(thought_text) - 4
        if tx < 1: tx = 1
        bubble = f"\u256d{'\u2500' * (len(thought_text) + 2)}\u256e"
        text   = f"\u2502 {thought_text} \u2502"
        bottom = f"\u2570{'\u2500' * (len(thought_text) + 2)}\u256f"
        tc = random.choice([183, 189, 195, 225, 219]) if self.rainbow_mode else 250
        if 0 < ty < self.rows - 3:
            buf.append(f"\033[{ty};{tx}H{color(tc, bubble)}")
            buf.append(f"\033[{ty+1};{tx}H{color(tc, text)}")
            buf.append(f"\033[{ty+2};{tx}H{color(tc, bottom)}")


# ─── DEMO MODE ───────────────────────────────────────────────────────────────

class DemoPet:
    """A simplified pet for demo mode — independent bouncing, thoughts, moods."""
    def __init__(self, name, character, personality_name, color_fg, cols, rows):
        self.name = name
        self.character = character
        self.personality_name = personality_name
        self.personality = get_personality(personality_name)
        self.sprites = get_character_sprites(character)
        self.color_fg = color_fg
        self.cols = cols
        self.rows = rows
        energy = self.personality["energy"]
        self.x = random.uniform(5, cols - 15)
        self.y = random.uniform(3, rows - 8)
        self.vx = random.choice([-1, 1]) * random.uniform(0.4, 0.8) * energy
        self.vy = random.choice([-1, 1]) * random.uniform(0.2, 0.5) * energy
        self.mood = "idle"
        self.mood_timer = random.randint(30, 120)
        self.frame = 0
        self.tick = 0
        self.thought = None
        self.thought_timer = random.randint(5, 30)
        self.rainbow_mode = False

    def _get_mood_weights(self):
        p = self.personality
        if p["mood_weights"]:
            return list(p["mood_weights"])
        base = [3, 3, 2, 2, 1, 1, 3, 2, 1, 2]
        base[2] = max(1, int(base[2] * p["sleep_chance"]))
        base[6] = max(1, int(base[6] * p["dance_chance"]))
        return base

    def _get_thoughts(self):
        thoughts = list(THOUGHT_BUBBLES)
        thoughts.extend(self.personality["custom_thoughts"])
        return thoughts

    def update(self, cols, rows):
        self.cols = cols
        self.rows = rows
        self.tick += 1
        energy = self.personality["energy"]
        chaos = self.personality["chaos"]

        # mood
        self.mood_timer -= 1
        if self.mood_timer <= 0:
            old_mood = self.mood
            base_moods = ["idle", "happy", "sleepy", "excited", "love", "dizzy", "dance", "eat", "pounce", "spin"]
            weights = self._get_mood_weights()
            available_moods = []
            available_weights = []
            for m, w in zip(base_moods, weights):
                if m in self.sprites:
                    available_moods.append(m)
                    available_weights.append(w)
            if not available_moods:
                available_moods = ["idle"]
                available_weights = [1]
            self.mood = random.choices(available_moods, weights=available_weights)[0]
            self.mood_timer = random.randint(30, 120)
            if old_mood == "dance":
                self.rainbow_mode = False
            if self.mood == "dance":
                self.rainbow_mode = True
            if self.mood == "sleepy":
                self.vx = 0
                self.vy = 0
            elif self.mood == "excited":
                self.vx = random.choice([-1, 1]) * random.uniform(1.0, 1.5) * energy
                self.vy = random.choice([-1, 1]) * random.uniform(0.5, 1.0) * energy
            elif self.mood == "pounce":
                self.vx = random.choice([-1, 1]) * random.uniform(1.5, 2.0) * energy
                self.vy = random.choice([-1, 1]) * random.uniform(0.6, 1.0) * energy

        # thoughts
        self.thought_timer -= 1
        if self.thought_timer <= 0:
            if random.random() < 0.35:
                self.thought = random.choice(self._get_thoughts())
                self.thought_timer = random.randint(25, 60)
            else:
                self.thought = None
                self.thought_timer = random.randint(10, 30)

        # random velocity nudge
        if random.random() < 0.04 * chaos and self.mood != "sleepy":
            self.vx += random.choice([-0.4, 0, 0.4]) * energy
            self.vy += random.choice([-0.2, 0, 0.2]) * energy
            self.vx = max(-2.0 * energy, min(2.0 * energy, self.vx))
            self.vy = max(-1.0 * energy, min(1.0 * energy, self.vy))

        # move
        self.x += self.vx
        self.y += self.vy

        # bounce
        cur_frame = get_sprite_frame(self.character, self.mood, self.frame)
        pet_w = max(len(line) for line in cur_frame)
        pet_h = len(cur_frame)

        if self.x <= 1:
            self.x = 1
            self.vx = abs(self.vx) if self.vx != 0 else random.uniform(0.4, 0.8) * energy
        if self.x >= self.cols - pet_w - 1:
            self.x = self.cols - pet_w - 1
            self.vx = -abs(self.vx) if self.vx != 0 else random.uniform(-0.8, -0.4) * energy
        if self.y <= 3:
            self.y = 3
            self.vy = abs(self.vy) if self.vy != 0 else random.uniform(0.2, 0.4) * energy
        if self.y >= self.rows - pet_h - 2:
            self.y = self.rows - pet_h - 2
            self.vy = -abs(self.vy) if self.vy != 0 else random.uniform(-0.4, -0.2) * energy

        # frame
        frames = self.sprites.get(self.mood, self.sprites["idle"])
        self.frame = (self.frame + 1) % len(frames)

    def render(self, buf):
        frame = get_sprite_frame(self.character, self.mood, self.frame)
        ix, iy = int(self.x), int(self.y)
        fc = self.color_fg

        for i, line in enumerate(frame):
            row = iy + i
            if 0 < row < self.rows - 1:
                if self.rainbow_mode:
                    rendered = ""
                    for j, ch in enumerate(line):
                        rc = ((self.tick * 3 + j * 7 + i * 13) % 216) + 16
                        rendered += f"\033[38;5;{rc}m{ch}"
                    rendered += "\033[0m"
                    buf.append(f"\033[{row};{ix}H{rendered}")
                else:
                    buf.append(f"\033[{row};{ix}H{color(fc, line)}")

        # name tag
        tag = f" {self.name} ({self.character}) "
        tag_y = iy - 1
        if 0 < tag_y < self.rows and 0 < ix < self.cols - len(tag):
            buf.append(f"\033[{tag_y};{ix}H{color(fc, tag)}")

        # thought bubble
        if self.thought:
            tx = ix + 10
            ty = iy - 3
            if ty < 1: ty = iy + len(frame) + 1
            thought_text = self.thought
            if tx + len(thought_text) + 4 > self.cols:
                tx = ix - len(thought_text) - 4
            if tx < 1: tx = 1
            bubble = f"\u256d{'\u2500' * (len(thought_text) + 2)}\u256e"
            text   = f"\u2502 {thought_text} \u2502"
            bottom = f"\u2570{'\u2500' * (len(thought_text) + 2)}\u256f"
            tc = 250
            if 0 < ty < self.rows - 3 and 0 < tx < self.cols - len(bubble):
                buf.append(f"\033[{ty};{tx}H{color(tc, bubble)}")
                buf.append(f"\033[{ty+1};{tx}H{color(tc, text)}")
                buf.append(f"\033[{ty+2};{tx}H{color(tc, bottom)}")


def run_demo():
    """Run demo mode with 5 pets bouncing around independently."""
    setup()
    cols, rows = shutil.get_terminal_size()

    demo_pets = [
        DemoPet("jason",   "cat",   "jason",      FRIEND_COLORS[0], cols, rows),
        DemoPet("rex",     "dog",   "hyper",      FRIEND_COLORS[1], cols, rows),
        DemoPet("bun",     "bunny", "chill",      FRIEND_COLORS[2], cols, rows),
        DemoPet("sly",     "fox",   "chaotic",    FRIEND_COLORS[3], cols, rows),
        DemoPet("boo",     "ghost", "mysterious", FRIEND_COLORS[4], cols, rows),
    ]

    # background stars
    stars = [(random.randint(0, cols-1), random.randint(0, rows-1)) for _ in range(10)]

    try:
        while True:
            cols, rows = shutil.get_terminal_size()
            buf = ["\033[2J"]

            # stars
            star_chars = [".", "\u00b7", "*", "\u2726", "\u22c6"]
            for sx, sy in stars:
                if 0 < sx < cols and 0 < sy < rows:
                    c = random.choice([240, 245, 250, 255]) if random.random() < 0.1 else 240
                    buf.append(f"\033[{sy};{sx}H{color(c, random.choice(star_chars))}")
            if random.random() < 0.1:
                idx = random.randint(0, len(stars) - 1)
                stars[idx] = (random.randint(0, cols-1), random.randint(0, rows-1))

            # update and render all pets
            for dp in demo_pets:
                dp.update(cols, rows)
                dp.render(buf)

            # status bar
            status = "  DEMO MODE  |  " + "  ".join(
                f"{dp.name}:{dp.mood}" for dp in demo_pets
            )
            buf.append(f"\033[{rows};1H{color(240, status[:cols-1])}")

            sys.stdout.write("".join(buf))
            sys.stdout.flush()
            time.sleep(0.12)
    except Exception:
        cleanup()


# ─── MAIN ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Terminal pet — solo or multiplayer!",
        epilog="Examples:\n"
               "  python3 pet.py                           # solo cat\n"
               "  python3 pet.py -c dog -p hyper            # hyper dog\n"
               "  python3 pet.py --demo                     # demo mode with 5 pets\n"
               "  python3 pet.py -n jason -c cat -p jason -s wss://server:8765\n",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--name", "-n", default=None, help="Your pet's name (enables multiplayer)")
    parser.add_argument("--server", "-s", default=None, help="WebSocket server URL (e.g. ws://host:8765)")
    parser.add_argument("--room", "-r", default="default", help="Room to join (default: 'default')")
    parser.add_argument("--character", "-c", default="cat",
                        choices=list(CHARACTERS.keys()),
                        help="Character type (default: cat)")
    parser.add_argument("--personality", "-p", default="default",
                        choices=list(PERSONALITIES.keys()),
                        help="Personality type (default: default)")
    parser.add_argument("--demo", "-d", action="store_true",
                        help="Demo mode: 5 pets with different characters and personalities")
    args = parser.parse_args()

    if args.demo:
        run_demo()
        return

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
    pet = Pet(name=name, network=network, character=args.character, personality=args.personality)
    try:
        while True:
            pet.update()
            pet.render()
            time.sleep(0.12)
    except Exception:
        cleanup()

if __name__ == "__main__":
    main()
