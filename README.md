# cat

a chaotic ascii cat that bounces around your terminal. play solo or with friends.

## solo mode

```bash
python3 pet.py
```

no dependencies needed.

## multiplayer

```bash
pip install websockets
python3 pet.py --name "yourname" --server wss://YOUR_SERVER_URL
```

everyone's pets show up in each other's terminals, bouncing around with name tags and unique colors.

### options

| flag | description |
|------|-------------|
| `--name` / `-n` | your pet's name |
| `--server` / `-s` | websocket relay server URL |
| `--room` / `-r` | room name (default: "default") |

### host your own server

```bash
pip install websockets
python3 server.py
```

or deploy with Docker / Railway / Fly.io.

## controls

`ctrl+c` to quit. resize your terminal anytime.
