/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Fuel, 
  Gauge, 
  RotateCcw, 
  Info, 
  ChevronDown, 
  ArrowRight, 
  X,
  Menu,
  Sun,
  Moon,
  Home,
  Infinity
} from 'lucide-react';

/* --- AUDIO ENGINE --- */
class AudioService {
  private audioCtx: AudioContext | null = null;
  private thrustNoise: ScriptProcessorNode | null = null;
  private thrustGain: GainNode | null = null;
  private thrustFilter: BiquadFilterNode | null = null;
  private initialized = false;

  init() {
    if (this.initialized) return;
    try {
      this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const bufferSize = 4096;
      this.thrustNoise = this.audioCtx.createScriptProcessor(bufferSize, 1, 1);
      this.thrustNoise.onaudioprocess = (e) => {
        const output = e.outputBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
          output[i] = Math.random() * 2 - 1;
        }
      };

      this.thrustFilter = this.audioCtx.createBiquadFilter();
      this.thrustFilter.type = 'lowpass';
      this.thrustFilter.frequency.value = 400;
      this.thrustFilter.Q.value = 1;

      this.thrustGain = this.audioCtx.createGain();
      this.thrustGain.gain.value = 0;

      this.thrustNoise.connect(this.thrustFilter);
      this.thrustFilter.connect(this.thrustGain);
      this.thrustGain.connect(this.audioCtx.destination);
      this.initialized = true;
    } catch (e) {
      console.error('Failed to init audio', e);
    }
  }

  updateThrust(throttle: number, fuel: number) {
    if (!this.initialized || !this.thrustGain || !this.thrustFilter || !this.audioCtx) return;
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    
    const targetGain = fuel > 0 ? throttle * 0.3 : 0;
    const targetFreq = 200 + throttle * 800;
    
    this.thrustGain.gain.setTargetAtTime(targetGain, this.audioCtx.currentTime, 0.05);
    this.thrustFilter.frequency.setTargetAtTime(targetFreq, this.audioCtx.currentTime, 0.05);
  }

  stopThrust() {
    if (!this.initialized || !this.thrustGain || !this.audioCtx) return;
    this.thrustGain.gain.setTargetAtTime(0, this.audioCtx.currentTime, 0.05);
  }

  playLanding() {
    if (!this.initialized || !this.audioCtx) return;
    this.playTone(150, 400, 0.3, 'sine');
    this.playTone(100, 200, 0.5, 'triangle');
  }

  playCrash() {
    if (!this.initialized || !this.audioCtx) return;
    this.playTone(100, 40, 0.8, 'sawtooth', 0.5);
    
    const buffer = this.audioCtx.createBuffer(1, this.audioCtx.sampleRate * 0.5, this.audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < buffer.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / buffer.length);
    }
    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    const gain = this.audioCtx.createGain();
    gain.gain.value = 0.5;
    source.connect(gain);
    gain.connect(this.audioCtx.destination);
    source.start();
  }

  playClick() {
    if (!this.initialized || !this.audioCtx) return;
    this.playTone(800, 1200, 0.1, 'sine', 0.05);
  }

  private playTone(startFreq: number, endFreq: number, duration: number, type: OscillatorType = 'sine', volume = 0.2) {
    if (!this.audioCtx) return;
    const osc = this.audioCtx.createOscillator();
    const gain = this.audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(startFreq, this.audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(endFreq, this.audioCtx.currentTime + duration);
    gain.gain.setValueAtTime(volume, this.audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(this.audioCtx.destination);
    osc.start();
    osc.stop(this.audioCtx.currentTime + duration);
  }
}

const audio = new AudioService();

/* --- CONSTANTS --- */
const PHYSICS = {
  gravity: 0.005,
  atmosphere: 0.0005,
  enginePower: 0.015,
  fuelCapacity: 100,
  maxLandingVelocity: 0.5,
  maxLandingAngle: 0.349, // ~20 deg
};

const PLANET = {
  name: "Earth",
  color: "#3b82f6",
  groundColor: "#10b981"
};

const LANDER_WIDTH = 10;
const LANDER_HEIGHT = 32;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  isDebris?: boolean;
  angle?: number;
  rotationSpeed?: number;
}

/* --- COMPONENT: LANDER SIMULATION --- */
const LanderSimulation = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [gameState, setGameState] = useState<'menu' | 'landing' | 'result'>('menu');
  const [stats, setStats] = useState({ fuel: 100, velocity: 0, altitude: 0, angle: 0, throttle: 0 });
  const [credits, setCredits] = useState(0);
  const [isDay, setIsDay] = useState(true);

  // Refs for high-speed simulation
  const state = useRef({
    x: 400, y: 50, vx: 0, vy: 2, angle: 0, throttle: 0,
    fuel: PHYSICS.fuelCapacity, isLanded: false, isCrashed: false
  });
  const particles = useRef<Particle[]>([]);
  const shake = useRef({ intensity: 0, duration: 0 });
  const lastTime = useRef(0);
  const keys = useRef<Record<string, boolean>>({});

  const resetGameState = () => {
    const w = containerRef.current?.clientWidth || 800;
    state.current = {
      x: w / 2, y: 50, vx: 0, vy: 1.5, angle: (Math.random() - 0.5) * 0.2,
      throttle: 0, fuel: PHYSICS.fuelCapacity, isLanded: false, isCrashed: false
    };
    particles.current = [];
    shake.current = { intensity: 0, duration: 0 };
  };

  const startMission = () => {
    audio.init();
    audio.playClick();
    resetGameState();
    setGameState('landing');
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => { keys.current[e.key] = true; if (e.key === 'r') startMission(); };
    const handleKeyUp = (e: KeyboardEvent) => { keys.current[e.key] = false; };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  const createEngineParticle = (x: number, y: number, angle: number, throttle: number) => {
    const speed = 3 + throttle * 5;
    const pAngle = angle + Math.PI / 2 + (Math.random() - 0.5) * 0.3;
    return {
      x, y, 
      vx: Math.cos(pAngle) * speed + (Math.random() - 0.5),
      vy: Math.sin(pAngle) * speed + (Math.random() - 0.5),
      life: 1, 
      maxLife: 0.4 + Math.random() * 0.4,
      color: throttle > 0.7 ? "#fbbf24" : "#f87171",
      size: 3 + Math.random() * 5
    };
  };

  const createExplosion = (x: number, y: number) => {
    const p: Particle[] = [];
    for (let i = 0; i < 60; i++) {
       const ang = Math.random() * Math.PI * 2;
       const spd = 3 + Math.random() * 8;
       p.push({
         x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
         life: 1, maxLife: 1 + Math.random() * 2,
         color: Math.random() > 0.4 ? "#ef4444" : "#fbbf24",
         size: 4 + Math.random() * 8
       });
    }
    for (let i = 0; i < 12; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 2 + Math.random() * 6;
      p.push({
        x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
        life: 1, maxLife: 3 + Math.random() * 2,
        color: "#94a3b8", size: 4 + Math.random() * 6,
        isDebris: true, angle: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 0.2
      });
    }
    return p;
  };

  useEffect(() => {
    if (gameState !== 'landing') return;

    let frameId: number;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !canvas) return;

    const loop = (time: number) => {
      const dt = Math.min(time - lastTime.current, 32) / 16;
      lastTime.current = time;
      
      const s = state.current;
      if (s.isLanded || s.isCrashed) return;

      const groundY = canvas.height - 180;
      
      // Inputs
      if (keys.current.ArrowUp || keys.current.w || (keys.current as any).touchThrottle) {
        s.throttle = Math.min(s.throttle + 0.04, 1);
      } else {
        s.throttle = Math.max(s.throttle - 0.02, 0);
      }

      if (keys.current.ArrowLeft || keys.current.a) s.angle -= 0.04 * dt;
      if (keys.current.ArrowRight || keys.current.d) s.angle += 0.04 * dt;

      // Physics
      const thrust = s.fuel > 0 ? s.throttle * PHYSICS.enginePower : 0;
      const fuelUse = s.throttle * 0.15 * dt;
      
      const ax = Math.sin(s.angle) * thrust;
      const ay = -Math.cos(s.angle) * thrust + PHYSICS.gravity;
      const dragX = -s.vx * PHYSICS.atmosphere;
      const dragY = -s.vy * PHYSICS.atmosphere;

      s.vx += (ax + dragX) * dt;
      s.vy += (ay + dragY) * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.fuel = Math.max(s.fuel - fuelUse, 0);

      // Audio & Feed
      audio.updateThrust(s.throttle, s.fuel);
      if (thrust > 0.01) shake.current = { intensity: thrust * 150, duration: 5 };

      // Ground Kickup
      if (thrust > 0.1 && s.y > groundY - 150) {
        for (let i = 0; i < Math.floor(s.throttle * 3); i++) {
          particles.current.push({
            x: s.x + (Math.random() - 0.5) * 40,
            y: groundY,
            vx: (Math.random() - 0.5) * 10,
            vy: -Math.random() * 3,
            life: 1, maxLife: 0.5 + Math.random() * 0.5,
            color: !isDay ? "#1e293b" : PLANET.groundColor,
            size: 2 + Math.random() * 4
          });
        }
      }

      // Check Landing
      const padW = 120;
      const onPad = Math.abs(s.x - canvas.width / 2) < padW / 2;
      const actualGround = onPad ? groundY - 6 : groundY;
      const shipBottom = s.y + LANDER_HEIGHT / 2 + 8;

      if (shipBottom >= actualGround) {
        const vel = Math.sqrt(s.vx**2 + s.vy**2);
        const ang = Math.abs(Math.atan2(Math.sin(s.angle), Math.cos(s.angle)));
        
        if (onPad && vel <= PHYSICS.maxLandingVelocity && ang <= PHYSICS.maxLandingAngle) {
          s.isLanded = true;
          audio.playLanding();
          audio.stopThrust();
          setCredits(c => c + 250);
          s.y = actualGround - (LANDER_HEIGHT / 2 + 8);
        } else {
          s.isCrashed = true;
          audio.playCrash();
          audio.stopThrust();
          shake.current = { intensity: 15, duration: 30 };
          particles.current.push(...createExplosion(s.x, actualGround));
          s.y = actualGround - (LANDER_HEIGHT / 2 + 8);
        }
        setGameState('result');
      }

      // Particles & UI
      if(thrust > 0) {
        particles.current.push(createEngineParticle(s.x - Math.sin(s.angle) * 16, s.y + Math.cos(s.angle) * 16, s.angle, s.throttle));
      }
      particles.current = particles.current.map(p => ({
        ...p,
        x: p.x + p.vx * dt,
        y: p.y + p.vy * dt,
        life: p.life - (0.015 / p.maxLife) * dt,
        angle: p.isDebris ? (p.angle || 0) + (p.rotationSpeed || 0) * dt : undefined
      })).filter(p => p.life > 0);

      if (shake.current.duration > 0) shake.current.duration -= dt;

      setStats({
        fuel: s.fuel,
        velocity: Math.sqrt(s.vx**2 + s.vy**2) * 20,
        altitude: Math.max(0, (groundY - s.y - LANDER_HEIGHT/2) / 10),
        angle: s.angle,
        throttle: s.throttle
      });

      draw(ctx, canvas);
      frameId = requestAnimationFrame(loop);
    };

    const draw = (ctx: CanvasRenderingContext2D, cvs: HTMLCanvasElement) => {
      const s = state.current;
      const groundY = cvs.height - 180;
      
      ctx.save();
      // Screen Shake
      if (shake.current.duration > 0) {
        ctx.translate((Math.random() - 0.5) * shake.current.intensity, (Math.random() - 0.5) * shake.current.intensity);
      }

      // Sky
      const grad = ctx.createLinearGradient(0, 0, 0, cvs.height);
      if (!isDay) {
        grad.addColorStop(0, '#020617');
        grad.addColorStop(1, '#0f172a');
      } else {
        grad.addColorStop(0, '#020617');
        grad.addColorStop(1, PLANET.color + '44');
      }
      ctx.fillStyle = grad;
      ctx.fillRect(-50, -50, cvs.width + 100, cvs.height + 100);

      // Stars
      ctx.fillStyle = "white";
      const starCount = !isDay ? 120 : 60;
      for (let i = 0; i < starCount; i++) {
        const x = (Math.sin(i * 123.45) * 0.5 + 0.5) * cvs.width;
        const y = (Math.cos(i * 678.9) * 0.5 + 0.5) * cvs.height;
        ctx.globalAlpha = (!isDay ? 0.3 : 0.15) + Math.sin(Date.now() / 800 + i) * 0.1;
        ctx.fillRect(x, y, 1.5, 1.5);
      }
      ctx.globalAlpha = 1;

      // Ground
      ctx.fillStyle = !isDay ? "#0f172a" : PLANET.groundColor;
      ctx.fillRect(-50, groundY, cvs.width + 100, 180);

      // Shadow
      const dist = Math.max(0, groundY - s.y);
      if (dist < 400 && !s.isCrashed) {
        ctx.fillStyle = `rgba(0, 0, 0, ${Math.max(0, 0.4 - dist / 1000)})`;
        ctx.beginPath();
        ctx.ellipse(s.x, groundY, LANDER_WIDTH * (1 + dist / 100), 5, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      // Lander
      if (!s.isCrashed) {
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.rotate(s.angle);
        
        ctx.fillStyle = '#cbd5e1';
        ctx.fillRect(-LANDER_WIDTH/2, -LANDER_HEIGHT/2, LANDER_WIDTH, LANDER_HEIGHT);
        
        // Cap
        ctx.beginPath();
        ctx.moveTo(-LANDER_WIDTH/2, -LANDER_HEIGHT/2);
        ctx.quadraticCurveTo(0, -LANDER_HEIGHT/2 - 16, LANDER_WIDTH/2, -LANDER_HEIGHT/2);
        ctx.fill();

        // Legs
        const legDeploy = dist < 150 ? Math.min(1, (150 - dist) / 50) : 0;
        if (legDeploy > 0) {
          ctx.strokeStyle = '#475569';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(-LANDER_WIDTH/2, LANDER_HEIGHT/2 - 4);
          ctx.lineTo(-LANDER_WIDTH/2 - 10 * legDeploy, LANDER_HEIGHT/2 + 8 * legDeploy);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(LANDER_WIDTH/2, LANDER_HEIGHT/2 - 4);
          ctx.lineTo(LANDER_WIDTH/2 + 10 * legDeploy, LANDER_HEIGHT/2 + 8 * legDeploy);
          ctx.stroke();
        }

        // Thrust flame
        if (s.throttle > 0 && s.fuel > 0) {
          ctx.fillStyle = '#fbbf24';
          ctx.globalAlpha = s.throttle * 0.8;
          ctx.beginPath();
          ctx.arc(0, LANDER_HEIGHT / 2, 6, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      // Landing Pad Markings
      const midX = cvs.width / 2;
      const padW = 120;
      ctx.fillStyle = "#000000";
      ctx.fillRect(midX - padW / 2, groundY - 6, padW, 6);
      ctx.fillStyle = !isDay ? "#94a3b8" : "#ffffff";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.letterSpacing = "3px";
      ctx.fillText("RASHIKIAN", midX, groundY - 3);
      ctx.letterSpacing = "0px";
      
      // Beacon
      if (!isDay ? (Math.floor(Date.now() / 500) % 2 === 0) : true) {
        ctx.fillStyle = "#ef4444";
        ctx.beginPath();
        ctx.arc(midX - padW / 2 + 10, groundY - 10, 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // Particles
      particles.current.forEach(p => {
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.color;
        if (p.isDebris) {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.angle || 0);
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
        }
      });

      ctx.restore();
    };

    frameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameId);
  }, [gameState, isDay]);

  // Resize
  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current && canvasRef.current) {
        canvasRef.current.width = containerRef.current.clientWidth;
        canvasRef.current.height = containerRef.current.clientHeight;
      }
    };
    handleResize();
    const obs = new ResizeObserver(handleResize);
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="relative w-full h-full bg-[#020617] overflow-hidden select-none touch-pan-y">
      <canvas ref={canvasRef} className="block w-full h-full" />
      
      {/* HUD HEADER */}
      <div className="absolute top-[80px] left-0 right-0 z-40 px-6 pointer-events-none">
        <div className="flex items-center justify-center gap-8">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 border border-neutral-500 rounded-full flex items-center justify-center">
              <div className="w-0.5 h-0.5 bg-neutral-500 rounded-full" />
            </div>
            <span className="text-neutral-500 font-mono text-[10px] uppercase tracking-[3px]">Earth</span>
          </div>
          <div className="font-mono text-[10px] uppercase tracking-[3px]">
            <span className="text-amber-500">Credits:</span> <span className="text-white">${credits}</span>
          </div>
        </div>
      </div>

      {/* HUD OVERLAY */}
      <AnimatePresence>
        {(gameState === 'landing' || gameState === 'playing') && (
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: 1 }} 
            exit={{ opacity: 0 }}
            className="absolute inset-0 pointer-events-none p-6 pt-32 flex flex-col justify-between z-30"
          >
            <div className="flex justify-between items-start">
              <div className="flex flex-col gap-4 scale-90 md:scale-100 origin-top-left transition-transform">
                <div className="flex flex-col">
                  <span className="text-[10px] uppercase font-black tracking-[4px] text-neutral-500 mb-1">Propellant</span>
                  <div className="w-32 md:w-48 h-1 bg-white/10 rounded-full overflow-hidden">
                    <motion.div 
                      className={`h-full ${stats.fuel < 20 ? 'bg-red-500 animate-pulse' : 'bg-white'}`} 
                      animate={{ width: `${stats.fuel}%` }} 
                    />
                  </div>
                </div>
                
                <div className="flex flex-col">
                  <span className="text-[10px] uppercase font-black tracking-[4px] text-neutral-500 mb-0.5">Velocity</span>
                  <span className={`font-mono text-xl md:text-2xl font-black ${stats.velocity > 12 ? 'text-red-500' : 'text-white'}`}>
                    {stats.velocity.toFixed(1)} <small className="text-[10px] opacity-40">m/s</small>
                  </span>
                </div>
              </div>

              <div className="flex flex-col items-end scale-90 md:scale-100 origin-top-right transition-transform">
                <span className="text-[10px] uppercase font-black tracking-[4px] text-neutral-500 mb-0.5">Altitude</span>
                <span className="font-mono text-xl md:text-2xl font-black text-white">
                  {stats.altitude.toFixed(1)} <small className="text-[10px] opacity-40">km</small>
                </span>
              </div>
            </div>

            <div className="flex justify-between items-end pb-36 md:pb-8">
              <div className="bg-black/40 backdrop-blur-xl border border-white/10 p-3 md:p-4 rounded-3xl flex flex-col items-center shadow-xl scale-[0.7] sm:scale-85 md:scale-100 origin-bottom-left pointer-events-auto transition-transform">
                <span className="text-[9px] md:text-[10px] uppercase font-black tracking-widest text-neutral-500 mb-2">Tilt</span>
                <div className="flex items-center gap-3 md:gap-4">
                   <button 
                     onMouseDown={() => (keys.current.ArrowLeft = true)}
                     onMouseUp={() => (keys.current.ArrowLeft = false)}
                     onMouseLeave={() => (keys.current.ArrowLeft = false)}
                     onTouchStart={() => (keys.current.ArrowLeft = true)}
                     onTouchEnd={() => (keys.current.ArrowLeft = false)}
                     className="p-3 md:p-2 bg-white/5 rounded-2xl hover:bg-white/10 transition-colors active:bg-white/20"
                   >
                     <ArrowRight className="w-8 h-8 md:w-6 md:h-6 rotate-180" />
                   </button>
                   <span className="font-mono text-xl md:text-2xl font-black text-white w-10 md:w-12 text-center">
                     {(stats.angle * (180/Math.PI)).toFixed(0)}°
                   </span>
                   <button 
                     onMouseDown={() => (keys.current.ArrowRight = true)}
                     onMouseUp={() => (keys.current.ArrowRight = false)}
                     onMouseLeave={() => (keys.current.ArrowRight = false)}
                     onTouchStart={() => (keys.current.ArrowRight = true)}
                     onTouchEnd={() => (keys.current.ArrowRight = false)}
                     className="p-3 md:p-2 bg-white/5 rounded-2xl hover:bg-white/10 transition-colors active:bg-white/20"
                   >
                     <ArrowRight className="w-8 h-8 md:w-6 md:h-6" />
                   </button>
                </div>
              </div>

              <div className="bg-black/40 backdrop-blur-xl border border-white/10 p-3 md:p-4 rounded-3xl flex flex-col items-center shadow-xl scale-[0.65] sm:scale-85 md:scale-100 origin-bottom-right pointer-events-auto transition-transform">
                <span className="text-[9px] md:text-[10px] uppercase font-black tracking-widest text-neutral-500 mb-2">Throttle</span>
                <div 
                   onMouseDown={() => (keys.current as any).touchThrottle = true}
                   onMouseUp={() => (keys.current as any).touchThrottle = false}
                   onMouseLeave={() => (keys.current as any).touchThrottle = false}
                   onTouchStart={() => (keys.current as any).touchThrottle = true}
                   onTouchEnd={() => (keys.current as any).touchThrottle = false}
                   className="w-12 md:w-10 h-32 md:h-32 bg-white/5 rounded-full relative overflow-hidden border border-white/10 cursor-ns-resize active:border-blue-500/50"
                >
                  <motion.div 
                    className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-blue-600 to-blue-400" 
                    animate={{ height: `${stats.throttle * 100}%` }}
                  />
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* SCREENS */}
      <AnimatePresence mode="wait">
        {gameState === 'menu' && (
          <motion.div 
            key="menu"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 flex flex-col items-center justify-center z-50 p-12 bg-black/40 backdrop-blur-xl"
          >
            <div className="absolute top-[80px] left-0 right-0 z-40 px-6 pointer-events-none">
              <div className="flex items-center justify-center gap-8">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 border border-neutral-500 rounded-full flex items-center justify-center">
                    <div className="w-0.5 h-0.5 bg-neutral-500 rounded-full" />
                  </div>
                  <span className="text-neutral-500 font-mono text-[10px] uppercase tracking-[3px]">Earth</span>
                </div>
                <div className="font-mono text-[10px] uppercase tracking-[3px]">
                  <span className="text-amber-500">Credits:</span> <span className="text-white">${credits}</span>
                </div>
              </div>
            </div>

            <button 
              onClick={startMission}
              className="w-40 h-40 bg-white rounded-full flex items-center justify-center hover:scale-110 active:scale-95 transition-transform shadow-[0_0_80px_rgba(255,255,255,0.15)] mb-16 relative group"
            >
              <div className="w-0 h-0 border-t-[25px] border-t-transparent border-l-[45px] border-l-black border-b-[25px] border-b-transparent ml-3" />
            </button>
            
            <div className="flex gap-4">
              <button 
                onClick={() => { audio.playClick(); setIsDay(true); }}
                className={`w-16 h-16 rounded-2xl transition-all flex items-center justify-center ${isDay ? 'bg-amber-500 text-white shadow-[0_0_30px_rgba(245,158,11,0.3)]' : 'bg-white/5 text-neutral-500 hover:bg-white/10 border border-white/5'}`}
              >
                <Sun className="w-8 h-8" />
              </button>
              <button 
                onClick={() => { audio.playClick(); setIsDay(false); }}
                className={`w-16 h-16 rounded-2xl transition-all flex items-center justify-center ${!isDay ? 'bg-indigo-600 text-white shadow-[0_0_30px_rgba(79,70,229,0.3)]' : 'bg-white/5 text-neutral-500 hover:bg-white/10 border border-white/5'}`}
              >
                <Moon className="w-8 h-8" />
              </button>
            </div>
          </motion.div>
        )}

        {gameState === 'result' && (
          <motion.div 
            key="result"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            className="absolute inset-0 flex flex-col items-center justify-center z-[100] bg-black/20"
          >
            <div className="text-center">
              <motion.h2 
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className={`text-[clamp(3.5rem,12vw,6rem)] font-['Bebas_Neue'] mb-4 leading-none tracking-tight ${state.current.isLanded ? 'text-white' : 'text-red-600'}`}
              >
                {state.current.isLanded ? 'Touchdown' : 'RUD'}
              </motion.h2>
              <p className="font-mono text-xs md:text-sm text-amber-500 font-bold uppercase tracking-[6px] mb-16">
                Credits: ${credits}
              </p>
              
              <div className="flex gap-8 justify-center">
                <button 
                  onClick={startMission}
                  className="w-20 h-20 flex items-center justify-center bg-white/10 text-white rounded-full hover:bg-white/20 transition-all border border-white/10 backdrop-blur-md group shadow-xl"
                >
                  <RotateCcw className="w-8 h-8 group-hover:rotate-[-45deg] transition-transform" />
                </button>
                <button 
                  onClick={() => { audio.playClick(); setGameState('menu'); }}
                  className="w-20 h-20 flex items-center justify-center bg-white/10 text-white rounded-full hover:bg-white/20 transition-all border border-white/10 backdrop-blur-md group shadow-xl"
                >
                  <Home className="w-8 h-8" />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

/* --- MAIN APP --- */
export default function App() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showHeader, setShowHeader] = useState(true);
  const [lastScrollY, setLastScrollY] = useState(0);
  const [isScrolling, setIsScrolling] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const handleScroll = () => {
      const currentScrollY = window.scrollY;
      const totalHeight = document.documentElement.scrollHeight - window.innerHeight;
      
      // Update Progress
      if (totalHeight > 0) {
        setScrollProgress((currentScrollY / totalHeight) * 100);
      }

      // Hide/Show Header
      if (currentScrollY > 100) {
        if (currentScrollY > lastScrollY) {
          setShowHeader(false); // Scrolling down
        } else {
          setShowHeader(true); // Scrolling up
        }
      } else {
        setShowHeader(true); // Near top
      }
      setLastScrollY(currentScrollY);

      // Scroll Activity
      setIsScrolling(true);
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = setTimeout(() => {
        setIsScrolling(false);
      }, 1200);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    };
  }, [lastScrollY]);

  const navLinks = [
    { name: 'Home', href: '#home' },
    { name: 'Readersonic', href: '#readersonic' },
    { name: 'Content', href: '#content' },
    { name: 'About', href: '#about' },
    { name: 'Contact', href: '#contact' },
    { name: '𝕏', href: 'https://x.com/rashikian', isExternal: true },
  ];

  return (
    <div className="bg-[#0a0a0a] text-[#efefef] min-h-screen selection:bg-white selection:text-black">
      
      {/* NAVIGATION */}
      <nav 
        style={{ transform: showHeader ? 'translateY(0)' : 'translateY(-100%)' }}
        className="fixed top-0 left-0 w-full h-[64px] bg-[rgba(10,10,10,0.85)] backdrop-blur-[14px] border-b border-[#1e1e1e] flex items-center justify-between px-[5%] md:px-[6%] z-[1000] transition-transform duration-300 ease-in-out"
      >
        <div className="font-['Bebas_Neue'] text-[1.8rem] sm:text-[2.2rem] text-[#efefef] tracking-tight">RASHIKIAN</div>
        
        {/* Desktop Nav */}
        <div className="hidden md:flex items-center gap-6">
          {navLinks.map((link, i) => (
            <React.Fragment key={link.name}>
              <a 
                href={link.href} 
                target={link.isExternal ? "_blank" : undefined}
                rel={link.isExternal ? "noopener noreferrer" : undefined}
                className="font-['DM_Mono'] text-[0.72rem] uppercase text-[#888] hover:text-white transition-colors tracking-widest"
              >
                {link.name}
              </a>
              {i < navLinks.length - 1 && <span className="text-[#333] font-['DM_Mono']">·</span>}
            </React.Fragment>
          ))}
        </div>

        {/* Mobile Hamburger */}
        <button onClick={() => setIsMenuOpen(true)} className="md:hidden text-white p-2 flex items-center gap-2">
          <span className="font-['DM_Mono'] text-[10px] text-[#888] uppercase tracking-widest hidden sm:inline">Index</span>
          <Menu className="w-6 h-6" />
        </button>
      </nav>

      {/* MOBILE MENU OVERLAY */}
      <AnimatePresence>
        {isMenuOpen && (
          <motion.div 
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="fixed inset-0 bg-[#0a0a0a] z-[2000] flex flex-col items-center justify-center p-8"
          >
            <button 
              onClick={() => setIsMenuOpen(false)}
              className="absolute top-8 right-[5%] text-white p-2"
            >
              <X className="w-10 h-10" />
            </button>
            <div className="flex flex-col items-center gap-6 sm:gap-8">
              {navLinks.map((link) => (
                <motion.a 
                  key={link.name}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  href={link.href}
                  onClick={() => setIsMenuOpen(false)}
                  className="font-['Bebas_Neue'] text-[3.5rem] sm:text-[5rem] text-[#efefef] leading-none"
                >
                  {link.name}
                </motion.a>
              ))}
            </div>
            <div className="mt-16 font-['DM_Mono'] text-[10px] text-[#444] uppercase tracking-[5px]">
               EST. 2024 · 01101001
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* SCROLL INDICATOR */}
      <div 
        className={`fixed right-0 top-0 bottom-0 w-[2px] z-[5000] transition-opacity duration-500 pointer-events-none ${isScrolling ? 'opacity-100' : 'opacity-0'}`}
      >
        <div className="bg-white/10 w-full h-full" />
        <div 
          className="absolute top-0 right-0 w-full bg-white/60"
          style={{ height: `${scrollProgress}%` }}
        />
      </div>

      {/* HERO / LANDER SECTION */}
      <section id="home" className="relative h-screen border-b border-[#1e1e1e]">
        <LanderSimulation />
      </section>


      {/* READERSONIC SECTION */}
      <section id="readersonic" className="py-24 overflow-hidden border-b border-[#1e1e1e]">
        <div className="px-[6%] mb-8">
           <span className="font-['DM_Mono'] text-[0.65rem] text-[#888] tracking-[3px] uppercase">Product</span>
        </div>
        <a 
          href="https://www.readersonic.com/" 
          target="_blank" 
          rel="noopener noreferrer"
          className="block hover:text-blue-400 transition-colors"
        >
          <h2 className="font-['Bebas_Neue'] text-[clamp(4.5rem,18vw,16rem)] leading-[0.85] mb-16 px-[6%]">
            Readersonic
          </h2>
        </a>
        
        <div className="px-[6%] flex justify-center items-center">
          <div className="flex justify-center">
            <ReadersonicPhone />
          </div>
        </div>

        <div className="mt-20 lg:mt-24 w-full bg-[#111] border-t border-b border-[#1e1e1e] p-[2.5rem_6%] flex flex-col sm:flex-row items-center justify-center gap-6">
           <p className="font-['DM_Mono'] text-[0.95rem] md:text-[1.1rem] text-[#888] text-center">"Replace doomscrolling with productive reading"</p>
        </div>
      </section>

      {/* CONTENT STUDIO SECTION */}
      <section id="content" className="py-24 px-[6%] border-b border-[#1e1e1e]">
        <span className="font-['DM_Mono'] text-[0.65rem] text-[#888] tracking-[3px] uppercase">Content</span>
        <h2 className="font-['Bebas_Neue'] text-[clamp(4.5rem,15vw,7rem)] leading-none mb-12 lg:mb-16">Content Studio</h2>
        
        <a 
          href="https://www.youtube.com/@Rashikian" 
          target="_blank" 
          rel="noopener noreferrer"
          className="block bg-[#0f0f0f] border border-[#1e1e1e] p-10 md:p-20 relative overflow-hidden group transition-all hover:bg-[#151515] active:scale-[0.99]"
        >
          {/* Background Text Decor */}
          <div className="font-['Bebas_Neue'] text-[clamp(8rem,20vw,20rem)] text-[#161616] leading-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 select-none pointer-events-none group-hover:scale-110 transition-transform duration-1000">
            YOUTUBE
          </div>
          
          <div className="relative z-10 flex flex-col items-center text-center">
            <span className="font-['DM_Mono'] text-[0.7rem] text-red-500 tracking-[5px] uppercase mb-6 flex items-center gap-2">
              <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" /> Official Channel
            </span>
            <h3 className="font-['Bebas_Neue'] text-[3.5rem] md:text-[6rem] mb-6 uppercase leading-none tracking-tight">Rashikian</h3>
            <p className="font-['DM_Mono'] text-[1rem] md:text-[1.2rem] text-[#888] max-w-[640px] leading-relaxed mb-12">
              Deep dives into science, technology, and aerospace. Exploring the future through cinematic documentaries and concise technical shorts.
            </p>
            <div className="px-12 py-4 bg-white text-black font-['DM_Mono'] text-[0.9rem] font-bold uppercase tracking-[3px] group-hover:bg-red-600 group-hover:text-white transition-colors">
              Subscribe ↗
            </div>
          </div>
        </a>
      </section>

      {/* ABOUT SECTION */}
      <section id="about" className="py-24 px-[6%] flex flex-col lg:flex-row gap-12 lg:gap-16 border-b border-[#1e1e1e]">
        <div className="w-full lg:w-[60%]">
          <span className="font-['DM_Mono'] text-[0.65rem] text-[#888] tracking-[3px] uppercase mb-4 block">About</span>
          <h2 className="font-['Bebas_Neue'] text-[clamp(4rem,14vw,6rem)] leading-none mb-8">Who We Are</h2>
          <p className="font-['DM_Mono'] text-[0.95rem] md:text-[1.05rem] text-[#888] leading-relaxed mb-6">
            Rashikian is a technology company building toward aerospace, with a current focus on building software products. We are early in our journey, but actively designing and shipping with intent.
          </p>
          <p className="font-['DM_Mono'] text-[0.95rem] md:text-[1.05rem] text-[#888] leading-relaxed">
            Our vision is to advance both software and aerospace technologies through focused, meaningful innovation. Readersonic is our flagship product.
          </p>

          <div className="flex gap-10 sm:gap-16 mt-16 flex-wrap">
            {[
              { val: '01', lab: 'Flagship Product' },
              { val: <span className="text-[4rem] leading-none">∞</span>, lab: 'Ambition' },
            ].map(stat => (
              <div key={stat.lab}>
                <div className="font-['Bebas_Neue'] text-[3.5rem] leading-none flex items-center h-[3.5rem]">{stat.val}</div>
                <div className="font-['DM_Mono'] text-[0.65rem] text-[#888] uppercase tracking-[3px] mt-1">{stat.lab}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="hidden lg:flex w-[40%] border border-[#1e1e1e] flex-col items-center justify-center p-12 bg-[#0f0f0f] relative overflow-hidden">
            <div className="font-['Bebas_Neue'] text-[#161616] text-[8rem] rotate-[-90deg] leading-none select-none">RASHIKIAN</div>
            <div className="absolute inset-0 border-[20px] border-[#0a0a0a]" />
        </div>
      </section>

      {/* CONTACT SECTION */}
      <section id="contact" className="py-24 px-[6%] bg-[#0d0d0d] border-b border-[#1e1e1e]">
        <span className="font-['DM_Mono'] text-[0.65rem] text-[#888] tracking-[3px] uppercase block mb-4">Contact</span>
        <h2 className="font-['Bebas_Neue'] text-[clamp(3.5rem,10vw,10rem)] leading-none mb-12 sm:mb-16">Get in touch</h2>
        <div className="max-w-[640px]">
           <ContactForm />
           <div className="mt-16 pt-8 border-t border-[#1e1e1e] font-['DM_Mono'] text-[0.75rem] text-[#444] uppercase tracking-[4px] flex flex-col sm:flex-row gap-4 sm:gap-8">
              <span className="text-[#888]">contact@rashikian.com</span>
              <a href="https://x.com/rashikian" target="_blank" rel="noopener noreferrer" className="text-[#888] hover:text-white transition-colors flex items-center gap-1">
                 𝕏 @rashikian
              </a>
           </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="py-12 px-[6%] flex border-t border-[#1e1e1e] items-center justify-between font-['DM_Mono'] text-[0.72rem] text-[#888]">
         <span>© RASHIKIAN</span>
         <div className="flex items-center gap-8">
            <a href="https://x.com/rashikian" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors text-[1rem]">𝕏</a>
            <button onClick={() => window.scrollTo({top:0, behavior: 'smooth'})} className="hover:text-white transition-colors text-xl">▲</button>
         </div>
         <span className="hidden md:inline">TECHNOLOGY · SCIENCE · AEROSPACE</span>
      </footer>

      <style>{`
        @keyframes ticker-scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-25%); }
        }
        .animate-ticker {
          animation: ticker-scroll 40s linear infinite;
        }
      `}</style>
    </div>
  );
}

const ReadersonicPhone = () => {
  const words = ["Read", "at", "the", "speed", "of", "your", "thought"];
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setIndex(i => (i + 1) % words.length), 500);
    return () => clearInterval(timer);
  }, [words.length]);

  const progress = ((index + 1) / words.length) * 100;

  return (
    <div className="w-[200px] sm:w-[240px] h-[400px] sm:h-[480px] border-[3px] border-[#333] rounded-[30px] sm:rounded-[40px] bg-[#111] p-3 sm:p-4 flex flex-col relative overflow-hidden ring-1 ring-white/5 shadow-2xl">
      <div className="w-12 sm:w-16 h-1 sm:h-1.5 bg-[#1e1e1e] rounded-full mx-auto mb-12 sm:mb-16" />
      <div className="flex-1 flex items-center justify-center">
        <div 
          className="font-['Bebas_Neue'] text-[1.8rem] sm:text-[2.2rem] text-white text-center leading-none uppercase tracking-tight px-4"
        >
          {words[index]}
        </div>
      </div>
      <div className="w-2/3 h-0.5 bg-[#1e1e1e] mx-auto mb-6 sm:mb-8 overflow-hidden rounded-full">
        <motion.div 
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.1, ease: "linear" }}
          className="h-full bg-white"
        />
      </div>
    </div>
  );
};

const ContactForm = () => {
  const [submitted, setSubmitted] = useState(false);

  if (submitted) {
    return (
      <div className="py-12">
        <div className="font-['Bebas_Neue'] text-[clamp(3rem,10vw,6rem)] leading-none animate-pulse mb-4">Message Sent.</div>
        <p className="font-['DM_Mono'] text-[#888] uppercase tracking-widest text-sm">We will be in touch shortly.</p>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); setSubmitted(true); }} className="flex flex-col gap-10 md:gap-12">
      <div className="flex flex-col border-b border-[#333] focus-within:border-white transition-colors group">
        <label className="font-['DM_Mono'] text-[0.6rem] text-[#555] group-focus-within:text-white tracking-[3px] mb-2 uppercase transition-colors">Name</label>
        <input required type="text" placeholder="Your Name" className="bg-transparent text-white font-['DM_Mono'] text-lg py-2 outline-none placeholder:text-[#333]" />
      </div>
      <div className="flex flex-col border-b border-[#333] focus-within:border-white transition-colors group">
        <label className="font-['DM_Mono'] text-[0.6rem] text-[#555] group-focus-within:text-white tracking-[3px] mb-2 uppercase transition-colors">Email</label>
        <input required type="email" placeholder="your@email.com" className="bg-transparent text-white font-['DM_Mono'] text-lg py-2 outline-none placeholder:text-[#333]" />
      </div>
      <div className="flex flex-col border-b border-[#333] focus-within:border-white transition-colors group">
        <label className="font-['DM_Mono'] text-[0.6rem] text-[#555] group-focus-within:text-white tracking-[3px] mb-2 uppercase transition-colors">Message</label>
        <textarea required rows={3} placeholder="How can we help?" className="bg-transparent text-white font-['DM_Mono'] text-lg py-2 outline-none placeholder:text-[#333] resize-none" />
      </div>
      <button type="submit" className="bg-white text-black py-4 px-12 font-['DM_Mono'] font-bold text-sm uppercase tracking-widest w-full sm:w-max active:scale-95 transition-all hover:bg-white/90">
        Submit
      </button>
    </form>
  );
};
