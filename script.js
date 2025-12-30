/* =========================================
   AUDIO ENGINE & GLOBALS
   ========================================= */
const ctx = new (window.AudioContext || window.webkitAudioContext)();
const mainBus = ctx.createGain();
mainBus.connect(ctx.destination);

// GLOBAL STATE
let aiActive = false;
let checkLoop = null;

/* =========================================
   DECK CLASS
   ========================================= */
class Deck {
    constructor(id) {
        this.id = id;
        this.el = document.getElementById(`deck-${id.toLowerCase()}`);
        this.canvas = document.getElementById(`viz-${id.toLowerCase()}`);
        this.cCtx = this.canvas.getContext('2d');
        
        // Audio Graph
        this.gainNode = ctx.createGain();
        this.filterNode = ctx.createBiquadFilter();
        this.analyser = ctx.createAnalyser();
        
        this.filterNode.connect(this.gainNode);
        this.gainNode.connect(this.analyser);
        this.gainNode.connect(mainBus);
        
        this.source = null;
        this.buffer = null;
        this.isPlaying = false;
        this.startTime = 0;
        this.pausedAt = 0;
    }

    async loadFile(file) {
        try {
            const buf = await file.arrayBuffer();
            const audioBuf = await ctx.decodeAudioData(buf);
            this.buffer = audioBuf;
            
            // Random BPM Simulation
            const bpm = Math.floor(Math.random() * (135 - 120) + 120);
            
            // UI Update
            const suffix = this.id.toLowerCase();
            document.getElementById(`title-${suffix}`).innerText = file.name;
            document.getElementById(`bpm-${suffix}`).innerText = `${bpm} BPM`;
            document.querySelector(`#drop-${suffix} .drag-hint`).style.display = 'none';
            
            this.stop();
            this.pausedAt = 0;
        } catch(e) {
            alert("Error loading audio. Please try a valid MP3/WAV.");
        }
    }

    play(offset = 0) {
        if(!this.buffer) return;
        if(ctx.state === 'suspended') ctx.resume();

        this.source = ctx.createBufferSource();
        this.source.buffer = this.buffer;
        this.source.connect(this.filterNode);
        
        this.startTime = ctx.currentTime - offset;
        this.source.start(0, offset);
        this.isPlaying = true;
        this.el.classList.add('playing');
        
        this.source.onended = () => {
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

/* =========================================
   SMART TRANSITION & AI LOGIC
   ========================================= */
const xFader = document.getElementById('crossfader');

// Manual Crossfader
xFader.addEventListener('input', (e) => {
    updateMixer(parseFloat(e.target.value));
});

function updateMixer(val) {
    // Equal Power Crossfade
    Decks.A.volume(Math.cos(val * 0.5 * Math.PI));
    Decks.B.volume(Math.cos((1.0 - val) * 0.5 * Math.PI));
}

const AI = {
    triggerSmartSwitch() {
        // Determine direction based on current fader position
        const currentVal = parseFloat(xFader.value);
        let targetDeck = '';
        
        // If fader is more to the left (<0.5), we are hearing A, switch to B
        if(currentVal < 0.5) {
            this.performTransition('A', 'B');
        } else {
            this.performTransition('B', 'A');
        }
    },

    performTransition(from, to) {
        const toDeck = Decks[to];
        const fromDeck = Decks[from];

        if(!toDeck.buffer) {
            alert(`Load a song into Deck ${to} first!`);
            return;
        }

        console.log(`AI: Switching ${from} -> ${to}`);
        
        // 1. Ensure Target Deck is Playing
        if(!toDeck.isPlaying) {
            toDeck.volume(0); // Start silent
            toDeck.play();
        }

        // 2. Animate Crossfader & Filter
        const duration = 5000; // 5 seconds
        const steps = 100;
        const intervalTime = duration / steps;
        let step = 0;
        
        // Disable fader during transition
        xFader.disabled = true;

        const timer = setInterval(() => {
            step++;
            const progress = step / steps; // 0 to 1
            
            // Calculate Fader Value
            // If going A->B, fader goes 0 -> 1
            // If going B->A, fader goes 1 -> 0
            let faderVal;
            if(from === 'A') faderVal = progress;
            else faderVal = 1 - progress;
            
            // Update Visuals
            xFader.value = faderVal;
            updateMixer(faderVal);

            // Apply Filter Sweep to OUTGOING track
            // Low pass filter closes as track fades out
            fromDeck.filterNode.type = 'lowpass';
            // Sweep from 20000Hz (open) to 200Hz (muffled)
            const cutoff = 20000 * (1 - progress) + 200; 
            fromDeck.filterNode.frequency.setValueAtTime(cutoff, ctx.currentTime);

            if(step >= steps) {
                clearInterval(timer);
                xFader.disabled = false;
                // Clean up outgoing deck
                fromDeck.stop(); 
                fromDeck.filterNode.frequency.setValueAtTime(22000, ctx.currentTime); // Reset filter
            }
        }, intervalTime);
    }
};

/* =========================================
   APP INPUTS
   ========================================= */
const App = {
    loadDirect(input, deckId) {
        if(input.files && input.files[0]) {
            Decks[deckId].loadFile(input.files[0]);
        }
    },
    
    // Add to library list (optional backup method)
    addToLib(file) {
        const list = document.getElementById('playlist');
        const li = document.createElement('li');
        li.innerText = file.name;
        li.onclick = () => {
            // Ask where to load? Or default to A
            if(confirm("Load to Deck A? (Cancel for B)")) Decks.A.loadFile(file);
            else Decks.B.loadFile(file);
        };
        list.appendChild(li);
    }
};

// Global Upload (Library)
document.getElementById('upload').addEventListener('change', (e) => {
    [...e.target.files].forEach(f => App.addToLib(f));
});

// Drag and Drop Logic
['A', 'B'].forEach(id => {
    const zone = document.getElementById(`drop-${id.toLowerCase()}`);
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        if(e.dataTransfer.files[0]) Decks[id].loadFile(e.dataTransfer.files[0]);
    });
});

// Trending Fake Data
const trends = ["Pushpa 2: Kissik", "Stree 2: Aayi Nai", "Max: Title Track", "Kantara: Varaha Roopam"];
const tList = document.getElementById('trending');
trends.forEach(t => {
    const li = document.createElement('li');
    li.innerHTML = `<span>🔥 ${t}</span>`;
    li.onclick = () => { navigator.clipboard.writeText(t); alert("Copied: " + t); };
    tList.appendChild(li);
});
