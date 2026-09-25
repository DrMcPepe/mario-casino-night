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
3. Set URL to `http://localhost:5000/tv?overlay=1`.
4. Set width and height to 1920 by 1080.
5. Use a transparent browser-source background.

The overlay occupies the upper-right edge and a lower bar, leaving the center of Wii Sports visible.

## Performance

- Run Dolphin at its stable settings before increasing OBS quality.
- Use 1080p60 output if the PC can maintain it; reduce OBS output to 720p60 if needed.
- Disable the OBS preview after confirming the projector if GPU use is high.
- Test controller latency on the projected TV before guests arrive.
