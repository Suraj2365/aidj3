/* =========================================
   AUDIO CONTEXT & UTILS
   ========================================= */
const AudioContext = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioContext();

// --- STATE ---
let playlist = [];
let pendingTrack = null; // Track selected for modal loading
let aiEnabled = false;

/* =========================================
   CORE: DECK CLASS
   ========================================= */
class Deck {
    constructor(id) {
        this.id = id;
        this.canvas = document.getElementById(`viz-${id.toLowerCase()}`);
        this.ctx = this.canvas.getContext('2d');
        this.element = document.getElementById(`deck-${id.toLowerCase()}`);
        
        // Audio Nodes
        this.gainNode = audioCtx.createGain();
        this.analyser = audioCtx.createAnalyser();
        this.analyser.fftSize = 256;
        
        // Filter for effects
        this.filter = audioCtx.createBiquadFilter();
        this.filter.type = 'allpass';
        
        // Chain: Source -> Filter -> Gain -> Analyser -> Destination
        this.filter.connect(this.gainNode);
        this.gainNode.connect(this.analyser);
        // Destination is connected in mixer setup
        
        this.source = null;
        this.buffer = null;
        this.isPlaying = false;
        this.metadata = null;
        this.startTime = 0;
        this.pausedAt = 0;
    }

    async load(buffer, metadata) {
        this.stop();
        this.buffer = buffer;
        this.metadata = metadata;
        this.pausedAt = 0;
        
        // Update UI
        const suffix = this.id.toLowerCase();
        document.getElementById(`title-${suffix}`).innerText = metadata.title;
        document.getElementById(`bpm-${suffix}`).innerText = `${metadata.bpm} BPM`;
        document.querySelector(`#drop-${suffix} .drop-text`).style.display = 'none';
        
        this.drawEmptyWaveform();
    }

    play() {
        if (!this.buffer) return;
        if (audioCtx.state === 'suspended') audioCtx.resume();

        this.source = audioCtx.createBufferSource();
        this.source.buffer = this.buffer;
        this.source.connect(this.filter);
        
        // Start playback
        this.startTime = audioCtx.currentTime - this.pausedAt;
        this.source.start(0, this.pausedAt);
        this.isPlaying = true;
        this.element.classList.add('playing');
        
        this.source.onended = () => {
            if(this.isPlaying) { // Natural end
                this.isPlaying = false;
                this.pausedAt = 0;
                this.element.classList.remove('playing');
                if(aiEnabled) AiDirector.notifyEnd(this.id);
            }
        };

        this.visualize();
    }

    stop() {
        if (this.source) {
            try { this.source.stop(); } catch(e){}
            this.source = null;
        }
        this.isPlaying = false;
        this.element.classList.remove('playing');
    }

    togglePlay() {
        if (this.isPlaying) {
            this.stop();
            this.pausedAt = audioCtx.currentTime - this.startTime;
        } else {
            this.play();
        }
    }

    setVolume(val) {
        // Smooth volume change
        this.gainNode.gain.setTargetAtTime(parseFloat(val), audioCtx.currentTime, 0.05);
    }

    toggleFx(type) {
        const now = audioCtx.currentTime;
        if(type === 'echo') {
            // Simple fake echo using filter modulation for visual feedback
            // Real echo requires DelayNode structure (simplified for single file)
            this.filter.type = (this.filter.type === 'allpass') ? 'highpass' : 'allpass';
            this.filter.frequency.setValueAtTime(this.filter.type === 'highpass' ? 800 : 0, now);
        }
        else if(type === 'reverb') {
             // Simulated "muddy" reverb via Lowpass
             this.filter.type = (this.filter.type === 'allpass') ? 'lowpass' : 'allpass';
             this.filter.frequency.setValueAtTime(this.filter.type === 'lowpass' ? 2000 : 20000, now);
        }
    }

    visualize() {
        if(!this.isPlaying) return;
        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        
        const draw = () => {
            if(!this.isPlaying) return;
            requestAnimationFrame(draw);
            this.analyser.getByteFrequencyData(dataArray);
            
            this.ctx.fillStyle = '#000';
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            
            const barWidth = (this.canvas.width / bufferLength) * 2.5;
            let x = 0;
            this.ctx.fillStyle = this.id === 'A' ? '#ff0055' : '#0088ff';

            for(let i = 0; i < bufferLength; i++) {
                const barHeight = dataArray[i] / 1.5;
                this.ctx.fillRect(x, this.canvas.height - barHeight, barWidth, barHeight);
                x += barWidth + 1;
            }
        };
        draw();
    }

    drawEmptyWaveform() {
        // Draw a static line to show track is loaded
        this.ctx.strokeStyle = '#333';
        this.ctx.beginPath();
        this.ctx.moveTo(0, this.canvas.height/2);
        this.ctx.lineTo(this.canvas.width, this.canvas.height/2);
        this.ctx.stroke();
    }
}

/* =========================================
   SETUP: MIXER & DECKS
   ========================================= */
const decks = {
    A: new Deck('A'),
    B: new Deck('B')
};

// Mixer Bus
const masterGain = audioCtx.createGain();
masterGain.connect(audioCtx.destination);

// Connect Decks to Master
decks.A.gainNode.connect(masterGain);
decks.B.gainNode.connect(masterGain);

// Crossfader Logic
document.getElementById('crossfader').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    // Equal power crossfade
    decks.A.setVolume(Math.cos(val * 0.5 * Math.PI));
    decks.B.setVolume(Math.cos((1.0 - val) * 0.5 * Math.PI));
});

// Initialize Crossfader
decks.A.setVolume(0.707);
decks.B.setVolume(0.707);

/* =========================================
   APP LOGIC: LOADING & DRAG-DROP
   ========================================= */
const App = {
    // Modal Control
    openModal(trackIndex) {
        pendingTrack = playlist[trackIndex];
        document.getElementById('deck-selector-modal').classList.remove('hidden');
    },
    closeModal() {
        document.getElementById('deck-selector-modal').classList.add('hidden');
        pendingTrack = null;
    },
    loadToDeck(deckId) {
        if(pendingTrack) {
            decks[deckId].load(pendingTrack.buffer, pendingTrack.meta);
            this.closeModal();
        }
    },
    
    // File Processor
    async processFile(file, targetDeck = null) {
        try {
            const buffer = await file.arrayBuffer();
            const audioBuffer = await audioCtx.decodeAudioData(buffer);
            
            // Random BPM for demo (In real app, use bpm-detection lib)
            const bpm = Math.floor(Math.random() * (132 - 118) + 118);
            
            const track = {
                meta: { title: file.name, bpm: bpm },
                buffer: audioBuffer
            };

            // If dragged to specific deck
            if (targetDeck) {
                decks[targetDeck].load(track.buffer, track.meta);
            }
            
            // Always add to playlist
            this.addToPlaylistUI(track);
            playlist.push(track);
            
        } catch (e) {
            console.error("Error decoding audio:", e);
            alert("Could not load audio file. Ensure it is a valid MP3/WAV.");
        }
    },

    addToPlaylistUI(track) {
        const li = document.createElement('li');
        li.innerHTML = `
            <div style="flex:1">
                <strong>${track.meta.title}</strong><br>
                <small style="color:#666">${track.meta.bpm} BPM</small>
            </div>
            <button style="background:#333;color:white;border:none;cursor:pointer;padding:5px 10px;" 
                onclick="App.openModal(${playlist.length})">LOAD</button>
        `;
        document.getElementById('playlist').appendChild(li);
    },

    async loadOnlineDemo() {
        const btn = document.querySelector('.demo-btn');
        btn.innerText = "Downloading...";
        try {
            const url = "https://cdn.pixabay.com/download/audio/2022/05/27/audio_1808fbf07a.mp3";
            const response = await fetch(url);
            const blob = await response.blob();
            const file = new File([blob], "Cyberpunk Demo.mp3", { type: "audio/mp3" });
            await this.processFile(file);
            btn.innerText = "🌐 Load Demo";
        } catch(e) {
            alert("Failed to download demo. Check internet.");
            btn.innerText = "Error";
        }
    }
};

/* =========================================
   DRAG AND DROP HANDLERS
   ========================================= */
function setupDragDrop(deckId) {
    const zone = document.getElementById(`drop-${deckId.toLowerCase()}`);
    const deckEl = document.getElementById(`deck-${deckId.toLowerCase()}`);

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        zone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    zone.addEventListener('dragenter', () => deckEl.classList.add('drag-over'));
    zone.addEventListener('dragleave', () => deckEl.classList.remove('drag-over'));
    
    zone.addEventListener('drop', (e) => {
        deckEl.classList.remove('drag-over');
        const files = e.dataTransfer.files;
        if(files.length > 0) {
            App.processFile(files[0], deckId);
        }
    });
}

setupDragDrop('A');
setupDragDrop('B');

// General File Upload
document.getElementById('file-upload').addEventListener('change', (e) => {
    Array.from(e.target.files).forEach(file => App.processFile(file));
});

/* =========================================
   TRENDING CHARTS
   ========================================= */
const Trending = {
    data: {
        hindi: [
            { t: "Pushpa 2: Peelings", a: "Devi Sri Prasad" },
            { t: "Aaj Ki Raat", a: "Stree 2" },
            { t: "Tauba Tauba", a: "Karan Aujla" },
            { t: "Millionaire", a: "Yo Yo Honey Singh" },
            { t: "Bhool Bhulaiyaa 3", a: "Pitbull" }
        ],
        kannada: [
            { t: "Kissik (Kannada)", a: "Pushpa 2" },
            { t: "Dwapara", a: "Krishnam Pranaya Sakhi" },
            { t: "Maximum Mass", a: "Max (Kiccha Sudeep)" },
            { t: "Ninna Hegalu", a: "Vijay Prakash" },
            { t: "Toxic Anthem", a: "Yash 2025" }
        ]
    },
    show(cat) {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        event.target.classList.add('active');
        
        const list = document.getElementById('trending-list');
        list.innerHTML = '';
        this.data[cat].forEach((item, i) => {
            const li = document.createElement('li');
            li.className = 'trending-item';
            li.innerHTML = `
                <span class="rank">${i+1}</span>
                <div style="flex:1">
                    <span class="song-name">${item.t}</span>
                    <span class="artist">${item.a}</span>
                </div>
                <span>📋</span>
            `;
            li.onclick = () => {
                navigator.clipboard.writeText(item.t);
                alert(`Copied "${item.t}". Download it and drag it here!`);
            };
            list.appendChild(li);
        });
    }
};
// Init Trending
Trending.show('hindi');

/* =========================================
   AI DIRECTOR (AUTO DJ)
   ========================================= */
const AiDirector = {
    loop: null,
    start() {
        console.log("AI Started");
        this.loop = setInterval(() => {
            // Simple logic: If Deck A playing and near end, fade to B
            if(decks.A.isPlaying && !decks.B.isPlaying) {
                // In real app, check time remaining. 
                // Here we Randomly transition for demo
                if(Math.random() < 0.05) this.transition('A', 'B');
            } else if(decks.B.isPlaying && !decks.A.isPlaying) {
                if(Math.random() < 0.05) this.transition('B', 'A');
            }
        }, 1000);
    },
    stop() { clearInterval(this.loop); },
    
    transition(from, to) {
        // Find next track
        if(playlist.length === 0) return;
        const nextTrack = playlist[Math.floor(Math.random() * playlist.length)];
        decks[to].load(nextTrack.buffer, nextTrack.meta);
        decks[to].setVolume(0);
        decks[to].play();
        
        // Auto Crossfade Animation
        let val = from === 'A' ? 0 : 1;
        const interval = setInterval(() => {
            if(from === 'A') val += 0.05; else val -= 0.05;
            
            // Clamp
            if(val > 1) val = 1; if(val < 0) val = 0;
            
            document.getElementById('crossfader').value = val;
            // Trigger input event manually to update audio
            document.getElementById('crossfader').dispatchEvent(new Event('input'));
            
            if(val <= 0 || val >= 1) clearInterval(interval);
        }, 200);
    },
    notifyEnd(id) { /* Handle track end if needed */ }
};

document.getElementById('toggle-ai-btn').addEventListener('click', (e) => {
    aiEnabled = !aiEnabled;
    e.target.classList.toggle('active');
    aiEnabled ? AiDirector.start() : AiDirector.stop();
});