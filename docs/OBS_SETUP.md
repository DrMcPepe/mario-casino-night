# OBS Setup

## Display Layout

Use the laptop or PC monitor for Dolphin controls and `/admin`. Use OBS Fullscreen Projector on the connected TV.

## Scene 1: Beerio Game

1. Add a Game Capture or Window Capture source for Dolphin.
2. Fit Dolphin to the canvas.
3. Do not add a browser source.

## Scene 2: Casino Dashboard

1. Add a Browser source.
2. Set URL to `http://localhost:5000/tv`.
3. Set width and height to the OBS canvas, normally 1920 by 1080.
4. Enable refresh when scene becomes active.

## Scene 3: Casino Game

1. Duplicate the Beerio Game scene.
2. Add a Browser source above Dolphin.
3. Set URL to `http://localhost:5000/tv?overlay=1&side=right`.
4. Set width and height to 1920 by 1080.
5. Use a transparent browser-source background.

The transparent overlay behaves like a Twitch chat rail on the selected edge. It shows the sportsbook while betting is open, then automatically collapses to a small live-match badge and stacked bar-tab messages during gameplay.

Use `side=left` instead when a game's HUD conflicts with the right edge:

```text
http://localhost:5000/tv?overlay=1&side=left
```

### Two Placement Options

For a true overlay, keep the browser source at 1920 by 1080 above Dolphin. Only the edge rail is drawn; the rest is transparent.

For zero gameplay obstruction, make the browser source 360 by 1080 and place it at the canvas edge. Resize Dolphin to the remaining canvas width. This creates a Twitch-style dedicated sidebar rather than drawing over the game.

## Performance

- Run Dolphin at its stable settings before increasing OBS quality.
- Use 1080p60 output if the PC can maintain it; reduce OBS output to 720p60 if needed.
- Disable the OBS preview after confirming the projector if GPU use is high.
- Test controller latency on the projected TV before guests arrive.
