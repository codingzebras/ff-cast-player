# FF6 Voice Cast Player

Browser test player for the Final Fantasy VI full-voice-cast MSU-1 patch.

**Play:** https://codingzebras.github.io/ff-cast-player/

1. Open the page and choose your own clean `Final Fantasy III (USA).sfc`
   (US 1.0, SHA-1 `4f37e4274ac3b2ea1bedb08aa149d8fc5bb676e7`).
2. Press **Play**, then choose **New Game**.

**No game ROM is included here.** The page verifies your ROM and applies the voice
patch in your browser; the ROM never leaves your device.

Contents (generated, do not edit by hand): `index.html` + `player.js` (the page),
`build.json` (patch bytes + track list), `audio/` (voice tracks),
`ejs/` (EmulatorJS 4.2.3, GPL-3.0, and the libretro snes9x core, non-commercial
license). Built by `tools/web-player/build.py` in the main project repo.
