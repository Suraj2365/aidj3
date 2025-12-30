/* =========================================
   AUDIO ENGINE & GLOBALS
   ========================================= */
const ctx = new (window.AudioContext || window.webkitAudioContext)();
const mainBus = ctx.createGain();
mainBus.connect(ctx.destination);

// STATE
let playlist = [];
let pendingTrack = null;
let aiActive = false;
let aiInterval = null;

// CONSTANTS
const FADE_TIME = 6; // Seconds for transition

/* =========================================
   DRUM MACHINE (FOR AI REMIXES)
   ========================================= */
const DrumMachine = {
    gain: ctx.createGain(),
    nextNoteTime: 0.0,
    isPlaying: false,
    tempo: 128,
    timerID: null,
    
    init() {
        this.gain.connect(mainBus);
        this.gain.gain.value = 0.4; // Drum volume
    },

    playKick(time) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(this.gain);
        
        osc.frequency.setValueAtTime(150, time);
        osc.frequency.exponentialRampToValueAtTime(0.01, time + 0.5);
        
        gain.gain.setValueAtTime(1, time);
        gain.gain.exponentialRampToValueAtTime(0.01, time + 0.5);
        
        osc.start(time);
        osc.stop(time + 0.5);
        
        // Visual
        document.getElementById('beat-viz').style.background = '#fff';
        setTimeout(()=> document.getElementById('beat-viz').style.background = '#000', 50);
    },

    playHat(time) {
        // Simple noise buffer for hi-hat would go here, 
        // using high osc for simplicity in single file
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.connect(gain);
        gain.connect(this.gain);
        
        // High frequency short burst
        osc.frequency.setValueAtTime(800, time);
        gain.gain.setValueAtTime(0.3, time);
        gain.gain.exponentialRampToValueAtTime(0.01, time + 0.05);
        
        osc.start(time);
        osc.stop(time + 0.05);
    },

    scheduler() {
        // Lookahead
        while (this.nextNoteTime < ctx.currentTime + 0.1) {
            // 4/4 Beat: Kick on 1, Hat on 2, Kick on 3, Hat on 4
            // Simplified: Kick on every beat
            this.playKick(this.nextNoteTime);
            // Off-beat hat
            this.playHat(this.nextNoteTime + (60 / this.tempo) / 2);
            
            this.nextNoteTime += 60.0 / this.tempo;
        }
        this.timerID = setTimeout(() => this.scheduler(), 25);
    },

    start(bpm) {
        if(this.isPlaying) return;
        this.tempo = bpm;
        this.nextNoteTime = ctx.currentTime + 0.05;
        this.isPlaying = true;
        this.scheduler();
        document.getElementById('remix-light').classList.add('active');
    },

    stop() {
        this.isPlaying = false;
        clearTimeout(this.timerID);
        document.getElementById('remix-light').classList.remove('active');
    }
};
DrumMachine.init();

/* =========================================
   DECK CLASS
   ========================================= */
class Deck {
    constructor(id) {
        this.id = id;
        this.el = document.getElementById(`deck-${id.toLowerCase()}`);
        this.canvas = document.getElementById(`viz-${id.toLowerCase()}`);
        this.cCtx = this.canvas.getContext('2d');
        
        // Audio Graph: Source -> Filter -> Gain -> Analyzer -> MainBus
        this.gainNode = ctx.createGain();
        this.filterNode = ctx.createBiquadFilter();
        this.analyser = ctx.createAnalyser();
        
        this.filterNode.connect(this.gainNode);
        this.gainNode.connect(this.analyser);
        this.gainNode.connect(mainBus);
        
        this.source = null;
        this.buffer = null;
        this.meta = null;
        this.isPlaying = false;
        this.startTime = 0;
        this.pausedAt = 0;
    }

    load(buffer, meta) {
        if(this.isPlaying) this.stop();
        this.buffer = buffer;
        this.meta = meta;
        this.pausedAt = 0;
        
        // Reset Filter
        this.filterNode.type = 'lowpass';
        this.filterNode.frequency.value = 22000;

        // UI
        const suffix = this.id.toLowerCase();
        document.getElementById(`title-${suffix}`).innerText = meta.title;
        document.getElementById(`bpm-${suffix}`).innerText = `${meta.bpm} BPM`;
        document.querySelector(`#drop-${suffix} .drag-hint`).style.display = 'none';
    }

    play(timeOffset = 0) {
        if(!this.buffer) return;
        if(ctx.state === 'suspended') ctx.resume();

        this.source = ctx.createBufferSource();
        this.source.buffer = this.buffer;
        this.source.connect(this.filterNode);
        
        this.startTime = ctx.currentTime - timeOffset;
        this.source.start(0, timeOffset);
        this.isPlaying = true;
        this.el.classList.add('playing');
        
        this.source.onended = () => {
            // Only stop if it wasn't stopped manually
            if(ctx.currentTime - this.startTime >= this.buffer.duration) {
                this.isPlaying = false;
                this.el.classList.remove('playing');
                this.pausedAt = 0;
            }
        };

        this.drawViz();
    }

    stop() {
        if(this.source) {
            try { this.source.stop(); } catch(e){}
            this.source = null;
        }
        this.isPlaying = false;
        this.el.classList.remove('playing');
    }

    togglePlay() {
        if(this.isPlaying) {
            this.stop();
            this.pausedAt = ctx.currentTime - this.startTime;
        } else {
            this.play(this.pausedAt);
        }
    }

    volume(val) {
        this.gainNode.gain.setTargetAtTime(parseFloat(val), ctx.currentTime, 0.1);
    }

    // AI EFFECT: Automated Build Up
    triggerBuildUp() {
        const now = ctx.currentTime;
        // High Pass Filter Sweep
        this.filterNode.type = 'highpass';
        this.filterNode.frequency.setValueAtTime(0, now);
        this.filterNode.frequency.exponentialRampToValueAtTime(5000, now + 4); // Rise
        
        // Drop after 4 seconds
        setTimeout(() => {
            this.filterNode.frequency.setValueAtTime(0, ctx.currentTime);
            this.filterNode.type = 'allpass';
            // Trigger visual flash
            this.el.style.borderColor = '#fff';
            setTimeout(()=> this.el.style.borderColor = '#333', 200);
        }, 4000);
    }

    drawViz() {
        if(!this.isPlaying) return;
        const bufferLen = this.analyser.frequencyBinCount;
        const data = new Uint8Array(bufferLen);
        const w = this.canvas.width;
        const h = this.canvas.height;
        const barW = (w / bufferLen) * 2.5;

        const draw = () => {
            if(!this.isPlaying) return;
            requestAnimationFrame(draw);
            this.analyser.getByteFrequencyData(data);
            this.cCtx.fillStyle = '#000';
            this.cCtx.fillRect(0,0,w,h);
            
            let x = 0;
            for(let i=0; i<bufferLen; i++) {
                const barH = data[i] / 255 * h;
                const r = this.id === 'A' ? 255 : 0;
                const b = this.id === 'B' ? 255 : 85;
                this.cCtx.fillStyle = `rgb(${r}, 0, ${b})`;
                this.cCtx.fillRect(x, h - barH, barW, barH);
                x += barW + 1;
            }
        };
        draw();
    }
}

const Decks = {
    A: new Deck('A'),
    B: new Deck('B')
};

// Crossfader
const xFader = document.getElementById('crossfader');
xFader.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    Decks.A.volume(Math.cos(val * 0.5 * Math.PI));
    Decks.B.volume(Math.cos((1.0 - val) * 0.5 * Math.PI));
});

/* =========================================
   AI BRAIN (LOGIC)
   ========================================= */
const AI = {
    checkLoop: null,
    
    toggle() {
        aiActive = !aiActive;
        const btn = document.getElementById('ai-toggle');
        const status = document.getElementById('ai-status-text');
        
        if(aiActive) {
            btn.classList.add('active');
            btn.innerHTML = `<span class="icon">🤖</span> AI RUNNING`;
            status.innerText = "AUTO PILOT";
            status.style.color = "#0f0";
            this.start();
        } else {
            btn.classList.remove('active');
            btn.innerHTML = `<span class="icon">✨</span> ACTIVATE AI`;
            status.innerText = "MANUAL";
            status.style.color = "#fff";
            this.stop();
        }
    },

    start() {
        // Start intelligent monitoring
        this.checkLoop = setInterval(() => this.monitor(), 1000);
        
        // Auto-start if silence
        if(!Decks.A.isPlaying && !Decks.B.isPlaying && playlist.length > 0) {
            this.transitionTo('A', playlist[0]);
        }
    },

    stop() {
        clearInterval(this.checkLoop);
        DrumMachine.stop();
    },

    monitor() {
        // Decide which deck is active
        const activeId = Decks.A.gainNode.gain.value > 0.5 ? 'A' : 'B';
        const activeDeck = Decks[activeId];
        
        if(!activeDeck.isPlaying) return;

        const timeLeft = activeDeck.buffer.duration - (ctx.currentTime - activeDeck.startTime);
        
        // 1. NEAR END? TRANSITION
        if(timeLeft < 15 && timeLeft > 14) {
            const nextId = activeId === 'A' ? 'B' : 'A';
            const nextTrack = this.getRandomTrack();
            if(nextTrack) this.doSmartTransition(activeId, nextId, nextTrack);
        }

        // 2. MID SONG? REMIX
        if(timeLeft > 30 && timeLeft < 60) {
            // Randomly start drum machine for 10 seconds
            if(Math.random() < 0.1 && !DrumMachine.isPlaying) {
                DrumMachine.start(activeDeck.meta.bpm);
                setTimeout(() => DrumMachine.stop(), 8000); // 8 bar loop
            }
        }
    },

    getRandomTrack() {
        if(playlist.length === 0) return null;
        return playlist[Math.floor(Math.random() * playlist.length)];
    },

    doSmartTransition(fromId, toId, trackData) {
        console.log(`AI: Transitioning ${fromId} -> ${toId}`);
        const fromDeck = Decks[fromId];
        const toDeck = Decks[toId];

        // 1. Load Next
        toDeck.load(trackData.buffer, trackData.meta);
        
        // 2. Sync Beat (Simulated via playbackRate if we had true BPM detection)
        // For now, we assume standard house/pop tempos or match raw
        
        // 3. Start silent
        toDeck.volume(0);
        toDeck.play();

        // 4. Smooth Crossfade automation
        const now = ctx.currentTime;
        
        // Fade In Incoming
        toDeck.gainNode.gain.linearRampToValueAtTime(1, now + FADE_TIME);
        
        // Fade Out Outgoing
        fromDeck.gainNode.gain.linearRampToValueAtTime(0, now + FADE_TIME);
        
        // Filter Sweep Outgoing (Low Pass drops down to muffle it)
        fromDeck.filterNode.frequency.setValueAtTime(20000, now);
        fromDeck.filterNode.frequency.exponentialRampToValueAtTime(200, now + FADE_TIME);

        // Update UI Slider
        xFader.value = toId === 'B' ? 1 : 0;
    },

    transitionTo(deckId, track) {
        Decks[deckId].load(track.buffer, track.meta);
        Decks[deckId].play();
        Decks[deckId].volume(1);
        xFader.value = deckId === 'A' ? 0 : 1;
    }
};

document.getElementById('ai-toggle').addEventListener('click', () => AI.toggle());

/* =========================================
   APP LOGIC (FILES & UI)
   ========================================= */
const App = {
    openModal(trackIdx) {
        pendingTrack = playlist[trackIdx];
        document.getElementById('modal').classList.remove('hidden');
    },
    closeModal() {
        document.getElementById('modal').classList.add('hidden');
    },
    loadTo(deckId) {
        if(pendingTrack) {
            Decks[deckId].load(pendingTrack.buffer, pendingTrack.meta);
            this.closeModal();
        }
    },
    
    async processFile(file) {
        try {
            const buf = await file.arrayBuffer();
            const audioBuf = await ctx.decodeAudioData(buf);
            const bpm = Math.floor(Math.random() * (130 - 120) + 120); // Sim BPM
            
            const track = {
                meta: { title: file.name.replace(/\.[^/.]+$/, ""), bpm: bpm },
                buffer: audioBuf
            };
            
            playlist.push(track);
            this.renderPlaylist();
        } catch(e) { console.error(e); }
    },

    renderPlaylist() {
        const list = document.getElementById('playlist');
        list.innerHTML = '';
        playlist.forEach((t, i) => {
            const li = document.createElement('li');
            li.innerHTML = `<span>${t.meta.title}</span> <span style="color:#666">${t.meta.bpm}</span>`;
            li.onclick = () => this.openModal(i);
            list.appendChild(li);
        });
    }
};

// Drag & Drop
['A', 'B'].forEach(id => {
    const zone = document.getElementById(`drop-${id.toLowerCase()}`);
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        if(e.dataTransfer.files.length) App.processFile(e.dataTransfer.files[0]);
    });
});

document.getElementById('upload').addEventListener('change', (e) => {
    [...e.target.files].forEach(f => App.processFile(f));
});

// Trending Fake Data
const trends = [
    {t: "Pushpa 2: Kissik", bpm: 135}, 
    {t: "Stree 2: Aayi Nai", bpm: 140},
    {t: "Max: Title Track", bpm: 128}
];
const tList = document.getElementById('trending');
trends.forEach(t => {
    const li = document.createElement('li');
    li.innerHTML = `<span>🔥 ${t.t}</span>`;
    li.onclick = () => { navigator.clipboard.writeText(t.t); alert("Copied: " + t.t); };
    tList.appendChild(li);
});
