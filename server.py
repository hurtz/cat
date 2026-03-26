#!/usr/bin/env python3
"""WebSocket relay server for multiplayer terminal pets."""

import asyncio, json, time, os
from websockets.asyncio.server import serve

ROOMS = {}  # room_name -> {client_id: {"ws": ws, "state": {...}, "last_seen": time}}

async def handler(ws):
    client_id = None
    room = None
    try:
        async for raw in ws:
            msg = json.loads(raw)

            if msg.get("type") == "join":
                client_id = msg["id"]
                room = msg.get("room", "default")
                name = msg.get("name", "cat")
                if room not in ROOMS:
                    ROOMS[room] = {}
                ROOMS[room][client_id] = {
                    "ws": ws, "state": {"name": name, "mood": "idle", "x": 0, "y": 0, "color": 1, "frame": 0}, "last_seen": time.time()
                }
                # tell everyone in the room about current players
                await broadcast_roster(room)

            elif msg.get("type") == "state" and client_id and room:
                if room in ROOMS and client_id in ROOMS[room]:
                    ROOMS[room][client_id]["state"] = msg["data"]
                    ROOMS[room][client_id]["last_seen"] = time.time()
                    # broadcast all states to the room
                    await broadcast_states(room, client_id)

            elif msg.get("type") == "emote" and client_id and room:
                # broadcast emote to everyone in the room
                await broadcast_emote(room, client_id, msg.get("emote", "♥"))

    except Exception:
        pass
    finally:
        if room and client_id and room in ROOMS:
            ROOMS[room].pop(client_id, None)
            if not ROOMS[room]:
                del ROOMS[room]
            else:
                await broadcast_roster(room)


async def broadcast_roster(room):
    if room not in ROOMS:
        return
    names = {cid: info["state"].get("name", "cat") for cid, info in ROOMS[room].items()}
    msg = json.dumps({"type": "roster", "players": names, "count": len(names)})
    await broadcast(room, msg)


async def broadcast_states(room, sender_id):
    if room not in ROOMS:
        return
    others = {cid: info["state"] for cid, info in ROOMS[room].items() if cid != sender_id}
    # send each client all OTHER pets' states
    for cid, info in list(ROOMS[room].items()):
        peers = {k: v for k, v in ROOMS[room].items() if k != cid}
        peer_states = {k: v["state"] for k, v in peers.items()}
        try:
            await info["ws"].send(json.dumps({"type": "states", "peers": peer_states}))
        except Exception:
            pass


async def broadcast_emote(room, sender_id, emote):
    if room not in ROOMS:
        return
    sender_name = ROOMS[room].get(sender_id, {}).get("state", {}).get("name", "cat")
    msg = json.dumps({"type": "emote", "from": sender_name, "emote": emote})
    await broadcast(room, msg)


async def broadcast(room, msg):
    if room not in ROOMS:
        return
    dead = []
    for cid, info in ROOMS[room].items():
        try:
            await info["ws"].send(msg)
        except Exception:
            dead.append(cid)
    for cid in dead:
        ROOMS[room].pop(cid, None)


async def cleanup_stale():
    """Remove clients that haven't sent updates in 30s."""
    while True:
        await asyncio.sleep(10)
        now = time.time()
        for room in list(ROOMS.keys()):
            stale = [cid for cid, info in ROOMS[room].items() if now - info["last_seen"] > 30]
            for cid in stale:
                try:
                    await ROOMS[room][cid]["ws"].close()
                except Exception:
                    pass
                ROOMS[room].pop(cid, None)
            if not ROOMS[room]:
                del ROOMS[room]


async def main():
    port = int(os.environ.get("PORT", 8765))
    asyncio.create_task(cleanup_stale())
    async with serve(handler, "0.0.0.0", port):
        print(f"pet relay server running on :{port}")
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    asyncio.run(main())
