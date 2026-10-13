// FF6 Voice Cast Player: runs the voice patch in the browser with MSU-1 audio.
//
// Flow: the viewer picks their own clean ROM -> we verify it (SHA-1), apply the
// patch diff from build.json, then start EmulatorJS (snes9x core) and write
// ffvi.sfc + ffvi.msu + ffvi-N.pcm side by side onto the emulator's virtual disk,
// the same layout as the "Play on Emulator (MSU-1)" folder. The ROM never leaves
// the viewer's device; it is kept in IndexedDB only if they ask us to remember it.
//
// EmulatorJS normally loads its core and game through blob: URLs and Web Workers;
// the overrides below load everything from plain files in the main thread instead,
// so the page works under the Artifact viewer's locked-down frame.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const EJS_SRC = ["emulator.js", "nipplejs.js", "shaders.js", "storage.js", "gamepad.js",
                   "GameManager.js", "compression.js"];
  let BUILD = null;          // build.json
  let romBytes = null;       // patched ROM ready to run
  let started = false;

  // ---------- small helpers ----------
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const sha1 = async (bytes) => hex(await crypto.subtle.digest("SHA-1", bytes));
  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("could not load " + src));
    document.head.appendChild(s);
  });
  function setStatus(kind, text) {
    const el = $("rom-status");
    el.dataset.kind = kind;
    el.textContent = text;
  }

  // ---------- IndexedDB: optional "remember my ROM" ----------
  const DB = "ffvi-voice-player", STORE = "rom";
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbDo(mode, fn) {
    try {
      const db = await idb();
      return await new Promise((res, rej) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => res(req && req.result);
        tx.onerror = () => rej(tx.error);
      });
    } catch (e) { return undefined; }
  }
  const remembered = () => idbDo("readonly", (s) => s.get("clean"));
  const remember = (bytes) => idbDo("readwrite", (s) => s.put(bytes, "clean"));
  const forget = () => idbDo("readwrite", (s) => s.delete("clean"));

  // ---------- ROM check + patch ----------
  async function prepareRom(bytes) {
    const p = BUILD.patch;
    if (bytes.length === p.size + 512) bytes = bytes.slice(512);           // copier header
    if (bytes.length !== p.size) {
      throw new Error(`That file is ${bytes.length.toLocaleString()} bytes; the US ROM is ` +
        `${p.size.toLocaleString()} bytes. Pick "Final Fantasy III (USA).sfc".`);
    }
    const h = await sha1(bytes);
    if (h === p.patchedSha1) return { rom: bytes, how: "already-patched" };
    if (h !== p.cleanSha1) {
      throw new Error("This ROM doesn't match the clean US 1.0 “Final Fantasy III (USA)” " +
        "the patch is built for (SHA-1 " + h.slice(0, 12) + "…). Use the copy from the repo's main branch.");
    }
    const out = new Uint8Array(bytes);
    for (const [off, data] of p.runs) {
      for (let i = 0; i < data.length; i += 2) out[off + i / 2] = parseInt(data.substr(i, 2), 16);
    }
    if (await sha1(out) !== p.patchedSha1) throw new Error("Patching failed a self-check. Rebuild the player.");
    return { rom: out, clean: bytes, how: "patched" };
  }

  async function acceptRom(bytes, fromMemory) {
    try {
      const r = await prepareRom(bytes);
      romBytes = r.rom;
      if (r.clean && $("remember").checked && !fromMemory) remember(r.clean);
      setStatus("ok", fromMemory ? "Using the ROM saved on this device. Patched and ready."
        : r.how === "patched" ? "Clean ROM verified and patched. Ready to play."
        : "Patched ROM from this build recognized. Ready to play.");
      $("play").disabled = false;
      $("forget").hidden = !fromMemory;
    } catch (e) {
      romBytes = null;
      $("play").disabled = true;
      setStatus("error", e.message);
    }
  }

  // ---------- voice tracks: WAV -> MSU-1 .pcm ----------
  function wavToPcm(buf, loop) {
    const v = new DataView(buf);
    let o = 12;
    while (o + 8 <= v.byteLength) {
      const id = String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
      const len = v.getUint32(o + 4, true);
      if (id === "data") {
        const pcm = new Uint8Array(8 + len);
        pcm.set([0x4d, 0x53, 0x55, 0x31]);                                // "MSU1"
        new DataView(pcm.buffer).setUint32(4, loop, true);
        pcm.set(new Uint8Array(buf, o + 8, len), 8);
        return pcm;
      }
      o += 8 + len + (len & 1);
    }
    throw new Error("bad wav");
  }

  async function loadTracks(progress) {
    const files = [];
    let done = 0;
    await Promise.all(BUILD.tracks.map(async (t) => {
      const res = await fetch(t.file);
      if (!res.ok) throw new Error("Couldn't download voice track " + t.n);
      files.push([`${BUILD.romName}-${t.n}.pcm`, wavToPcm(await res.arrayBuffer(), t.loop)]);
      progress(++done, BUILD.tracks.length);
    }));
    return files;
  }

  // ---------- EmulatorJS overrides ----------
  function installOverrides(gameFiles) {
    const EJS = window.EmulatorJS.prototype;

    // Core: plain files instead of a 7z bundle unpacked in a worker.
    EJS.downloadGameCore = async function () {
      try {
        this.textElem.innerText = "Loading the SNES core…";
        const legacy = !this.supportsWebgl2;
        this.webgl2Enabled = !legacy;
        const dir = "../ejs/cores/" + (legacy ? "snes9x-legacy/" : "snes9x/");
        const core = await (await fetch(dir + "core.json")).json();
        this.extensions = core.extensions;
        this.coreName = core.name;
        this.repository = core.repo;
        this.defaultCoreOpts = core.options || {};
        this.enableMouseLock = !!(core.options && core.options.supportsMouse);
        this.retroarchOpts = core.retroarchOpts;
        this.saveFileExt = core.save;
        try { this.license = await (await fetch(dir + "license.txt")).text(); } catch (e) { /* optional */ }
        const wasm = new Uint8Array(await (await fetch(dir + "snes9x_libretro.wasm")).arrayBuffer());
        await loadScript(dir + "snes9x_libretro.js");
        this.initModule(wasm, null);
      } catch (e) {
        console.warn(e);
        this.startGameError("Couldn't load the emulator core. Reload the page to try again.");
      }
    };

    // Module: hand the wasm bytes over directly (no blob: URL fetch).
    EJS.initModule = function (wasmData) {
      window.EJS_Runtime({
        noInitialRun: true,
        arguments: [],
        preRun: [],
        postRun: [],
        canvas: this.canvas,
        callbacks: {},
        parent: this.elements.parent,
        print: (m) => { if (this.debug) console.log(m); },
        printErr: (m) => { if (this.debug) console.log(m); },
        totalDependencies: 0,
        wasmBinary: wasmData,
        locateFile: (f) => f,
        getSavExt: () => "." + (this.saveFileExt || "srm"),
      }).then((module) => {
        this.Module = module;
        this.downloadFiles();
      }).catch((e) => {
        console.warn(e);
        this.startGameError("The emulator failed to start in this browser.");
      });
    };

    // Game: write the ROM, the .msu marker and every -N.pcm next to each other.
    EJS.downloadRom = function () {
      const FS = this.gameManager.FS;
      for (const [name, data] of gameFiles) FS.writeFile("/" + name, data);
      this.fileName = BUILD.romName + ".sfc";
      return Promise.resolve();
    };
  }

  async function play() {
    if (started || !romBytes) return;
    started = true;
    $("play").disabled = true;
    $("rom-file").disabled = true;
    try {
      setStatus("busy", "Loading voice tracks…");
      const tracks = await loadTracks((d, n) => setStatus("busy", `Loading voice tracks… ${d} of ${n}`));
      const files = [[BUILD.romName + ".sfc", romBytes], [BUILD.romName + ".msu", new Uint8Array(0)], ...tracks];
      setStatus("busy", "Loading the emulator…");
      for (const f of EJS_SRC) await loadScript("../ejs/src/" + f);
      installOverrides(files);

      $("stage").classList.add("running");
      window.EJS_emulator = new window.EmulatorJS("#game", {
        gameUrl: BUILD.romName + ".sfc",
        gameName: "FF6 Voice Cast",
        dataPath: "../ejs/",
        system: "snes",
        startOnLoad: true,
        threads: false,
        color: "#7e94e6",
        backgroundColor: "#06081a",
        volume: 0.8,
        disableDatabases: true,
        buttonOpts: { netplay: false },
      });
      window.EJS_emulator.on("start", () => setStatus("ok", "Running. Choose New Game to hear the opening narration."));
    } catch (e) {
      console.warn(e);
      started = false;
      $("play").disabled = false;
      $("rom-file").disabled = false;
      setStatus("error", e.message);
    }
  }

  // ---------- page wiring ----------
  function renderTracks() {
    const ol = $("tracks");
    ol.innerHTML = "";
    for (const t of BUILD.tracks) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="tn">${t.n}</span><span class="who"></span><span class="line"></span>` +
        `<span class="where"></span><span class="len"></span>`;
      li.querySelector(".who").textContent = t.speaker;
      li.querySelector(".line").textContent = t.line;
      li.querySelector(".where").textContent = `${t.msg} · ${t.addr}`;
      li.querySelector(".len").textContent = `${t.seconds}s`;
      ol.appendChild(li);
    }
    $("build-id").textContent = BUILD.build || "local";
  }

  async function init() {
    try {
      BUILD = await (await fetch("build.json")).json();
    } catch (e) {
      setStatus("error", "Couldn't load build.json. Rebuild the player with tools/web-player/build.py.");
      return;
    }
    renderTracks();
    $("rom-file").addEventListener("change", async (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (!f) return;
      setStatus("busy", "Checking " + f.name + "…");
      await acceptRom(new Uint8Array(await f.arrayBuffer()), false);
    });
    $("play").addEventListener("click", play);
    $("forget").addEventListener("click", async () => {
      await forget();
      romBytes = null;
      $("play").disabled = true;
      $("forget").hidden = true;
      setStatus("idle", "Saved ROM removed from this device. Choose your ROM file to play.");
    });
    const saved = await remembered();
    if (saved) await acceptRom(new Uint8Array(saved), true);
    else setStatus("idle", "Choose your ROM file to begin.");
  }

  init();
})();
